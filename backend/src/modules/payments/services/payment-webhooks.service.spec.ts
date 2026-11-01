import type { PaymentSummary } from '../../../common/contracts/payments';
import {
  MEMBER_ID,
  type PaymentsHarness,
  createPaymentsHarness,
} from '../../../../test/payments/support/payments-harness';
import { MOCK_SIGNATURE_HEADER } from './providers/mock-payment-provider';

async function createParkingPayment(
  h: PaymentsHarness,
  key = 'parking:session-1:16:00',
): Promise<PaymentSummary> {
  return h.payments.createPayment({
    userId: MEMBER_ID,
    purpose: 'parking',
    amountKopecks: 6000,
    idempotencyKey: key,
    description: 'Паркінг Порт City, 1 година',
    meta: { sessionId: 'session-1' },
  });
}

describe('PaymentWebhooksService strictness for real acquirers (finding 7)', () => {
  it('requires the amount and the currency in success notifications', async () => {
    const h = createPaymentsHarness({ strictWebhooks: true });
    const payment = await createParkingPayment(h);
    const ref = payment.providerRef ?? '';
    h.mock.settle(ref, 'succeeded');

    await expect(
      h.webhooks.handle('mock', h.mock.buildWebhook(ref, 'evt-a', { omit: ['amount_kopecks'] })),
    ).rejects.toMatchObject({ code: 'PC_PAYMENT_WEBHOOK_MALFORMED', status: 400 });
    await expect(
      h.webhooks.handle('mock', h.mock.buildWebhook(ref, 'evt-c', { omit: ['currency'] })),
    ).rejects.toMatchObject({
      code: 'PC_PAYMENT_WEBHOOK_MALFORMED',
      details: { reason: 'currency_missing' },
    });
    expect(h.prisma.logs).toHaveLength(0);
    expect(h.prisma.payments[0]?.status).toBe('created');

    await expect(
      h.webhooks.handle('mock', h.mock.buildWebhook(ref, 'evt-ok')),
    ).resolves.toMatchObject({ result: 'processed', status: 'succeeded' });
  });

  it('rejects timestamped notifications older than PAYMENTS_WEBHOOK_MAX_AGE_SECONDS', async () => {
    const h = createPaymentsHarness({
      strictWebhooks: true,
      config: { PAYMENTS_WEBHOOK_MAX_AGE_SECONDS: 600 },
    });
    const payment = await createParkingPayment(h);
    const ref = payment.providerRef ?? '';
    h.mock.settle(ref, 'succeeded');
    const old = new Date(h.clock.now().getTime() - 601_000);
    await expect(
      h.webhooks.handle('mock', h.mock.buildWebhook(ref, 'evt-old', { sentAt: old })),
    ).rejects.toMatchObject({ code: 'PC_PAYMENT_WEBHOOK_STALE', status: 400 });
    const fresh = new Date(h.clock.now().getTime() - 30_000);
    await expect(
      h.webhooks.handle('mock', h.mock.buildWebhook(ref, 'evt-new', { sentAt: fresh })),
    ).resolves.toMatchObject({ result: 'processed' });
  });

  it('keeps the development mock lenient', async () => {
    const h = createPaymentsHarness();
    const payment = await createParkingPayment(h);
    const ref = payment.providerRef ?? '';
    h.mock.settle(ref, 'succeeded');
    const old = new Date(h.clock.now().getTime() - 3_600_000);
    await expect(
      h.webhooks.handle(
        'mock',
        h.mock.buildWebhook(ref, 'evt-lenient', { sentAt: old, omit: ['amount_kopecks'] }),
      ),
    ).resolves.toMatchObject({ result: 'processed' });
  });
});

