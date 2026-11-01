import type { PaymentStatus } from '../../../common/contracts/payments';
import {
  type PaymentSnapshot,
  type ProviderEventDecision,
  type ProviderEventKind,
  type ProviderPaymentEvent,
  applyProviderEvent,
  isProviderEventKind,
  outboxTypeForStatus,
} from './provider-events';

const NOW = new Date('2026-01-15T10:00:00.000Z');
const PAID_AT = new Date('2026-01-15T09:59:30.000Z');

function snapshot(
  status: PaymentStatus,
  overrides: Partial<PaymentSnapshot> = {},
): PaymentSnapshot {
  return {
    id: 'pay-1',
    status,
    amountKopecks: 6000,
    refundedKopecks: 0,
    currency: 'UAH',
    providerRef: 'mock_pay-1',
    ...overrides,
  };
}

function event(
  kind: ProviderEventKind,
  overrides: Partial<ProviderPaymentEvent> = {},
): ProviderPaymentEvent {
  return {
    externalId: `evt-${kind}`,
    providerRef: 'mock_pay-1',
    kind,
    raw: { kind },
    ...overrides,
  };
}

describe('applyProviderEvent', () => {
  const table: ReadonlyArray<
    [string, PaymentStatus, ProviderPaymentEvent, Partial<ProviderEventDecision>]
  > = [
    [
      'pending from created',
      'created',
      event('pending'),
      { kind: 'transition', from: 'created', to: 'pending' },
    ],
    ['pending twice', 'pending', event('pending'), { kind: 'noop', reason: 'already_in_status' }],
    [
      'pending after success is stale',
      'succeeded',
      event('pending'),
      { kind: 'ignore', reason: 'stale' },
    ],
    [
      'success from created',
      'created',
      event('succeeded'),
      { kind: 'transition', from: 'created', to: 'succeeded' },
    ],
    [
      'success from pending',
      'pending',
      event('succeeded'),
      { kind: 'transition', from: 'pending', to: 'succeeded' },
    ],
    [
      'success twice',
      'succeeded',
      event('succeeded'),
      { kind: 'noop', reason: 'already_in_status' },
    ],
    [
      'success after fiscalized',
      'fiscalized',
      event('succeeded'),
      { kind: 'noop', reason: 'already_in_status' },
    ],
    [
      'success after failed is a late success',
      'failed',
      event('succeeded'),
      { kind: 'transition', from: 'failed', to: 'succeeded', late: true },
    ],
    [
      'success after expired is a late success',
      'expired',
      event('succeeded'),
      { kind: 'transition', from: 'expired', to: 'succeeded', late: true },
    ],
    [
      'success after cancelled is a late success',
      'cancelled',
      event('succeeded', { amountKopecks: 6000, currency: 'UAH' }),
      { kind: 'transition', from: 'cancelled', to: 'succeeded', late: true },
    ],
    [
      'late success with another amount is not applied',
      'expired',
      event('succeeded', { amountKopecks: 4000 }),
      { kind: 'ignore', reason: 'amount_mismatch' },
    ],
    [
      'success after refunded stays final',
      'refunded',
      event('succeeded'),
      { kind: 'ignore', reason: 'final' },
    ],
    [
      'pending after expired stays final',
      'expired',
      event('pending'),
      { kind: 'ignore', reason: 'final' },
    ],
    [
      'success with matching amount',
      'pending',
      event('succeeded', { amountKopecks: 6000, currency: 'UAH' }),
      { kind: 'transition', to: 'succeeded' },
    ],
    [
      'success with wrong amount',
      'pending',
      event('succeeded', { amountKopecks: 5999 }),
      { kind: 'ignore', reason: 'amount_mismatch' },
    ],
    [
      'success with wrong currency',
      'pending',
      event('succeeded', { currency: 'USD' }),
      { kind: 'ignore', reason: 'currency_mismatch' },
    ],
    [
      'failed from created',
      'created',
      event('failed', { failureCode: 'card_declined' }),
      { kind: 'transition', to: 'failed' },
    ],
    ['failed from pending', 'pending', event('failed'), { kind: 'transition', to: 'failed' }],
    ['failed twice', 'failed', event('failed'), { kind: 'noop', reason: 'already_in_status' }],
    [
      'failed after success conflicts',
      'succeeded',
      event('failed'),
      { kind: 'ignore', reason: 'conflict' },
    ],
    [
      'cancelled from pending',
      'pending',
      event('cancelled'),
      { kind: 'transition', to: 'cancelled' },
    ],
    [
      'cancelled after expired is final',
      'expired',
      event('cancelled'),
      { kind: 'ignore', reason: 'final' },
    ],
    ['expired from created', 'created', event('expired'), { kind: 'transition', to: 'expired' }],
    [
      'expired after refund conflicts',
      'partially_refunded',
      event('expired'),
      { kind: 'ignore', reason: 'conflict' },
    ],
    [
      'refund of succeeded (full, no amount)',
      'succeeded',
      event('refunded'),
      { kind: 'transition', to: 'refunded' },
    ],
    [
      'refund of fiscalized with cumulative amount',
      'fiscalized',
      event('refunded', { refundedKopecks: 2000 }),
      { kind: 'transition', to: 'partially_refunded' },
    ],
    [
      'refund completing a partial',
      'partially_refunded',
      event('refunded', { refundedKopecks: 6000 }),
      { kind: 'transition', to: 'refunded' },
    ],
    [
      'refund replay with same cumulative amount',
      'partially_refunded',
      event('refunded', { refundedKopecks: 2000 }),
      { kind: 'noop', reason: 'nothing_to_refund' },
    ],
    [
      'refund of an open payment conflicts',
      'pending',
      event('refunded'),
      { kind: 'ignore', reason: 'conflict' },
    ],
    [
      'refund of a refunded payment',
      'refunded',
      event('refunded'),
      { kind: 'noop', reason: 'already_in_status' },
    ],
    [
      'refund of a failed payment conflicts',
      'failed',
      event('refunded'),
      { kind: 'ignore', reason: 'conflict' },
    ],
  ];

  it.each(table)('%s', (_name, status, incoming, expected) => {
    const refunded = status === 'partially_refunded' ? 2000 : 0;
    const decision = applyProviderEvent(
      snapshot(status, { refundedKopecks: refunded }),
      incoming,
      NOW,
    );
    expect(decision).toMatchObject(expected);
  });

  it('sets paidAt from the event or from now on success', () => {
    const fromEvent = applyProviderEvent(
      snapshot('pending'),
      event('succeeded', { paidAt: PAID_AT }),
      NOW,
    );
    expect(fromEvent).toMatchObject({
      kind: 'transition',
      patch: { paidAt: PAID_AT, failureCode: null },
    });
    const fromNow = applyProviderEvent(snapshot('pending'), event('succeeded'), NOW);
    expect(fromNow).toMatchObject({ kind: 'transition', patch: { paidAt: NOW } });
  });

  it('records the failure code (default provider_failed) on failure', () => {
    expect(applyProviderEvent(snapshot('pending'), event('failed'), NOW)).toMatchObject({
      patch: { failureCode: 'provider_failed' },
    });
    expect(
      applyProviderEvent(
        snapshot('pending'),
        event('failed', { failureCode: 'insufficient_funds' }),
        NOW,
      ),
    ).toMatchObject({ patch: { failureCode: 'insufficient_funds' } });
    expect(applyProviderEvent(snapshot('pending'), event('expired'), NOW)).toMatchObject({
      patch: {},
    });
  });

  it('adopts the provider reference when the payment has none yet', () => {
    const decision = applyProviderEvent(
      snapshot('created', { providerRef: null }),
      event('pending', { providerRef: 'ref-from-provider' }),
      NOW,
    );
    expect(decision).toMatchObject({ patch: { providerRef: 'ref-from-provider' } });
    const keep = applyProviderEvent(
      snapshot('created'),
      event('pending', { providerRef: 'other' }),
      NOW,
    );
    expect(keep).toMatchObject({ patch: {} });
  });

  it('computes cumulative refunds capped at the amount', () => {
    const decision = applyProviderEvent(
      snapshot('partially_refunded', { refundedKopecks: 2000 }),
      event('refunded', { refundedKopecks: 99_999 }),
      NOW,
    );
    expect(decision).toMatchObject({
      kind: 'transition',
      to: 'refunded',
      patch: { refundedKopecks: 6000 },
    });
  });

  it('maps statuses to outbox event types', () => {
    expect(outboxTypeForStatus('succeeded')).toBe('payment.succeeded');
    expect(outboxTypeForStatus('failed')).toBe('payment.failed');
    expect(outboxTypeForStatus('cancelled')).toBe('payment.cancelled');
    expect(outboxTypeForStatus('expired')).toBe('payment.expired');
    expect(outboxTypeForStatus('refunded')).toBe('payment.refunded');
    expect(outboxTypeForStatus('partially_refunded')).toBe('payment.refunded');
    expect(outboxTypeForStatus('fiscalized')).toBe('payment.fiscalized');
    expect(outboxTypeForStatus('pending')).toBeNull();
    expect(outboxTypeForStatus('created')).toBeNull();
  });

  it('recognises event kinds', () => {
    expect(isProviderEventKind('succeeded')).toBe(true);
    expect(isProviderEventKind('created')).toBe(false);
    expect(isProviderEventKind(null)).toBe(false);
  });
});
