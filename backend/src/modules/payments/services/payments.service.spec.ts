import type { CreatePaymentInput } from '../../../common/contracts/payments';
import { verifyOperatorQr } from '../domain/receipt';
import {
  MEMBER_ID,
  type PaymentsHarness,
  createPaymentsHarness,
} from '../../../../test/payments/support/payments-harness';

const INPUT: CreatePaymentInput = {
  userId: MEMBER_ID,
  purpose: 'parking',
  amountKopecks: 6000,
  idempotencyKey: 'parking:session-1:2026-11-01T11:00:00.000Z',
  description: 'Паркінг Порт City',
  meta: { sessionId: 'session-1' },
};

/** Lets every pending promise step run (the insert of a request that then hangs). */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function paidPayment(h: PaymentsHarness, amountKopecks = 6000) {
  const payment = await h.payments.createPayment({ ...INPUT, amountKopecks });
  h.mock.settle(payment.providerRef ?? '', 'succeeded');
  await h.webhooks.handle('mock', h.mock.buildWebhook(payment.providerRef ?? '', 'evt-paid'));
  return payment;
}

describe('PaymentsService (PAYMENTS_PORT)', () => {
  it('creates a payment with a mock checkout URL and publishes payment.created', async () => {
    const h = createPaymentsHarness();

    const payment = await h.payments.createPayment(INPUT);

    expect(payment).toMatchObject({
      userId: MEMBER_ID,
      purpose: 'parking',
      amountKopecks: 6000,
      currency: 'UAH',
      provider: 'mock',
      providerRef: `mock_${payment.id}`,
      status: 'created',
      checkoutUrl: `http://localhost:3000/api/v1/mock-checkout/mock_${payment.id}`,
      refundedKopecks: 0,
      meta: { sessionId: 'session-1' },
    });
    expect(h.events).toEqual([
      expect.objectContaining({
        type: 'payment.created',
        aggregateId: payment.id,
        payload: expect.objectContaining({ status: 'created', meta: { sessionId: 'session-1' } }),
      }),
    ]);
    const stored = h.prisma.payments[0];
    expect(stored?.meta).toMatchObject({
      sessionId: 'session-1',
      _internal: {
        description: 'Паркінг Порт City',
        checkoutExpiresAt: '2026-11-01T10:20:00.000Z',
      },
    });
  });

  it('returns the existing payment on a replay of the idempotency key', async () => {
    const h = createPaymentsHarness();
    const first = await h.payments.createPayment(INPUT);
    const replay = await h.payments.createPayment({ ...INPUT, amountKopecks: 9999 });
    expect(replay.id).toBe(first.id);
    expect(replay.amountKopecks).toBe(6000);
    expect(h.prisma.payments).toHaveLength(1);
    await expect(
      h.payments.getPaymentByIdempotencyKey(INPUT.idempotencyKey),
    ).resolves.toMatchObject({
      id: first.id,
    });
  });

  it.each([
    [{ amountKopecks: 0 }, 'PC_PAYMENT_AMOUNT_INVALID'],
    [{ amountKopecks: 10.5 }, 'PC_PAYMENT_AMOUNT_INVALID'],
    [{ description: '  ' }, 'PC_COMMON_VALIDATION'],
    [{ idempotencyKey: '' }, 'PC_COMMON_VALIDATION'],
  ])('rejects invalid input %j with %s', async (override, code) => {
    const h = createPaymentsHarness();
    await expect(h.payments.createPayment({ ...INPUT, ...override })).rejects.toMatchObject({
      code,
    });
    expect(h.prisma.payments).toHaveLength(0);
  });

  it('maps provider failures to PC_PAYMENT_PROVIDER_ERROR (502) and closes the attempt', async () => {
    const h = createPaymentsHarness();
    jest.spyOn(h.mock, 'createCheckout').mockRejectedValueOnce(new Error('timeout'));
    await expect(h.payments.createPayment(INPUT)).rejects.toMatchObject({
      code: 'PC_PAYMENT_PROVIDER_ERROR',
      status: 502,
    });
    expect(h.prisma.payments).toEqual([
      expect.objectContaining({
        status: 'cancelled',
        failureCode: 'checkout_create_failed',
        checkoutUrl: null,
      }),
    ]);
    // The member taps again: a fresh attempt opens normally.
    const retry = await h.payments.createPayment(INPUT);
    expect(retry).toMatchObject({ status: 'created', checkoutUrl: expect.any(String) });
    expect(h.prisma.payments.at(-1)?.idempotencyKey).toBe(`${INPUT.idempotencyKey}:a2`);
  });

  it('hides another member payment behind 404', async () => {
    const h = createPaymentsHarness();
    const payment = await h.payments.createPayment(INPUT);
    await expect(h.payments.getPaymentForUser(MEMBER_ID, payment.id)).resolves.toMatchObject({
      id: payment.id,
    });
    await expect(
      h.payments.getPaymentForUser('01900000-0000-7000-8000-00000000ffff', payment.id),
    ).rejects.toMatchObject({ code: 'PC_PAYMENT_NOT_FOUND', status: 404 });
  });

  it('hides the checkout URL once the payment is final', async () => {
    const h = createPaymentsHarness();
    const payment = await paidPayment(h);
    const summary = await h.payments.requirePayment(payment.id);
    expect(summary.status).toBe('succeeded');
    expect(summary.checkoutUrl).toBeNull();
  });
});

