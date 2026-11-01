import {
  MEMBER_ID,
  type PaymentsHarness,
  createPaymentsHarness,
} from '../../../../test/payments/support/payments-harness';
import { mockCheckoutEventId } from './mock-checkout.service';

async function openCheckout(h: PaymentsHarness, description = 'Паркінг Порт City') {
  return h.payments.createPayment({
    userId: MEMBER_ID,
    purpose: 'parking',
    amountKopecks: 6000,
    idempotencyKey: `key-${description}`,
    description,
    returnUrl: 'portcity://parking/paid',
  });
}

describe('MockCheckoutService (dev checkout page of the mock provider)', () => {
  it('completes the checkout through a signed webhook and moves the payment to succeeded', async () => {
    const h = createPaymentsHarness();
    const payment = await openCheckout(h);
    const ref = payment.providerRef ?? '';

    const result = await h.checkout.complete(ref, 'succeeded');

    expect(result).toEqual({
      providerRef: ref,
      paymentId: payment.id,
      outcome: 'succeeded',
      webhook: {
        received: true,
        result: 'processed',
        paymentId: payment.id,
        status: 'succeeded',
        detail: 'transitioned:created->succeeded',
      },
      returnUrl: 'portcity://parking/paid',
    });
    expect(h.prisma.logs[0]?.externalId).toBe(mockCheckoutEventId(ref, 'succeeded'));
    expect(h.events.map((event) => event.type)).toContain('payment.succeeded');
  });

  it('treats a repeated click as a duplicate webhook and refuses a different outcome', async () => {
    const h = createPaymentsHarness();
    const payment = await openCheckout(h);
    const ref = payment.providerRef ?? '';
    await h.checkout.complete(ref, 'succeeded');

    const again = await h.checkout.complete(ref, 'succeeded');
    expect(again.webhook.result).toBe('duplicate');

    await expect(h.checkout.complete(ref, 'cancelled')).rejects.toMatchObject({
      code: 'PC_PAYMENT_INVALID_TRANSITION',
      status: 409,
    });
  });

  it('declines with a failure code', async () => {
    const h = createPaymentsHarness();
    const payment = await openCheckout(h);
    const result = await h.checkout.complete(payment.providerRef ?? '', 'failed', 'card_declined');
    expect(result.webhook.status).toBe('failed');
    expect(h.prisma.payments[0]?.failureCode).toBe('card_declined');
  });

  it('falls back to the configured return URL', async () => {
    const h = createPaymentsHarness();
    const payment = await h.payments.createPayment({
      userId: MEMBER_ID,
      purpose: 'other',
      amountKopecks: 100,
      idempotencyKey: 'no-return-url',
      description: 'Тест',
    });
    const result = await h.checkout.complete(payment.providerRef ?? '', 'cancelled');
    expect(result.returnUrl).toBe('portcity://payments/return');
    expect(result.webhook.status).toBe('cancelled');
  });

  it('renders an escaped HTML page with one form per outcome while the checkout is open', async () => {
    const h = createPaymentsHarness();
    const payment = await openCheckout(h, '<script>alert(1)</script>');
    const ref = payment.providerRef ?? '';

    const html = h.checkout.renderPage(ref);

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html.match(/<form /g)).toHaveLength(3);
    expect(html).toContain(`action="${ref}/complete"`);

    await h.checkout.complete(ref, 'succeeded');
    expect(h.checkout.renderPage(ref)).not.toContain('<form ');
  });

  it('answers 404 for unknown checkouts and when disabled in production', async () => {
    const h = createPaymentsHarness();
    expect(() => h.checkout.view('mock_unknown')).toThrow(
      expect.objectContaining({ code: 'PC_PAYMENT_NOT_FOUND' }) as Error,
    );

    const prod = createPaymentsHarness({ config: { NODE_ENV: 'production' } });
    const payment = await openCheckout(prod);
    expect(prod.checkout.enabled).toBe(false);
    await expect(
      prod.checkout.complete(payment.providerRef ?? '', 'succeeded'),
    ).rejects.toMatchObject({
      code: 'PC_COMMON_NOT_FOUND',
      status: 404,
    });
    expect(prod.prisma.payments[0]?.status).toBe('created');
  });
});
