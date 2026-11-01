import { FakeClock } from '../../../../common/time/clock';
import {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
  type MockWebhookBody,
  parseMockWebhookBody,
  signMockWebhookBody,
} from './mock-payment-provider';

const SECRET = 'test-only-mock-secret';

function createProvider(clock = new FakeClock('2026-01-15T10:00:00Z')): MockPaymentProvider {
  return new MockPaymentProvider({
    secret: SECRET,
    checkoutBaseUrl: 'http://localhost:3000/mock-checkout/',
    now: () => clock.now(),
    checkoutTtlMinutes: 20,
  });
}

const checkoutInput = {
  paymentId: '0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11',
  userId: 'user-1',
  amountKopecks: 6000,
  currency: 'UAH' as const,
  description: 'Parking',
  returnUrl: null,
  meta: { sessionId: 's-1' },
};

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('MockPaymentProvider', () => {
  it('creates a checkout with a deterministic reference and a hosted url', async () => {
    const provider = createProvider();
    const session = await provider.createCheckout(checkoutInput);
    expect(session).toEqual({
      providerRef: 'mock_0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11',
      checkoutUrl: 'http://localhost:3000/mock-checkout/mock_0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11',
      expiresAt: new Date('2026-01-15T10:20:00Z'),
    });
    expect(provider.getCheckout(session.providerRef)).toMatchObject({
      paymentId: checkoutInput.paymentId,
      status: 'pending',
      amountKopecks: 6000,
    });
  });

  it('reports status for known checkouts and null for unknown ones', async () => {
    const provider = createProvider();
    const { providerRef } = await provider.createCheckout(checkoutInput);
    await expect(provider.getStatus(providerRef)).resolves.toMatchObject({
      kind: 'pending',
      providerRef,
      paymentId: checkoutInput.paymentId,
      amountKopecks: 6000,
      currency: 'UAH',
    });
    provider.settle(providerRef, 'succeeded');
    await expect(provider.getStatus(providerRef)).resolves.toMatchObject({
      kind: 'succeeded',
      paidAt: new Date('2026-01-15T10:00:00Z'),
    });
    await expect(provider.getStatus('mock_unknown')).resolves.toBeNull();
    expect(provider.forget(providerRef)).toBe(true);
    await expect(provider.getStatus(providerRef)).resolves.toBeNull();
  });

  it('refunds captured checkouts and tracks the cumulative amount', async () => {
    const provider = createProvider();
    const { providerRef } = await provider.createCheckout(checkoutInput);
    await expect(provider.refund(providerRef, 1000, 'x', 'r-0')).rejects.toMatchObject({
      code: 'PC_PAYMENT_PROVIDER_ERROR',
    });
    provider.settle(providerRef, 'succeeded');
    await expect(provider.refund(providerRef, 2000, 'partial', 'r-1')).resolves.toEqual({
      refundRef: `${providerRef}_refund_1`,
      status: 'succeeded',
    });
    expect(provider.getCheckout(providerRef)).toMatchObject({
      refundedKopecks: 2000,
      status: 'succeeded',
    });
    // The same request repeated (a retry after a timeout) refunds nothing more.
    await expect(provider.refund(providerRef, 2000, 'partial', 'r-1')).resolves.toEqual({
      refundRef: `${providerRef}_refund_1`,
      status: 'succeeded',
    });
    expect(provider.getCheckout(providerRef)?.refundedKopecks).toBe(2000);
    await expect(provider.refund(providerRef, 5000, 'too much', 'r-2')).rejects.toMatchObject({
      code: 'PC_PAYMENT_PROVIDER_ERROR',
    });
    await expect(provider.refund(providerRef, 4000, 'rest', 'r-3')).resolves.toMatchObject({
      refundRef: `${providerRef}_refund_2`,
    });
    expect(provider.getCheckout(providerRef)).toMatchObject({
      refundedKopecks: 6000,
      status: 'refunded',
    });
    await expect(provider.refund('mock_missing', 1, 'x', 'r-4')).rejects.toMatchObject({
      code: 'PC_PAYMENT_PROVIDER_ERROR',
    });
  });

  it('cancels open checkouts and reports terminal ones instead', async () => {
    const provider = createProvider();
    const open = await provider.createCheckout(checkoutInput);
    await expect(provider.cancelCheckout(open.providerRef)).resolves.toEqual({
      kind: 'cancelled',
    });
    expect(provider.getCheckout(open.providerRef)?.status).toBe('cancelled');

    const paid = await provider.createCheckout({ ...checkoutInput, paymentId: 'pay-2' });
    provider.settle(paid.providerRef, 'succeeded');
    await expect(provider.cancelCheckout(paid.providerRef)).resolves.toMatchObject({
      kind: 'final',
      event: { kind: 'succeeded', amountKopecks: 6000, currency: 'UAH' },
    });
    await expect(provider.cancelCheckout('mock_unknown')).resolves.toEqual({ kind: 'not_found' });
    expect(provider.strictWebhooks).toBe(false);
  });

  describe('parseWebhook', () => {
    const body: MockWebhookBody = {
      event_id: 'evt-1',
      provider_ref: 'mock_pay-1',
      status: 'succeeded',
      payment_id: '0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11',
      amount_kopecks: 6000,
      currency: 'UAH',
      paid_at: '2026-01-15T10:05:00.000Z',
    };

    it('accepts a correctly signed body regardless of key order', () => {
      const provider = createProvider();
      const reordered = {
        paid_at: body.paid_at,
        status: body.status,
        event_id: body.event_id,
        provider_ref: body.provider_ref,
        payment_id: body.payment_id,
        amount_kopecks: body.amount_kopecks,
        currency: body.currency,
      };
      const headers = { [MOCK_SIGNATURE_HEADER]: signMockWebhookBody(SECRET, body) };
      expect(provider.parseWebhook({ headers, body: reordered })).toEqual({
        externalId: 'evt-1',
        providerRef: 'mock_pay-1',
        paymentId: body.payment_id,
        kind: 'succeeded',
        amountKopecks: 6000,
        currency: 'UAH',
        paidAt: new Date('2026-01-15T10:05:00.000Z'),
        failureCode: null,
        refundedKopecks: null,
        occurredAt: null,
        raw: reordered,
      });
    });

    it('accepts the header in any letter case', () => {
      const provider = createProvider();
      const headers = { 'X-Mock-Signature': signMockWebhookBody(SECRET, body).toUpperCase() };
      expect(provider.parseWebhook({ headers, body }).kind).toBe('succeeded');
    });

    it('with a raw body the signature covers the exact bytes received', () => {
      const provider = createProvider();
      const wire = JSON.stringify(body, null, 2);
      const rawBody = Buffer.from(wire, 'utf8');
      expect(
        provider.parseWebhook({
          headers: { [MOCK_SIGNATURE_HEADER]: signMockWebhookBody(SECRET, wire) },
          body,
          rawBody,
        }).kind,
      ).toBe('succeeded');
      // The canonical-JSON signature does not match once the raw bytes are known.
      expect(
        thrownBy(() =>
          provider.parseWebhook({
            headers: { [MOCK_SIGNATURE_HEADER]: signMockWebhookBody(SECRET, body) },
            body,
            rawBody,
          }),
        ),
      ).toMatchObject({ code: 'PC_PAYMENT_WEBHOOK_SIGNATURE', status: 401 });
    });

    it.each([
      ['missing header', {}],
      ['empty header', { [MOCK_SIGNATURE_HEADER]: '' }],
      ['not hex', { [MOCK_SIGNATURE_HEADER]: 'zz'.repeat(32) }],
      ['wrong secret', { [MOCK_SIGNATURE_HEADER]: signMockWebhookBody('other-secret', body) }],
      [
        'tampered body',
        { [MOCK_SIGNATURE_HEADER]: signMockWebhookBody(SECRET, { ...body, amount_kopecks: 1 }) },
      ],
    ])('rejects %s with PC_PAYMENT_WEBHOOK_SIGNATURE', (_name, headers) => {
      const provider = createProvider();
      expect(thrownBy(() => provider.parseWebhook({ headers, body }))).toMatchObject({
        code: 'PC_PAYMENT_WEBHOOK_SIGNATURE',
        status: 401,
      });
    });

    it.each([
      ['not an object', 'text'],
      ['array', [1, 2]],
      ['missing event_id', { provider_ref: 'r', status: 'succeeded' }],
      ['missing provider_ref', { event_id: 'e', status: 'succeeded' }],
      ['unknown status', { event_id: 'e', provider_ref: 'r', status: 'paid' }],
      [
        'negative amount',
        { event_id: 'e', provider_ref: 'r', status: 'succeeded', amount_kopecks: -1 },
      ],
      [
        'fractional amount',
        { event_id: 'e', provider_ref: 'r', status: 'succeeded', amount_kopecks: 1.5 },
      ],
      [
        'string amount',
        { event_id: 'e', provider_ref: 'r', status: 'succeeded', amount_kopecks: '60' },
      ],
      [
        'bad paid_at',
        { event_id: 'e', provider_ref: 'r', status: 'succeeded', paid_at: 'yesterday' },
      ],
      [
        'empty failure_code',
        { event_id: 'e', provider_ref: 'r', status: 'failed', failure_code: '' },
      ],
      ['too long event_id', { event_id: 'e'.repeat(201), provider_ref: 'r', status: 'failed' }],
    ])('rejects malformed body (%s) with PC_PAYMENT_WEBHOOK_MALFORMED', (_name, malformed) => {
      const provider = createProvider();
      const headers = provider.sign(malformed);
      expect(thrownBy(() => provider.parseWebhook({ headers, body: malformed }))).toMatchObject({
        code: 'PC_PAYMENT_WEBHOOK_MALFORMED',
        status: 400,
      });
    });

    it('maps optional fields to null when absent', () => {
      expect(parseMockWebhookBody({ event_id: 'e', provider_ref: 'r', status: 'failed' })).toEqual({
        externalId: 'e',
        providerRef: 'r',
        paymentId: null,
        kind: 'failed',
        amountKopecks: null,
        currency: null,
        paidAt: null,
        failureCode: null,
        refundedKopecks: null,
        occurredAt: null,
        raw: { event_id: 'e', provider_ref: 'r', status: 'failed' },
      });
    });

    it('reads the optional send time and rejects a broken one', () => {
      const base = { event_id: 'e', provider_ref: 'r', status: 'pending' };
      expect(parseMockWebhookBody({ ...base, sent_at: '2026-01-15T10:00:00Z' })).toMatchObject({
        occurredAt: new Date('2026-01-15T10:00:00Z'),
      });
      let caught: unknown = null;
      try {
        parseMockWebhookBody({ ...base, sent_at: 'yesterday' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: 'PC_PAYMENT_WEBHOOK_MALFORMED' });
    });
  });

  it('buildWebhook produces a payload that parseWebhook accepts', async () => {
    const provider = createProvider();
    const { providerRef } = await provider.createCheckout(checkoutInput);
    provider.settle(providerRef, 'failed', 'insufficient_funds');
    const { headers, body, rawBody } = provider.buildWebhook(providerRef, 'evt-9');
    expect(body).toMatchObject({
      event_id: 'evt-9',
      provider_ref: providerRef,
      status: 'failed',
      failure_code: 'insufficient_funds',
      amount_kopecks: 6000,
    });
    expect(JSON.parse(rawBody)).toEqual(body);
    expect(provider.parseWebhook({ headers, body, rawBody })).toMatchObject({
      externalId: 'evt-9',
      kind: 'failed',
      failureCode: 'insufficient_funds',
    });
    expect(() => provider.buildWebhook('mock_none', 'x')).toThrow('does not exist');
    expect(() => provider.settle('mock_none', 'succeeded')).toThrow('does not exist');
  });
});