describe('PaymentsService review findings (reproduced first)', () => {
  it('finding 1: a failed attempt for the same key can be retried as a new attempt', async () => {
    const h = createPaymentsHarness();
    const first = await h.payments.createPayment(INPUT);
    h.mock.settle(first.providerRef ?? '', 'failed', 'card_declined');
    await h.webhooks.handle('mock', h.mock.buildWebhook(first.providerRef ?? '', 'evt-failed'));
    expect((await h.payments.requirePayment(first.id)).status).toBe('failed');

    const retry = await h.payments.createPayment(INPUT);

    expect(retry.id).not.toBe(first.id);
    expect(retry.status).toBe('created');
    expect(retry.checkoutUrl).toContain(`mock_${retry.id}`);
    expect(h.prisma.payments.map((row) => row.idempotencyKey)).toEqual([
      INPUT.idempotencyKey,
      `${INPUT.idempotencyKey}:a2`,
    ]);
    // A further tap reuses the open second attempt.
    const again = await h.payments.createPayment(INPUT);
    expect(again.id).toBe(retry.id);
  });

  it('finding 2: a success after the reconciliation expired the payment is applied as a late success', async () => {
    const h = createPaymentsHarness();
    const payment = await h.payments.createPayment(INPUT);
    const ref = payment.providerRef ?? '';
    h.clock.advanceMinutes(25);

    const reconciled = await h.payments.reconcilePayment(payment.id);
    expect(reconciled).toMatchObject({ action: 'expired', payment: { status: 'expired' } });
    // The checkout was cancelled at the provider before the local expiry.
    expect(h.mock.getCheckout(ref)?.status).toBe('cancelled');

    // The provider still captured the money (race at the provider).
    h.mock.settle(ref, 'succeeded');
    const ack = await h.webhooks.handle('mock', h.mock.buildWebhook(ref, 'evt-late'));

    expect(ack).toMatchObject({ result: 'processed', status: 'succeeded' });
    expect(h.events.at(-1)).toMatchObject({
      type: 'payment.succeeded',
      payload: expect.objectContaining({ paymentId: payment.id, late: true }),
    });
  });
});

