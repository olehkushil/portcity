import type { RewardKind, RewardsErrorCode, VoucherKind } from '../../../common/contracts/rewards';

/**
 * Catalogue rules: when a reward is listed, when it can be redeemed, what the member can
 * afford, and how long the resulting voucher lives. Pure functions over plain snapshots.
 */

export interface RewardAvailabilitySnapshot {
  active: boolean;
  validFrom: Date | null;
  validTo: Date | null;
  /** Remaining stock; null means unlimited. */
  stock: number | null;
  /** Max redemptions per member; null means unlimited. */
  perUserLimit: number | null;
}

export const REWARD_UNAVAILABLE_REASONS = [
  'inactive',
  'not_started',
  'ended',
  'out_of_stock',
  'limit_reached',
] as const;
export type RewardUnavailableReason = (typeof REWARD_UNAVAILABLE_REASONS)[number];

export type RewardAvailability = { ok: true } | { ok: false; reason: RewardUnavailableReason };

/** Inside [validFrom, validTo); open bounds when null. */
export function isRewardInPeriod(
  reward: Pick<RewardAvailabilitySnapshot, 'validFrom' | 'validTo'>,
  now: Date,
): boolean {
  if (reward.validFrom !== null && reward.validFrom.getTime() > now.getTime()) {
    return false;
  }
  if (reward.validTo !== null && reward.validTo.getTime() <= now.getTime()) {
    return false;
  }
  return true;
}

/** Shown in the member catalogue: active and inside its period (stock may be zero). */
export function isRewardListed(
  reward: Pick<RewardAvailabilitySnapshot, 'active' | 'validFrom' | 'validTo'>,
  now: Date,
): boolean {
  return reward.active && isRewardInPeriod(reward, now);
}

/** Full redeem check; `userRedemptions` counts the member's non-cancelled redemptions of it. */
export function checkRewardAvailability(
  reward: RewardAvailabilitySnapshot,
  now: Date,
  userRedemptions: number,
): RewardAvailability {
  if (!reward.active) {
    return { ok: false, reason: 'inactive' };
  }
  if (reward.validFrom !== null && reward.validFrom.getTime() > now.getTime()) {
    return { ok: false, reason: 'not_started' };
  }
  if (reward.validTo !== null && reward.validTo.getTime() <= now.getTime()) {
    return { ok: false, reason: 'ended' };
  }
  if (reward.stock !== null && reward.stock <= 0) {
    return { ok: false, reason: 'out_of_stock' };
  }
  if (reward.perUserLimit !== null && userRedemptions >= reward.perUserLimit) {
    return { ok: false, reason: 'limit_reached' };
  }
  return { ok: true };
}

export const REWARD_UNAVAILABLE_ERRORS: Readonly<
  Record<RewardUnavailableReason, RewardsErrorCode>
> = {
  inactive: 'PC_REWARD_INACTIVE',
  not_started: 'PC_REWARD_INACTIVE',
  ended: 'PC_REWARD_INACTIVE',
  out_of_stock: 'PC_REWARD_OUT_OF_STOCK',
  limit_reached: 'PC_REWARD_LIMIT_REACHED',
};

/** Remaining redemptions for the member, null when the reward has no per-user limit. */
export function remainingForUser(
  perUserLimit: number | null,
  userRedemptions: number,
): number | null {
  if (perUserLimit === null) {
    return null;
  }
  return Math.max(perUserLimit - userRedemptions, 0);
}

/** Null when the balance is unknown (ledger unavailable). */
export function isAffordable(costPoints: number, availableBalance: number | null): boolean | null {
  if (availableBalance === null) {
    return null;
  }
  return availableBalance >= costPoints;
}

/**
 * Hard expiry of a voucher issued from a reward: `ttlDays` after issue, but never after the
 * reward's own validTo.
 */
export function computeRewardVoucherExpiry(
  reward: Pick<RewardAvailabilitySnapshot, 'validTo'>,
  now: Date,
  ttlDays: number,
): Date {
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    throw new Error('Voucher TTL must be a positive number of days');
  }
  const byTtl = new Date(now.getTime() + ttlDays * 86_400_000);
  if (reward.validTo !== null && reward.validTo.getTime() < byTtl.getTime()) {
    return reward.validTo;
  }
  return byTtl;
}

/** Certificates stay certificates in the wallet; every other reward becomes a reward voucher. */
export function voucherKindForReward(kind: RewardKind): VoucherKind {
  return kind === 'certificate' ? 'certificate' : 'reward';
}