describe('PaymentWebhooksService (POST /webhooks/payments/:provider)', () => {
  it('verifies the signature, logs the callback and moves the payment to succeeded', async () => {
    const h = createPaymentsHarness();
    const payment = await createParkingPayment(h);
    const ref = payment.providerRef ?? '';
    h.mock.settle(ref, 'succeeded');
    const webhook = h.mock.buildWebhook(ref, 'evt-1');

    const ack = await h.webhooks.handle('mock', webhook);

    expect(ack).toEqual({
      received: true,
      result: 'processed',
      paymentId: payment.id,
      status: 'succeeded',
      detail: 'transitioned:created->succeeded',
    });
    expect(h.prisma.payments[0]).toMatchObject({
      status: 'succeeded',
      paidAt: new Date('2026-11-01T10:00:00.000Z'),
    });
    expect(h.prisma.logs).toEqual([
      expect.objectContaining({
        provider: 'mock',
        externalId: 'evt-1',
        paymentId: payment.id,
        processedAt: new Date('2026-11-01T10:00:00.000Z'),
        result: 'transitioned:created->succeeded',
      }),
    ]);
    expect(h.events.map((event) => event.type)).toEqual(['payment.created', 'payment.succeeded']);
    expect(h.events[1]?.payload).toMatchObject({
      paymentId: payment.id,
      userId: MEMBER_ID,
      purpose: 'parking',
      amountKopecks: 6000,
      meta: { sessionId: 'session-1' },
      paidAt: '2026-11-01T10:00:00.000Z',
    });
  });

  it('is idempotent by external id: a replay is a duplicate without side effects', async () => {
    const h = createPaymentsHarness();
    const payment = await createParkingPayment(h);
    h.mock.settle(payment.providerRef ?? '', 'succeeded');
    const webhook = h.mock.buildWebhook(payment.providerRef ?? '', 'evt-1');
    await h.webhooks.handle('mock', webhook);
    const eventsBefore = h.events.length;

    const replay = await h.webhooks.handle('mock', webhook);

    expect(replay).toMatchObject({ result: 'duplicate', paymentId: payment.id });
    expect(h.prisma.logs).toHaveLength(1);
    expect(h.events).toHaveLength(eventsBefore);
  });

  it('answers duplicate when a concurrent delivery inserted the log row first', async () => {
    const h = createPaymentsHarness();
    const payment = await createParkingPayment(h);
    h.mock.settle(payment.providerRef ?? '', 'succeeded');
    h.prisma.failNextLogCreate = true;

    const ack = await h.webhooks.handle(
      'mock',
      h.mock.buildWebhook(payment.providerRef ?? '', 'evt-9'),
    );

    expect(ack).toMatchObject({ result: 'duplicate', detail: 'concurrent duplicate' });
  });

  it('treats a new event id with the same status as a duplicate (no change)', async () => {
    const h = createPaymentsHarness();
    const payment = await createParkingPayment(h);
    h.mock.settle(payment.providerRef ?? '', 'succeeded');
    await h.webhooks.handle('mock', h.mock.buildWebhook(payment.providerRef ?? '', 'evt-1'));
    const again = await h.webhooks.handle(
      'mock',
      h.mock.buildWebhook(payment.providerRef ?? '', 'evt-2'),
    );
    expect(again).toMatchObject({ result: 'duplicate', detail: 'noop:already_in_status' });
    expect(h.prisma.logs).toHaveLength(2);
  });

  it('rejects a tampered body before touching the database', async () => {
    const h = createPaymentsHarness();
    const payment = await createParkingPayment(h);
    h.mock.settle(payment.providerRef ?? '', 'succeeded');
    const webhook = h.mock.buildWebhook(payment.providerRef ?? '', 'evt-1');
    const findLog = jest.spyOn(h.prisma.paymentWebhookLog, 'findUnique');

    await expect(
      h.webhooks.handle('mock', {
        headers: webhook.headers,
        body: { ...webhook.body, amount_kopecks: 1 },
      }),
    ).rejects.toMatchObject({ code: 'PC_PAYMENT_WEBHOOK_SIGNATURE', status: 401 });
    // Tampered bytes on the wire (the signature covers the raw body).
    await expect(
      h.webhooks.handle('mock', {
        headers: webhook.headers,
        body: { ...webhook.body, amount_kopecks: 1 },
        rawBody: webhook.rawBody.replace('"amount_kopecks":6000', '"amount_kopecks":1'),
      }),
    ).rejects.toMatchObject({ code: 'PC_PAYMENT_WEBHOOK_SIGNATURE', status: 401 });
    await expect(
      h.webhooks.handle('mock', { headers: {}, body: webhook.body }),
    ).rejects.toMatchObject({ code: 'PC_PAYMENT_WEBHOOK_SIGNATURE' });
    await expect(
      h.webhooks.handle('mock', {
        headers: { [MOCK_SIGNATURE_HEADER]: 'f'.repeat(64) },
        body: webhook.body,
      }),
    ).rejects.toMatchObject({ code: 'PC_PAYMENT_WEBHOOK_SIGNATURE' });

    expect(findLog).not.toHaveBeenCalled();
    expect(h.prisma.payments[0]?.status).toBe('created');
  });

  it('rejects a correctly signed but malformed body', async () => {
    const h = createPaymentsHarness();
    const body = { provider_ref: 'mock_x', status: 'succeeded' };
    await expect(
      h.webhooks.handle('mock', { headers: h.mock.sign(body), body }),
    ).rejects.toMatchObject({ code: 'PC_PAYMENT_WEBHOOK_MALFORMED', status: 400 });
  });

  it('answers 404 for an unknown provider and for an unknown payment', async () => {
    const h = createPaymentsHarness();
    await expect(h.webhooks.handle('liqpay', { headers: {}, body: {} })).rejects.toMatchObject({
      code: 'PC_PAYMENT_PROVIDER_UNKNOWN',
      status: 404,
    });
    const body = { event_id: 'evt-x', provider_ref: 'mock_unknown', status: 'succeeded' };
    await expect(
      h.webhooks.handle('mock', { headers: h.mock.sign(body), body }),
    ).rejects.toMatchObject({ code: 'PC_PAYMENT_NOT_FOUND', status: 404 });
    expect(h.prisma.logs).toHaveLength(0);
  });

  it('records a declined card as failed with the failure code', async () => {
    const h = createPaymentsHarness();
    const payment = await createParkingPayment(h);
    h.mock.settle(payment.providerRef ?? '', 'failed', 'insufficient_funds');

    const ack = await h.webhooks.handle(
      'mock',
      h.mock.buildWebhook(payment.providerRef ?? '', 'evt-f'),
    );

    expect(ack).toMatchObject({ result: 'processed', status: 'failed' });
    expect(h.prisma.payments[0]).toMatchObject({
      status: 'failed',
      failureCode: 'insufficient_funds',
    });
    expect(h.events.at(-1)).toMatchObject({
      type: 'payment.failed',
      payload: expect.objectContaining({ failureCode: 'insufficient_funds' }),
    });
  });

  it('ignores a conflicting late event and keeps it in the log', async () => {
    const h = createPaymentsHarness();
    const payment = await createParkingPayment(h);
    const ref = payment.providerRef ?? '';
    h.mock.settle(ref, 'succeeded');
    await h.webhooks.handle('mock', h.mock.buildWebhook(ref, 'evt-ok'));
    const late = {
      event_id: 'evt-late',
      provider_ref: ref,
      payment_id: payment.id,
      status: 'failed',
    };

    const ack = await h.webhooks.handle('mock', { headers: h.mock.sign(late), body: late });

    expect(ack).toMatchObject({
      result: 'ignored',
      status: 'succeeded',
      detail: 'ignored:conflict',
    });
    expect(h.prisma.logs.find((log) => log.externalId === 'evt-late')?.result).toBe(
      'ignored:conflict',
    );
  });

  it('enqueues fiscalisation after success when an adapter is configured', async () => {
    const h = createPaymentsHarness({ fiscalization: 'mock' });
    const payment = await createParkingPayment(h);
    h.mock.settle(payment.providerRef ?? '', 'succeeded');
    await h.webhooks.handle('mock', h.mock.buildWebhook(payment.providerRef ?? '', 'evt-1'));
    expect(h.queued).toEqual([
      { name: 'fiscalize', data: { paymentId: payment.id }, jobId: `fiscalize-${payment.id}` },
    ]);
  });
});