describe('PaymentsService attempts and transactions (findings 1 and 3)', () => {
  it('commits the attempt before calling the provider and never inside a caller transaction', async () => {
    const h = createPaymentsHarness();
    const seen: Array<{ rows: number; checkout: string | null }> = [];
    const original = h.mock.createCheckout.bind(h.mock);
    jest.spyOn(h.mock, 'createCheckout').mockImplementation(async (input) => {
      // The row already exists (committed in its own transaction) while the provider runs.
      seen.push({
        rows: h.prisma.payments.length,
        checkout: h.prisma.payments[0]?.checkoutUrl ?? null,
      });
      return original(input);
    });
    const payment = await h.payments.createPayment(INPUT);
    expect(seen).toEqual([{ rows: 1, checkout: null }]);
    expect(payment.checkoutUrl).toContain(payment.id);
    expect(h.prisma.payments[0]?.meta).toMatchObject({
      _internal: { baseKey: INPUT.idempotencyKey, attempt: 1 },
    });
  });

  it('retries after cancelled and expired attempts but reuses a paid one', async () => {
    const h = createPaymentsHarness();
    const first = await h.payments.createPayment(INPUT);
    h.mock.settle(first.providerRef ?? '', 'cancelled');
    await h.webhooks.handle('mock', h.mock.buildWebhook(first.providerRef ?? '', 'evt-c1'));
    const second = await h.payments.createPayment(INPUT);
    expect(second.id).not.toBe(first.id);
    h.mock.settle(second.providerRef ?? '', 'succeeded');
    await h.webhooks.handle('mock', h.mock.buildWebhook(second.providerRef ?? '', 'evt-s2'));

    const third = await h.payments.createPayment(INPUT);
    expect(third).toMatchObject({ id: second.id, status: 'succeeded' });
    await expect(
      h.payments.getPaymentByIdempotencyKey(INPUT.idempotencyKey),
    ).resolves.toMatchObject({ id: second.id });
    expect(h.prisma.payments).toHaveLength(2);
  });

  it('settles an open attempt whose checkout expired before handing out a new one', async () => {
    const h = createPaymentsHarness();
    const first = await h.payments.createPayment(INPUT);
    h.clock.advanceMinutes(21);
    const second = await h.payments.createPayment(INPUT);
    expect(second.id).not.toBe(first.id);
    expect(await h.payments.requirePayment(first.id)).toMatchObject({ status: 'expired' });
    expect(h.mock.getCheckout(first.providerRef ?? '')?.status).toBe('cancelled');
  });

  it('closes an attempt stuck without a checkout and opens the next one', async () => {
    const h = createPaymentsHarness();
    jest.spyOn(h.mock, 'createCheckout').mockImplementationOnce(() => new Promise(() => {}));
    // The first request dies after its insert (the provider never answers).
    void h.payments.createPayment(INPUT);
    await flush();
    expect(h.prisma.payments).toHaveLength(1);
    h.clock.advanceMinutes(2);
    const next = await h.payments.createPayment(INPUT);
    expect(h.prisma.payments[0]).toMatchObject({
      status: 'cancelled',
      failureCode: 'checkout_not_created',
    });
    expect(next).toMatchObject({ status: 'created', checkoutUrl: expect.any(String) });
  });

  it('a loser of the insert race (P2002) returns the winner once its checkout is stored', async () => {
    const h = createPaymentsHarness();
    const winner = await h.payments.createPayment(INPUT);
    const stored = { ...h.prisma.payments[0]! };
    // Simulate the race: the loser's read happened before the winner's insert.
    const findUnique = jest.spyOn(h.prisma.payment, 'findUnique');
    findUnique.mockResolvedValueOnce(null);
    const loser = await h.payments.createPayment(INPUT);
    expect(loser.id).toBe(winner.id);
    expect(loser.checkoutUrl).toBe(stored.checkoutUrl);
    expect(h.prisma.payments).toHaveLength(1);
  });

  it('waits briefly for a concurrent request to store the checkout of the same attempt', async () => {
    const h = createPaymentsHarness();
    await h.payments.createPayment(INPUT);
    const row = h.prisma.payments[0]!;
    const url = row.checkoutUrl;
    row.checkoutUrl = null;
    const findUnique = jest.spyOn(h.prisma.payment, 'findUnique');
    findUnique.mockImplementation(async (args) => {
      if (h.payments.sleeps >= 2) {
        row.checkoutUrl = url;
      }
      const found = h.prisma.payments.find(
        (entry) =>
          (args.where.id !== undefined && entry.id === args.where.id) ||
          (args.where.idempotencyKey !== undefined &&
            entry.idempotencyKey === args.where.idempotencyKey),
      );
      return found ? { ...found } : null;
    });
    const again = await h.payments.createPayment(INPUT);
    expect(again.checkoutUrl).toBe(url);
    expect(h.payments.sleeps).toBe(2);
  });

  it('returns several payments by id', async () => {
    const h = createPaymentsHarness();
    const a = await h.payments.createPayment(INPUT);
    const b = await h.payments.createPayment({ ...INPUT, idempotencyKey: 'other-key' });
    const found = await h.payments.getPayments([
      a.id,
      b.id,
      a.id,
      '01900000-0000-7000-8000-00000000dead',
    ]);
    expect(found.map((payment) => payment.id).sort()).toEqual([a.id, b.id].sort());
    await expect(h.payments.getPayments([])).resolves.toEqual([]);
  });
});

