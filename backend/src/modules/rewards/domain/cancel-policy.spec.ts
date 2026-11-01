import type { VoucherSourceType, VoucherStatus } from '../../../common/contracts/rewards';
import { type CancelDecision, decideCancel } from './cancel-policy';

describe('decideCancel', () => {
  const cases: Array<[VoucherStatus, VoucherSourceType, boolean | undefined, CancelDecision]> = [
    // Reward vouchers bought with points: refunded per rule unless the caller opts out.
    ['issued', 'redemption', undefined, { allowed: true, refundPoints: true }],
    ['active', 'redemption', undefined, { allowed: true, refundPoints: true }],
    ['issued', 'redemption', true, { allowed: true, refundPoints: true }],
    ['issued', 'redemption', false, { allowed: true, refundPoints: false }],
    // Coupons, tickets and admin vouchers never carry points.
    ['issued', 'promo', undefined, { allowed: true, refundPoints: false }],
    ['active', 'event', undefined, { allowed: true, refundPoints: false }],
    ['issued', 'admin', true, { allowed: true, refundPoints: false }],
    // Final states.
    ['redeemed', 'redemption', undefined, { allowed: false, reason: 'already_redeemed' }],
    ['redeemed', 'promo', true, { allowed: false, reason: 'already_redeemed' }],
    ['expired', 'redemption', undefined, { allowed: false, reason: 'final' }],
    ['cancelled', 'redemption', undefined, { allowed: false, reason: 'final' }],
    ['cancelled', 'event', false, { allowed: false, reason: 'final' }],
  ];

  it.each(cases)('%s %s refund=%p -> %j', (status, sourceType, refundPoints, expected) => {
    expect(decideCancel({ status, sourceType, refundPoints })).toEqual(expected);
  });
});
