import { PAYMENT_STATUSES, type PaymentStatus } from '../../../common/contracts/payments';
import { DomainError } from '../../../common/errors/domain-error';
import {
  FINAL_STATUSES,
  LATE_SUCCESS_SOURCES,
  OPEN_STATUSES,
  PAYMENT_TRANSITIONS,
  SETTLED_STATUSES,
  assertTransition,
  canTransition,
  isFinalStatus,
  isLateSuccessSource,
  isOpenStatus,
  isPaymentStatus,
  isRefundableStatus,
  isReusableStatus,
  isSettledStatus,
  visibleCheckoutUrl,
} from './state-machine';

describe('payment state machine', () => {
  const allowed: ReadonlyArray<[PaymentStatus, PaymentStatus]> = [
    ['created', 'pending'],
    ['created', 'succeeded'],
    ['created', 'failed'],
    ['created', 'cancelled'],
    ['created', 'expired'],
    ['pending', 'succeeded'],
    ['pending', 'failed'],
    ['pending', 'cancelled'],
    ['pending', 'expired'],
    ['succeeded', 'fiscalized'],
    ['succeeded', 'refunded'],
    ['succeeded', 'partially_refunded'],
    ['fiscalized', 'refunded'],
    ['fiscalized', 'partially_refunded'],
    ['partially_refunded', 'refunded'],
    ['partially_refunded', 'partially_refunded'],
    // Late success: the provider captured the money after the payment was closed.
    ['failed', 'succeeded'],
    ['cancelled', 'succeeded'],
    ['expired', 'succeeded'],
  ];

  const forbidden: ReadonlyArray<[PaymentStatus, PaymentStatus]> = [
    ['created', 'fiscalized'],
    ['created', 'refunded'],
    ['pending', 'created'],
    ['pending', 'fiscalized'],
    ['succeeded', 'pending'],
    ['succeeded', 'failed'],
    ['succeeded', 'expired'],
    ['succeeded', 'created'],
    ['fiscalized', 'succeeded'],
    ['fiscalized', 'fiscalized'],
    ['refunded', 'partially_refunded'],
    ['refunded', 'succeeded'],
    ['failed', 'pending'],
    ['failed', 'refunded'],
    ['cancelled', 'pending'],
    ['expired', 'pending'],
    ['expired', 'fiscalized'],
  ];

  it.each(allowed)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each(forbidden)('forbids %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    let caught: unknown;
    try {
      assertTransition(from, to, 'pay-1');
    } catch (error) {
      caught = error;
    }
    expect(DomainError.is(caught)).toBe(true);
    expect(caught).toMatchObject({
      code: 'PC_PAYMENT_INVALID_TRANSITION',
      status: 409,
      details: { paymentId: 'pay-1', from, to },
    });
  });

  it('covers every status in the transition table and the classification sets', () => {
    expect(Object.keys(PAYMENT_TRANSITIONS).sort()).toEqual([...PAYMENT_STATUSES].sort());
    for (const status of PAYMENT_STATUSES) {
      const classes = [
        OPEN_STATUSES.includes(status),
        SETTLED_STATUSES.includes(status),
        FINAL_STATUSES.includes(status),
      ].filter(Boolean);
      expect(classes).toHaveLength(1);
    }
  });

  it('final statuses allow only a late success (refunded allows nothing)', () => {
    for (const status of FINAL_STATUSES) {
      expect(PAYMENT_TRANSITIONS[status]).toEqual(isLateSuccessSource(status) ? ['succeeded'] : []);
      expect(isFinalStatus(status)).toBe(true);
      expect(isRefundableStatus(status)).toBe(false);
    }
    expect([...LATE_SUCCESS_SOURCES].sort()).toEqual(['cancelled', 'expired', 'failed']);
  });

  it.each([
    ['created', true],
    ['pending', true],
    ['succeeded', true],
    ['fiscalized', true],
    ['partially_refunded', true],
    ['refunded', false],
    ['failed', false],
    ['cancelled', false],
    ['expired', false],
  ] as const)('reuses %s for the same logical key: %s', (status, reusable) => {
    expect(isReusableStatus(status)).toBe(reusable);
  });

  it.each([
    ['created', true, false, false],
    ['pending', true, false, false],
    ['succeeded', false, true, true],
    ['fiscalized', false, true, true],
    ['partially_refunded', false, true, true],
    ['refunded', false, false, false],
    ['failed', false, false, false],
    ['cancelled', false, false, false],
    ['expired', false, false, false],
  ] as const)(
    'classifies %s (open %s, settled %s, refundable %s)',
    (status, open, settled, refundable) => {
      expect(isOpenStatus(status)).toBe(open);
      expect(isSettledStatus(status)).toBe(settled);
      expect(isRefundableStatus(status)).toBe(refundable);
    },
  );

  it('recognises status strings', () => {
    expect(isPaymentStatus('succeeded')).toBe(true);
    expect(isPaymentStatus('paid')).toBe(false);
    expect(isPaymentStatus(42)).toBe(false);
  });

  it.each([
    ['created', 'https://pay.example/1', 'https://pay.example/1'],
    ['pending', 'https://pay.example/1', 'https://pay.example/1'],
    ['succeeded', 'https://pay.example/1', null],
    ['expired', 'https://pay.example/1', null],
    ['created', null, null],
  ] as const)('exposes the checkout url only while open (%s)', (status, url, expected) => {
    expect(visibleCheckoutUrl(status, url)).toBe(expected);
  });
});