describe('PaymentsService late success and reconciliation (finding 2)', () => {
  it('publishes payment.succeeded with late: true and records where it came from', async () => {
    const h = createPaymentsHarness();
    const payment = await h.payments.createPayment(INPUT);
    h.mock.settle(payment.providerRef ?? '', 'failed', 'card_declined');
    await h.webhooks.handle('mock', h.mock.buildWebhook(payment.providerRef ?? '', 'evt-f'));
    h.mock.settle(payment.providerRef ?? '', 'succeeded');
    const ack = await h.webhooks.handle(
      'mock',
      h.mock.buildWebhook(payment.providerRef ?? '', 'evt-s'),
    );
    expect(ack).toMatchObject({
      result: 'processed',
      detail: 'transitioned:failed->succeeded:late',
    });
    const row = h.prisma.payments[0]!;
    expect(row).toMatchObject({ status: 'succeeded', failureCode: null });
    expect(row.meta).toMatchObject({ _internal: { lateSuccess: { from: 'failed' } } });
    expect(h.events.at(-1)?.payload).toMatchObject({ late: true, status: 'succeeded' });
  });

  it('a normal success carries no late flag', async () => {
    const h = createPaymentsHarness();
    await paidPayment(h);
    expect(h.events.at(-1)?.type).toBe('payment.succeeded');
    expect(h.events.at(-1)?.payload).not.toHaveProperty('late');
  });

  it('applies the provider answer when the customer paid while the checkout was being cancelled', async () => {
    const h = createPaymentsHarness();
    const payment = await h.payments.createPayment(INPUT);
    h.clock.advanceMinutes(25);
    jest.spyOn(h.mock, 'getStatus').mockResolvedValueOnce({
      externalId: 'status-pending',
      providerRef: payment.providerRef ?? '',
      kind: 'pending',
      raw: {},
    });
    h.mock.settle(payment.providerRef ?? '', 'succeeded');
    const outcome = await h.payments.reconcilePayment(payment.id);
    expect(outcome).toMatchObject({ action: 'applied', payment: { status: 'succeeded' } });
  });

  it('does not expire locally while the provider cannot confirm the cancellation', async () => {
    const h = createPaymentsHarness();
    const payment = await h.payments.createPayment(INPUT);
    h.clock.advanceMinutes(25);
    jest.spyOn(h.mock, 'cancelCheckout').mockRejectedValueOnce(new Error('provider down'));
    const outcome = await h.payments.reconcilePayment(payment.id);
    expect(outcome).toMatchObject({
      action: 'skipped',
      reason: 'provider_unavailable',
      payment: { status: 'created' },
    });
  });

  it('expires an attempt that never got a checkout without asking the provider', async () => {
    const h = createPaymentsHarness();
    jest.spyOn(h.mock, 'createCheckout').mockImplementationOnce(() => new Promise(() => {}));
    void h.payments.createPayment(INPUT);
    await flush();
    const id = h.prisma.payments[0]!.id;
    h.clock.advanceMinutes(25);
    const cancel = jest.spyOn(h.mock, 'cancelCheckout');
    await expect(h.payments.reconcilePayment(id)).resolves.toMatchObject({
      action: 'expired',
      payment: { status: 'expired', failureCode: 'checkout_not_created' },
    });
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('PaymentsService receipt fields (finding 13)', () => {
  it('builds the display number, merchant, parking facts and a verifiable operator QR', async () => {
    const h = createPaymentsHarness({
      config: { PAYMENTS_RECEIPT_QR_SECRET: 'receipt-secret-for-tests' },
    });
    const payment = await h.payments.createPayment({
      ...INPUT,
      meta: {
        sessionId: 'session-1',
        paidUntil: '2026-11-01T11:00:00.000Z',
        plate: 'AC1234BC',
        plateDisplay: 'AC 1234 BC',
      },
    });
    const open = h.payments.receiptOf(await h.payments.requirePayment(payment.id));
    expect(open).toMatchObject({
      displayNumber: expect.stringMatching(/^[2-9A-HJ-NP-Z]{4}-\d{4}$/),
      merchantName: h.config.PAYMENTS_PARKING_MERCHANT_NAME,
      parking: {
        plateDisplay: 'AC 1234 BC',
        paidUntil: new Date('2026-11-01T11:00:00.000Z'),
        sessionId: 'session-1',
      },
      operatorQrPayload: null,
    });

    h.mock.settle(payment.providerRef ?? '', 'succeeded');
    await h.webhooks.handle('mock', h.mock.buildWebhook(payment.providerRef ?? '', 'evt-p'));
    const paid = h.payments.receiptOf(await h.payments.requirePayment(payment.id));
    expect(paid.displayNumber).toBe(open.displayNumber);
    expect(verifyOperatorQr('receipt-secret-for-tests', paid.operatorQrPayload ?? '')).toEqual({
      paymentId: payment.id,
      sessionId: 'session-1',
      paidUntil: new Date('2026-11-01T11:00:00.000Z'),
      amountKopecks: 6000,
    });
    expect(verifyOperatorQr('another-secret-value', paid.operatorQrPayload ?? '')).toBeNull();

    const other = await h.payments.createPayment({
      ...INPUT,
      purpose: 'other',
      idempotencyKey: 'other-1',
      meta: {},
    });
    expect(h.payments.receiptOf(other)).toMatchObject({
      merchantName: h.config.PAYMENTS_MERCHANT_NAME,
      parking: null,
      operatorQrPayload: null,
    });
  });
});

describe('PaymentsService refund reservation and automatic refunds (findings 2 and 6)', () => {
  const admin = { type: 'admin' as const, id: 'admin-1' };

  it('reserves the refund under the row lock before calling the provider', async () => {
    const h = createPaymentsHarness();
    const payment = await paidPayment(h);
    const original = h.mock.refund.bind(h.mock);
    let reservedDuringCall: unknown = null;
    jest.spyOn(h.mock, 'refund').mockImplementation(async (ref, kopecks, reason, key) => {
      reservedDuringCall = (h.prisma.payments[0]?.meta as { _internal?: unknown })._internal;
      return original(ref, kopecks, reason, key);
    });
    await h.payments.refund(payment.id, { amountKopecks: 1000, reason: 'r', actor: admin });
    expect(reservedDuringCall).toMatchObject({
      pendingRefund: { state: 'reserved', kopecks: 1000, requestId: expect.any(String) },
    });
    expect(h.prisma.payments[0]?.meta).toMatchObject({ _internal: { pendingRefund: null } });
  });

  it('refuses a second refund while one is unfinished and resumes a failed one with the same key', async () => {
    const h = createPaymentsHarness();
    const payment = await paidPayment(h);
    const refund = jest.spyOn(h.mock, 'refund');
    refund.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(
      h.payments.refund(payment.id, { amountKopecks: 2000, reason: 'r', actor: admin }),
    ).rejects.toMatchObject({ code: 'PC_PAYMENT_PROVIDER_ERROR' });
    expect(h.prisma.payments[0]?.meta).toMatchObject({
      _internal: { pendingRefund: { state: 'failed', kopecks: 2000 } },
    });
    const firstKey = refund.mock.calls[0]?.[3];

    await expect(
      h.payments.refund(payment.id, { amountKopecks: 3000, reason: 'other', actor: admin }),
    ).rejects.toMatchObject({ code: 'PC_PAYMENT_REFUND_IN_PROGRESS', status: 409 });

    const resumed = await h.payments.refund(payment.id, { reason: 'retry', actor: admin });
    expect(resumed).toMatchObject({ status: 'partially_refunded', refundedKopecks: 2000 });
    expect(refund.mock.calls.at(-1)?.[3]).toBe(firstKey);
  });

  it('a definitive provider rejection releases the reservation', async () => {
    const h = createPaymentsHarness();
    const payment = await paidPayment(h);
    h.mock.forget(payment.providerRef ?? '');
    await expect(
      h.payments.refund(payment.id, { reason: 'r', actor: admin }),
    ).rejects.toMatchObject({ code: 'PC_PAYMENT_PROVIDER_ERROR' });
    expect(h.prisma.payments[0]?.meta).toMatchObject({ _internal: { pendingRefund: null } });
  });

  it('queues an automatic refund once and performs it in the job', async () => {
    const h = createPaymentsHarness();
    const payment = await paidPayment(h);
    const request = { paymentId: payment.id, reason: 'session_closed', source: 'parking' };
    await expect(h.payments.requestRefund(request)).resolves.toEqual({
      paymentId: payment.id,
      outcome: 'queued',
      status: 'succeeded',
    });
    await expect(h.payments.requestRefund(request)).resolves.toMatchObject({
      outcome: 'already_queued',
    });
    expect(h.queued.filter((job) => job.name === 'auto-refund')).toEqual([
      expect.objectContaining({ jobId: `auto-refund-${payment.id}`, attempts: 12 }),
      expect.objectContaining({ jobId: `auto-refund-${payment.id}` }),
    ]);
    expect(h.audits.at(-1)?.entry).toMatchObject({
      action: 'payment.auto_refund_requested',
      actor: { type: 'system', id: 'auto-refund:parking' },
    });

    await expect(h.payments.runAutoRefund(payment.id)).resolves.toEqual({
      kind: 'refunded',
      paymentId: payment.id,
      status: 'refunded',
    });
    const row = h.prisma.payments[0]!;
    expect(row).toMatchObject({ status: 'refunded', refundedKopecks: 6000 });
    expect(row.meta).toMatchObject({
      _internal: {
        autoRefund: { state: 'done' },
        refunds: [expect.objectContaining({ source: 'system', kopecks: 6000 })],
      },
    });
    // A repeated job (BullMQ retry) does nothing more.
    await expect(h.payments.runAutoRefund(payment.id)).resolves.toMatchObject({
      kind: 'skipped',
      reason: 'state_done',
    });
    await expect(h.payments.requestRefund(request)).resolves.toMatchObject({
      outcome: 'already_queued',
      status: 'refunded',
    });
  });

  it('does not queue a refund for a payment without captured money', async () => {
    const h = createPaymentsHarness();
    const open = await h.payments.createPayment(INPUT);
    await expect(
      h.payments.requestRefund({ paymentId: open.id, reason: 'x', source: 'parking' }),
    ).resolves.toMatchObject({ outcome: 'not_refundable', status: 'created' });
    expect(h.queued).toHaveLength(0);
    await expect(
      h.payments.requestRefund({
        paymentId: open.id,
        reason: 'x',
        source: 'parking',
        amountKopecks: 0,
      }),
    ).rejects.toMatchObject({ code: 'PC_PAYMENT_AMOUNT_INVALID' });
  });

  it('merges the fiscalisation failure into the meta under the lock (keeps a reserved refund)', async () => {
    const h = createPaymentsHarness({ fiscalization: 'mock' });
    const payment = await paidPayment(h);
    jest.spyOn(h.fiscalization, 'fiscalize').mockImplementationOnce(async () => {
      // A refund is reserved while the fiscal adapter is busy.
      const row = h.prisma.payments[0]!;
      row.meta = {
        ...(row.meta as Record<string, unknown>),
        _internal: {
          ...((row.meta as { _internal: Record<string, unknown> })._internal ?? {}),
          pendingRefund: { requestId: 'r-1', state: 'reserved', kopecks: 100 },
        },
      };
      throw new Error('PRRO offline');
    });
    await expect(h.payments.fiscalize(payment.id)).rejects.toMatchObject({
      code: 'PC_PAYMENT_PROVIDER_ERROR',
    });
    expect(h.prisma.rawQueries.some((query) => query.includes('FOR UPDATE'))).toBe(true);
    expect(h.prisma.payments[0]?.meta).toMatchObject({
      _internal: {
        pendingRefund: { requestId: 'r-1' },
        fiscalization: { state: 'failed', reason: 'PRRO offline' },
      },
    });
  });
});

describe('PaymentsService refunds', () => {
  it('refunds part of a captured payment through the provider and audits it in the transaction', async () => {
    const h = createPaymentsHarness();
    const payment = await paidPayment(h);

    const refunded = await h.payments.refund(payment.id, {
      amountKopecks: 2000,
      reason: 'Збій шлагбаума',
      actor: { type: 'admin', id: 'admin-1' },
      ip: '10.0.0.1',
    });

    expect(refunded).toMatchObject({ status: 'partially_refunded', refundedKopecks: 2000 });
    expect(h.mock.getCheckout(payment.providerRef ?? '')?.refundedKopecks).toBe(2000);
    expect(h.events.at(-1)).toMatchObject({
      type: 'payment.refunded',
      payload: expect.objectContaining({ refundedKopecks: 2000, partial: true }),
    });
    expect(h.audits).toEqual([
      {
        entry: expect.objectContaining({
          action: 'payment.refund',
          entityType: 'payment',
          entityId: payment.id,
          reason: 'Збій шлагбаума',
          ip: '10.0.0.1',
        }),
        tx: h.prisma,
      },
    ]);

    const rest = await h.payments.refund(payment.id, {
      reason: 'Повне повернення',
      actor: { type: 'admin', id: 'admin-1' },
    });
    expect(rest).toMatchObject({ status: 'refunded', refundedKopecks: 6000 });
  });

  it('refuses refunds of uncaptured payments and amounts above the remainder', async () => {
    const h = createPaymentsHarness();
    const open = await h.payments.createPayment(INPUT);
    await expect(
      h.payments.refund(open.id, { reason: 'x', actor: { type: 'admin', id: 'a' } }),
    ).rejects.toMatchObject({ code: 'PC_PAYMENT_REFUND_NOT_ALLOWED', status: 422 });

    const h2 = createPaymentsHarness();
    const paid = await paidPayment(h2);
    await expect(
      h2.payments.refund(paid.id, {
        amountKopecks: 7000,
        reason: 'x',
        actor: { type: 'admin', id: 'a' },
      }),
    ).rejects.toMatchObject({ code: 'PC_PAYMENT_AMOUNT_INVALID' });
  });
});

describe('PaymentsService reconciliation and fiscalisation', () => {
  it('skips young payments and expires stale ones the provider no longer knows', async () => {
    const h = createPaymentsHarness();
    const payment = await h.payments.createPayment(INPUT);

    await expect(h.payments.reconcilePayment(payment.id)).resolves.toMatchObject({
      action: 'skipped',
      reason: 'too_young',
    });

    h.clock.advanceMinutes(25);
    h.mock.forget(payment.providerRef ?? '');
    const stale = await h.payments.findStaleOpenPayments(new Date('2026-11-01T10:05:00.000Z'), 10);
    expect(stale).toEqual([payment.id]);

    const outcome = await h.payments.reconcilePayment(payment.id);
    expect(outcome).toMatchObject({ action: 'expired', payment: { status: 'expired' } });
    expect(h.events.at(-1)?.type).toBe('payment.expired');
  });

  it('applies a terminal provider answer found during reconciliation and audits admin runs', async () => {
    const h = createPaymentsHarness();
    const payment = await h.payments.createPayment(INPUT);
    h.mock.settle(payment.providerRef ?? '', 'succeeded');

    const outcome = await h.payments.reconcilePayment(payment.id, {
      force: true,
      actor: { type: 'admin', id: 'support-1' },
      ip: '10.0.0.3',
    });

    expect(outcome).toMatchObject({ action: 'applied', payment: { status: 'succeeded' } });
    expect(h.audits.at(-1)?.entry).toMatchObject({
      action: 'payment.reconcile',
      before: { status: 'created' },
      after: expect.objectContaining({ status: 'succeeded', action: 'applied' }),
    });
  });

  it('fiscalizes a succeeded payment with the mock adapter', async () => {
    const h = createPaymentsHarness({ fiscalization: 'mock' });
    const payment = await paidPayment(h);

    const result = await h.payments.fiscalize(payment.id);

    expect(result).toEqual({
      kind: 'fiscalized',
      paymentId: payment.id,
      fiscalReceiptUrl: `http://localhost:3000/mock-fiscal/${payment.id}`,
    });
    expect(h.prisma.payments[0]?.status).toBe('fiscalized');
    expect(h.events.at(-1)?.type).toBe('payment.fiscalized');
    await expect(h.payments.fiscalize(payment.id)).resolves.toMatchObject({
      kind: 'skipped',
      reason: 'status_fiscalized',
    });
  });

  it('skips fiscalisation when it is disabled', async () => {
    const h = createPaymentsHarness();
    const payment = await paidPayment(h);
    await expect(h.payments.fiscalize(payment.id)).resolves.toEqual({
      kind: 'skipped',
      paymentId: payment.id,
      reason: 'disabled',
    });
    expect(h.queued).toHaveLength(0);
  });
});
