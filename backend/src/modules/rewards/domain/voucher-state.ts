import type { VoucherStatus } from '../../../common/contracts/rewards';

/**
 * Voucher state machine (brief section 6):
 *
 *   issued -> active (2-minute activation window) -> redeemed
 *   active -> issued when the activation window lapses and expiresAt is not reached (deactivate)
 *   issued | active -> expired when expiresAt is reached
 *   issued | active -> cancelled (points returned per the cancel policy)
 *
 * Pure functions only; services and the vouchers-expire job apply the results.
 */

export const VOUCHER_FINAL_STATUSES: readonly VoucherStatus[] = [
  'redeemed',
  'expired',
  'cancelled',
];
export const VOUCHER_LIVE_STATUSES: readonly VoucherStatus[] = ['issued', 'active'];

export type VoucherTransition = 'activate' | 'deactivate' | 'redeem' | 'expire' | 'cancel';

const TRANSITIONS: Readonly<
  Record<VoucherStatus, Partial<Record<VoucherTransition, VoucherStatus>>>
> = {
  issued: { activate: 'active', expire: 'expired', cancel: 'cancelled' },
  // `activate` from `active` is a re-activation (new code, new window).
  active: {
    activate: 'active',
    deactivate: 'issued',
    redeem: 'redeemed',
    expire: 'expired',
    cancel: 'cancelled',
  },
  redeemed: {},
  expired: {},
  cancelled: {},
};

export function isFinalVoucherStatus(status: VoucherStatus): boolean {
  return VOUCHER_FINAL_STATUSES.includes(status);
}

export function isLiveVoucherStatus(status: VoucherStatus): boolean {
  return VOUCHER_LIVE_STATUSES.includes(status);
}

/** Target status of a transition, or null when the transition is not allowed from `from`. */
export function nextVoucherStatus(
  from: VoucherStatus,
  transition: VoucherTransition,
): VoucherStatus | null {
  return TRANSITIONS[from][transition] ?? null;
}

export function canTransitionVoucher(from: VoucherStatus, transition: VoucherTransition): boolean {
  return nextVoucherStatus(from, transition) !== null;
}

export interface VoucherLifecycleSnapshot {
  status: VoucherStatus;
  activationExpiresAt: Date | null;
  expiresAt: Date | null;
}

/**
 * The status a voucher effectively has at `now`, before the minute sweep catches up:
 * a lapsed activation reads as `issued`, a reached `expiresAt` reads as `expired`.
 * Final statuses are returned unchanged.
 */
export function effectiveVoucherStatus(
  voucher: VoucherLifecycleSnapshot,
  now: Date,
): VoucherStatus {
  if (!isLiveVoucherStatus(voucher.status)) {
    return voucher.status;
  }
  if (voucher.expiresAt !== null && voucher.expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  if (
    voucher.status === 'active' &&
    (voucher.activationExpiresAt === null || voucher.activationExpiresAt.getTime() <= now.getTime())
  ) {
    return 'issued';
  }
  return voucher.status;
}

/** True while the voucher can be redeemed by a validator right now. */
export function isActivationLive(voucher: VoucherLifecycleSnapshot, now: Date): boolean {
  return effectiveVoucherStatus(voucher, now) === 'active';
}

export type SweepAction = 'expire' | 'deactivate' | 'none';

/** What the vouchers-expire job must do with a voucher at `now`. */
export function planSweepAction(voucher: VoucherLifecycleSnapshot, now: Date): SweepAction {
  const effective = effectiveVoucherStatus(voucher, now);
  if (effective === voucher.status) {
    return 'none';
  }
  if (effective === 'expired') {
    return 'expire';
  }
  if (effective === 'issued') {
    return 'deactivate';
  }
  return 'none';
}
