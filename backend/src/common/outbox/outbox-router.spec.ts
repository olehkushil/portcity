import { OutboxRouter, matchesEventPattern } from './outbox-router';

describe('outbox routing', () => {
  it.each([
    ['receipt.credited', 'receipt.credited', true],
    ['receipt.credited', 'receipt.rejected', false],
    ['receipt.*', 'receipt.credited', true],
    ['receipt.*', 'receipt.credited.extra', false],
    ['receipt.*', 'receipt', false],
    ['parking.**', 'parking.session.payable', true],
    ['parking.**', 'parking.session', true],
    ['parking.**', 'parking', false],
    ['*.created', 'voucher.created', true],
    ['*.created', 'voucher.activated', false],
  ])('pattern %s vs %s -> %s', (pattern, type, expected) => {
    expect(matchesEventPattern(pattern, type)).toBe(expected);
  });

  it('resolves fan-out routes without duplicates', () => {
    const router = new OutboxRouter()
      .addRoute('receipt.credited', 'notifications-push')
      .addRoute('receipt.*', 'reports-nightly')
      .addRoute('receipt.credited', 'notifications-push')
      .addRoutes({
        'parking.**': ['notifications-push', 'parking-sync'],
        'payment.succeeded': 'parking-sync',
      });

    expect(router.resolve('receipt.credited')).toEqual(['notifications-push', 'reports-nightly']);
    expect(router.resolve('receipt.rejected')).toEqual(['reports-nightly']);
    expect(router.resolve('parking.session.payable')).toEqual([
      'notifications-push',
      'parking-sync',
    ]);
    expect(router.resolve('voucher.activated')).toEqual([]);
    expect(router.list()).toHaveLength(5);
  });

  it('rejects invalid patterns', () => {
    const router = new OutboxRouter();
    expect(() => router.addRoute('receipt', 'q')).toThrow();
    expect(() => router.addRoute('Receipt.Credited', 'q')).toThrow();
    expect(() => router.addRoute('receipt.**.credited', 'q')).toThrow();
    expect(() => router.addRoute('receipt.credited', '')).toThrow();
  });

  it('keeps audit-only types separate from routes', () => {
    const router = new OutboxRouter();
    router.ignore('voucher.activated', 'the app shows the code itself');
    expect(router.isIgnored('voucher.activated')).toBe(true);
    expect(router.isIgnored('voucher.redeemed')).toBe(false);
    expect(router.resolve('voucher.activated')).toEqual([]);
    expect([...router.listIgnored().keys()]).toEqual(['voucher.activated']);
    expect(() => router.ignore('voucher.*', 'patterns are not allowed')).toThrow();
    expect(() => router.ignore('Voucher', 'invalid')).toThrow();
  });
});
