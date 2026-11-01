import type { SpendBlockReason } from '../../../common/contracts/club';

/**
 * Pure balance arithmetic shared by the ledger service and its tests.
 *
 * Invariant kept by every operation: `sum(buckets.remaining) === max(availableBalance, 0)`.
 * A negative balance (after a reversal) has no buckets; the next credits settle the debt first
 * and only the remainder becomes spendable (and expirable) points.
 */

export interface BucketState {
  /** Kyiv calendar day `yyyy-MM-dd` on which the points expire. */
  dayKey: string;
  remaining: number;
}

export interface BucketDelta {
  dayKey: string;
  /** Points taken from (positive) the bucket. */
  amount: number;
}

export function assertPositiveInteger(value: number, field = 'amount'): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive integer, got ${String(value)}`);
  }
}

/** Adds a credit: a negative balance is settled first, the rest lands in an expiry bucket. */
export function applyCredit(
  availableBalance: number,
  amount: number,
): { availableBalance: number; toBucket: number } {
  assertPositiveInteger(amount);
  const settled = availableBalance < 0 ? Math.min(amount, -availableBalance) : 0;
  return { availableBalance: availableBalance + amount, toBucket: amount - settled };
}

function sortedAsc(buckets: readonly BucketState[]): BucketState[] {
  return [...buckets]
    .filter((bucket) => bucket.remaining > 0)
    .sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0));
}

/**
 * FIFO consumption for a spend: the earliest-expiring points go first.
 * `shortfall` is non-zero only when the buckets hold less than `amount` (balance drift).
 */
export function consumeFifo(
  buckets: readonly BucketState[],
  amount: number,
): { taken: BucketDelta[]; shortfall: number } {
  assertPositiveInteger(amount);
  const taken: BucketDelta[] = [];
  let left = amount;
  for (const bucket of sortedAsc(buckets)) {
    if (left === 0) {
      break;
    }
    const portion = Math.min(bucket.remaining, left);
    taken.push({ dayKey: bucket.dayKey, amount: portion });
    left -= portion;
  }
  return { taken, shortfall: left };
}

/**
 * Removes points for a reversal or a negative adjustment: first from the reversed credit's own
 * bucket (`preferredDayKey`), then from the latest-expiring buckets, so the member keeps the
 * points that expire soonest. A shortfall is allowed: the balance goes negative instead.
 */
export function reduceBuckets(
  buckets: readonly BucketState[],
  amount: number,
  preferredDayKey?: string,
): { taken: BucketDelta[]; shortfall: number } {
  assertPositiveInteger(amount);
  const taken: BucketDelta[] = [];
  let left = amount;
  const ordered = sortedAsc(buckets).reverse();
  if (preferredDayKey !== undefined) {
    const index = ordered.findIndex((bucket) => bucket.dayKey === preferredDayKey);
    if (index > 0) {
      const [preferred] = ordered.splice(index, 1);
      if (preferred) {
        ordered.unshift(preferred);
      }
    }
  }
  for (const bucket of ordered) {
    if (left === 0) {
      break;
    }
    const portion = Math.min(bucket.remaining, left);
    taken.push({ dayKey: bucket.dayKey, amount: portion });
    left -= portion;
  }
  return { taken, shortfall: left };
}

export interface RefundPlanInput {
  /** Points returned by the refund (positive). */
  amount: number;
  /** Buckets the refunded debit consumed (points_spend_allocations); empty for older rows. */
  allocations: readonly BucketDelta[];
  /** Bucket for the part not covered by allocations (older rows, bucket drift): now + TTL. */
  freshDayKey: string;
  /** Cached available balance before the refund (may be negative after a reversal). */
  availableBalance: number;
  /** Today's Kyiv day: a bucket of an earlier day has already expired. */
  todayKey: string;
}

export interface RefundPlan {
  /** Part of the refund that settles a negative balance first (never reaches a bucket). */
  settled: number;
  /** Portions that go back into still valid buckets, ascending by day. */
  toBuckets: BucketDelta[];
  /** Portions whose bucket day already passed: expired right away, ascending by day. */
  expired: BucketDelta[];
  expiredTotal: number;
}

/**
 * Where the points of a refunded debit go (finding: redeem-then-cancel must not reset the
 * 12-month expiry). Every portion returns to the bucket it was taken from; the part without an
 * allocation goes to `freshDayKey`. A negative balance is settled first, FIFO by day (the
 * earliest-expiring points pay the debt, exactly like a spend). Portions of days that already
 * ended are expired immediately; `toBuckets` keeps the rest. Invariant afterwards:
 * sum(buckets) === max(availableBalance + amount - expiredTotal, 0).
 */
export function planRefund(input: RefundPlanInput): RefundPlan {
  assertPositiveInteger(input.amount);
  const merged = new Map<string, number>();
  let allocated = 0;
  for (const portion of input.allocations) {
    const take = Math.min(Math.max(portion.amount, 0), input.amount - allocated);
    if (take <= 0) {
      continue;
    }
    merged.set(portion.dayKey, (merged.get(portion.dayKey) ?? 0) + take);
    allocated += take;
  }
  if (allocated < input.amount) {
    merged.set(input.freshDayKey, (merged.get(input.freshDayKey) ?? 0) + input.amount - allocated);
  }
  const portions = [...merged.entries()]
    .map(([dayKey, amount]) => ({ dayKey, amount }))
    .sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0));

  const settled = Math.min(Math.max(-input.availableBalance, 0), input.amount);
  let debt = settled;
  for (const portion of portions) {
    if (debt === 0) {
      break;
    }
    const take = Math.min(portion.amount, debt);
    portion.amount -= take;
    debt -= take;
  }

  const left = portions.filter((portion) => portion.amount > 0);
  const expired = left.filter((portion) => portion.dayKey < input.todayKey);
  const toBuckets = left.filter((portion) => portion.dayKey >= input.todayKey);
  return {
    settled,
    toBuckets,
    expired,
    expiredTotal: expired.reduce((sum, portion) => sum + portion.amount, 0),
  };
}

/** Applies bucket deltas to a bucket list (missing buckets are created for positive deltas). */
export function applyBucketDeltas(
  buckets: readonly BucketState[],
  deltas: ReadonlyArray<{ dayKey: string; delta: number }>,
): BucketState[] {
  const map = new Map<string, number>();
  for (const bucket of buckets) {
    map.set(bucket.dayKey, bucket.remaining);
  }
  for (const { dayKey, delta } of deltas) {
    map.set(dayKey, (map.get(dayKey) ?? 0) + delta);
  }
  return [...map.entries()]
    .map(([dayKey, remaining]) => ({ dayKey, remaining }))
    .filter((bucket) => bucket.remaining > 0)
    .sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0));
}

/** Why spending is blocked right now, or null. A negative balance wins over the newcomer lock. */
export function spendBlockReason(
  availableBalance: number,
  newcomerLockUntil: Date | null,
  now: Date,
): SpendBlockReason | null {
  if (availableBalance < 0) {
    return 'negative_balance';
  }
  if (newcomerLockUntil !== null && newcomerLockUntil.getTime() > now.getTime()) {
    return 'newcomer_lock';
  }
  return null;
}

export interface ExpiringCredit {
  id: string;
  amount: number;
}

/**
 * When a bucket expires, decides which of its credits were fully consumed before (`spent`)
 * and which still held points (`expired`). Credits must be ordered oldest first, matching the
 * FIFO order in which spends consumed them. `remaining` is the bucket's unconsumed remainder.
 */
export function splitExpiredCredits(
  credits: readonly ExpiringCredit[],
  remaining: number,
): { spent: string[]; expired: string[] } {
  const total = credits.reduce((sum, credit) => sum + Math.max(credit.amount, 0), 0);
  const consumed = Math.min(Math.max(total - remaining, 0), total);
  const spent: string[] = [];
  const expired: string[] = [];
  let cumulative = 0;
  for (const credit of credits) {
    cumulative += Math.max(credit.amount, 0);
    if (cumulative <= consumed) {
      spent.push(credit.id);
    } else {
      expired.push(credit.id);
    }
  }
  return { spent, expired };
}

export interface ExpiringSoon {
  withinDays: number;
  points: number;
  nearest: { expiresOn: string; points: number } | null;
}

/** Points that expire within `withinDays` Kyiv days starting today (buckets must be ascending). */
export function expiringSoon(
  buckets: readonly BucketState[],
  todayKey: string,
  lastDayKey: string,
  withinDays: number,
): ExpiringSoon {
  let points = 0;
  let nearest: ExpiringSoon['nearest'] = null;
  for (const bucket of sortedAsc(buckets)) {
    if (bucket.dayKey < todayKey || bucket.dayKey > lastDayKey) {
      continue;
    }
    points += bucket.remaining;
    if (nearest === null) {
      nearest = { expiresOn: bucket.dayKey, points: bucket.remaining };
    }
  }
  return { withinDays, points, nearest };
}
