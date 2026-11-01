import type { VoucherSourceType, VoucherStatus } from '../../../common/contracts/rewards';
import { isLiveVoucherStatus } from './voucher-state';

/**
 * Cancellation policy (brief section 6: "cancelled (points returned per rule)").
 * Only live vouchers (issued, active) can be cancelled. Points are refunded when the voucher
 * was bought with points (sourceType = redemption) unless the caller opts out
 * (`refundPoints: false`, e.g. an admin cancelling for abuse). Coupons, tickets and
 * admin-issued vouchers never carry points.
 */

export interface CancelPolicyInput {
  status: VoucherStatus;
  sourceType: VoucherSourceType;
  /** Explicit override from the caller; undefined means "per rule". */
  refundPoints?: boolean | undefined;
}

export type CancelDecision =
  | { allowed: false; reason: 'already_redeemed' | 'final' }
  | { allowed: true; refundPoints: boolean };

export function decideCancel(input: CancelPolicyInput): CancelDecision {
  if (input.status === 'redeemed') {
    return { allowed: false, reason: 'already_redeemed' };
  }
  if (!isLiveVoucherStatus(input.status)) {
    return { allowed: false, reason: 'final' };
  }
  const pointsBacked = input.sourceType === 'redemption';
  return { allowed: true, refundPoints: pointsBacked && input.refundPoints !== false };
}
