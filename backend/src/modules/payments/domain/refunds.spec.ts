import type { PaymentStatus } from '../../../common/contracts/payments';
import { isPositiveKopecks, planRefund } from './refunds';

function payment(status: PaymentStatus, amountKopecks: number, refundedKopecks = 0) {
  return { id: 'pay-1', status, amountKopecks, refundedKopecks };
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('planRefund', () => {
  it.each([
    // status, amount, already refunded, requested, expected refund, next status
    ['succeeded', 6000, 0, undefined, 6000, 6000, 'refunded'],
    ['succeeded', 6000, 0, 6000, 6000, 6000, 'refunded'],
    ['succeeded', 6000, 0, 2000, 2000, 2000, 'partially_refunded'],
    ['fiscalized', 6000, 0, 1, 1, 1, 'partially_refunded'],
    ['fiscalized', 6000, 0, null, 6000, 6000, 'refunded'],
    ['partially_refunded', 6000, 2000, undefined, 4000, 6000, 'refunded'],
    ['partially_refunded', 6000, 2000, 1500, 1500, 3500, 'partially_refunded'],
    ['partially_refunded', 6000, 2000, 4000, 4000, 6000, 'refunded'],
  ] as const)(
    '%s amount %i refunded %i requested %s -> refund %i, cumulative %i, %s',
    (status, amount, refunded, requested, refundKopecks, refundedKopecks, nextStatus) => {
      const plan = planRefund(payment(status, amount, refunded), requested);
      expect(plan).toEqual({
        refundKopecks,
        refundedKopecks,
        remainingKopecks: amount - refundedKopecks,
        nextStatus,
        partial: nextStatus === 'partially_refunded',
      });
    },
  );

  it.each([
    ['created', 'PC_PAYMENT_REFUND_NOT_ALLOWED'],
    ['pending', 'PC_PAYMENT_REFUND_NOT_ALLOWED'],
    ['failed', 'PC_PAYMENT_REFUND_NOT_ALLOWED'],
    ['cancelled', 'PC_PAYMENT_REFUND_NOT_ALLOWED'],
    ['expired', 'PC_PAYMENT_REFUND_NOT_ALLOWED'],
    ['refunded', 'PC_PAYMENT_REFUND_NOT_ALLOWED'],
  ] as const)('rejects refunds of a %s payment', (status, code) => {
    expect(thrownBy(() => planRefund(payment(status, 6000)))).toMatchObject({ code });
  });

  it('rejects a settled payment whose remainder is already zero', () => {
    expect(thrownBy(() => planRefund(payment('partially_refunded', 6000, 6000)))).toMatchObject({
      code: 'PC_PAYMENT_REFUND_NOT_ALLOWED',
      status: 422,
    });
  });

  it.each([
    [0, 'zero'],
    [-100, 'negative'],
    [12.5, 'fractional'],
    [Number.NaN, 'NaN'],
    [6001, 'more than the amount'],
    [4001, 'more than the remainder'],
  ])('rejects amount %s (%s)', (requested) => {
    expect(
      thrownBy(() => planRefund(payment('partially_refunded', 6000, 2000), requested)),
    ).toMatchObject({ code: 'PC_PAYMENT_AMOUNT_INVALID', status: 400 });
  });

  it('recognises positive integer kopecks', () => {
    expect(isPositiveKopecks(1)).toBe(true);
    expect(isPositiveKopecks(0)).toBe(false);
    expect(isPositiveKopecks(1.5)).toBe(false);
    expect(isPositiveKopecks('100')).toBe(false);
    expect(isPositiveKopecks(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });
});
