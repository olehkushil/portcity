import type {
  Redemption,
  Reward,
  ValidatorDevice,
  Voucher,
  VoucherRedemptionLog,
} from '@prisma/client';
import type {
  RedemptionStatus,
  RewardKind,
  VoucherKind,
  VoucherSourceType,
  VoucherStatus,
} from '../../../common/contracts/rewards';
import type { DateRange } from '../../../common/contracts/shared';
import type { DbClient } from '../../../common/prisma/prisma.service';
import type { CreatedAtCursor, SortOrderCursor } from '../domain/cursors';
import type { RedeemOutcome } from '../domain/redeem-rules';

/**
 * Data access of the rewards module behind an abstract class (the Nest injection token).
 * `PrismaRewardsRepository` is the production implementation; tests use the in-memory
 * implementation in test/rewards/support. Every method takes the caller's `DbClient`
 * (root client or open transaction) so services decide transaction boundaries.
 * Plain input shapes keep both implementations simple and type-safe.
 */

export interface PageRequest<C> {
  cursor?: C | undefined;
  /** Implementations fetch `limit + 1` rows so the caller can detect the next page. */
  limit: number;
}

export interface NewReward {
  id: string;
  title: string;
  description: string | null;
  costPoints: number;
  kind: RewardKind;
  tenantId: string | null;
  stock: number | null;
  perUserLimit: number | null;
  active: boolean;
  validFrom: Date | null;
  validTo: Date | null;
  imageKey: string | null;
  terms: string | null;
  sortOrder: number;
  createdAt: Date;
}

export type RewardPatch = Partial<Omit<NewReward, 'id' | 'createdAt'>>;

export interface RewardListFilter {
  /** Only rewards listed for members at this instant: active and inside [validFrom, validTo). */
  listedAt?: Date | undefined;
  active?: boolean | undefined;
  kind?: RewardKind | undefined;
  tenantId?: string | undefined;
  /** Only rewards the member can afford. */
  maxCostPoints?: number | undefined;
}

export interface NewRedemption {
  id: string;
  userId: string;
  rewardId: string;
  status: RedemptionStatus;
  pointsTxId: string | null;
  voucherId: string | null;
  createdAt: Date;
}

export type RedemptionPatch = Partial<Pick<NewRedemption, 'status' | 'pointsTxId' | 'voucherId'>>;

export interface NewVoucher {
  id: string;
  userId: string;
  kind: VoucherKind;
  title: string;
  subtitle: string | null;
  tenantId: string | null;
  status: VoucherStatus;
  expiresAt: Date | null;
  sourceType: VoucherSourceType;
  sourceId: string | null;
  meta: Record<string, unknown>;
  imageKey: string | null;
  createdAt: Date;
}

export interface VoucherPatch {
  status?: VoucherStatus;
  code?: string | null;
  tokenHash?: string | null;
  activatedAt?: Date | null;
  activationExpiresAt?: Date | null;
  redeemedAt?: Date | null;
  redeemedByDeviceId?: string | null;
  redeemedByTenantId?: string | null;
  expiresAt?: Date | null;
  title?: string;
  subtitle?: string | null;
  meta?: Record<string, unknown>;
}

/** Row predicate for conditional updates (optimistic transitions, atomic redeem). */
export interface VoucherCondition {
  id: string;
  statuses: readonly VoucherStatus[];
  /** Require `activationExpiresAt > activationLiveAt`. */
  activationLiveAt?: Date | undefined;
  /** Require `activationExpiresAt <= activationLapsedAt` (or null). */
  activationLapsedAt?: Date | undefined;
  /** Require `expiresAt IS NULL OR expiresAt > notExpiredAt`. */
  notExpiredAt?: Date | undefined;
  /** Require `expiresAt <= expiredAt`. */
  expiredAt?: Date | undefined;
}

export interface VoucherListFilter {
  userId?: string | undefined;
  /**
   * Effective statuses at `at` (see effectiveVoucherStatus), any of them matches: `active`
   * means a live activation, `issued` includes lapsed activations, `expired` includes live rows
   * past `expiresAt`. Undefined or empty means every status.
   */
  statuses?: readonly VoucherStatus[] | undefined;
  at: Date;
  kind?: VoucherKind | undefined;
  tenantId?: string | undefined;
  sourceType?: VoucherSourceType | undefined;
}

export interface LiveVoucherFilter {
  userId?: string | undefined;
  kind?: VoucherKind | undefined;
  /** Matches `meta.eventId` (tickets of one event). */
  metaEventId?: string | undefined;
}

export interface NewValidatorDevice {
  id: string;
  tenantId: string | null;
  name: string;
  pinHash: string;
  deviceKeyHash: string;
  active: boolean;
  createdAt: Date;
}

export type ValidatorDevicePatch = Partial<
  Pick<
    ValidatorDevice,
    | 'tenantId'
    | 'name'
    | 'pinHash'
    | 'deviceKeyHash'
    | 'active'
    | 'lastSeenAt'
    | 'revokedAt'
    | 'failedPinAttempts'
    | 'pinLockedUntil'
  >
>;

/** Effective-status counts of a member's vouchers (GET /vouchers/summary). */
export type VoucherStatusCounts = Record<VoucherStatus, number>;

export interface DeviceListFilter {
  tenantId?: string | undefined;
  active?: boolean | undefined;
}

export interface NewRedemptionLog {
  id: string;
  voucherId: string | null;
  validatorDeviceId: string | null;
  method: 'code' | 'token';
  codeTried: string | null;
  outcome: RedeemOutcome;
  message: string | null;
  ip: string | null;
  createdAt: Date;
}

export interface RedemptionLogFilter {
  deviceId?: string | undefined;
  voucherId?: string | undefined;
}

export type RedemptionLogWithVoucher = VoucherRedemptionLog & {
  voucher: Pick<Voucher, 'id' | 'title' | 'kind'> | null;
};

export abstract class RewardsRepository {
  // --- rewards -------------------------------------------------------------------------------
  abstract listRewards(
    db: DbClient,
    filter: RewardListFilter,
    page: PageRequest<SortOrderCursor>,
  ): Promise<Reward[]>;
  abstract findRewardById(db: DbClient, id: string): Promise<Reward | null>;
  /** Row lock (SELECT ... FOR UPDATE) that serialises redemptions of one reward. */
  abstract lockReward(db: DbClient, id: string): Promise<void>;
  abstract createReward(db: DbClient, data: NewReward): Promise<Reward>;
  abstract updateReward(db: DbClient, id: string, patch: RewardPatch): Promise<Reward>;
  /** Decrements limited stock; true when the reward is unlimited or a unit was taken. */
  abstract takeRewardStock(db: DbClient, id: string): Promise<boolean>;
  abstract returnRewardStock(db: DbClient, id: string): Promise<void>;

  // --- redemptions ---------------------------------------------------------------------------
  /** Non-cancelled redemptions (created, issued) of the member for the reward. */
  abstract countUserRedemptions(db: DbClient, userId: string, rewardId: string): Promise<number>;
  abstract countUserRedemptionsForRewards(
    db: DbClient,
    userId: string,
    rewardIds: readonly string[],
  ): Promise<Map<string, number>>;
  abstract createRedemption(db: DbClient, data: NewRedemption): Promise<Redemption>;
  abstract updateRedemption(db: DbClient, id: string, patch: RedemptionPatch): Promise<Redemption>;
  abstract findRedemptionByVoucherId(db: DbClient, voucherId: string): Promise<Redemption | null>;

  // --- vouchers ------------------------------------------------------------------------------
  /**
   * Inserts the voucher unless one with the same (sourceType, sourceId, kind) exists: the partial
   * unique index `vouchers_source_kind_key` makes the insert ON CONFLICT DO NOTHING, so a
   * concurrent duplicate returns null instead of aborting the caller's transaction.
   */
  abstract createVoucher(db: DbClient, data: NewVoucher): Promise<Voucher | null>;
  abstract findVoucherById(db: DbClient, id: string): Promise<Voucher | null>;
  /**
   * `SELECT ... FOR UPDATE` on the voucher row, then reads it under the lock (null when it does
   * not exist). Activation and cancellation start with it, so they serialise per voucher.
   */
  abstract lockVoucher(db: DbClient, id: string): Promise<Voucher | null>;
  abstract findVoucherBySource(
    db: DbClient,
    sourceType: VoucherSourceType,
    sourceId: string,
    kind: VoucherKind,
  ): Promise<Voucher | null>;
  /** A voucher in `issued` or `active` state holding this code (the partial unique index scope). */
  abstract findLiveVoucherByCode(db: DbClient, code: string): Promise<Voucher | null>;
  abstract updateVoucher(db: DbClient, id: string, patch: VoucherPatch): Promise<Voucher>;
  /** Conditional update; returns the number of rows changed (0 or 1). */
  abstract updateVoucherIf(
    db: DbClient,
    condition: VoucherCondition,
    patch: VoucherPatch,
  ): Promise<number>;
  abstract listVouchers(
    db: DbClient,
    filter: VoucherListFilter,
    page: PageRequest<CreatedAtCursor>,
  ): Promise<Voucher[]>;
  abstract listVouchersBySource(
    db: DbClient,
    sourceType: VoucherSourceType,
    sourceId: string,
  ): Promise<Voucher[]>;
  abstract listLiveVouchers(
    db: DbClient,
    filter: LiveVoucherFilter,
    limit: number,
  ): Promise<Voucher[]>;
  /** Live vouchers whose activation lapsed or whose expiresAt passed, oldest first. */
  abstract findSweepCandidates(db: DbClient, now: Date, limit: number): Promise<Voucher[]>;
  abstract countVouchersIssued(db: DbClient, range: DateRange): Promise<number>;
  abstract countVouchersRedeemed(db: DbClient, range: DateRange): Promise<number>;
  /** Vouchers in `issued` or `active` state created before `at`. */
  abstract countVouchersLive(db: DbClient, at: Date): Promise<number>;
  /** Effective status counts of one member's vouchers at `at`. */
  abstract countUserVouchersByStatus(
    db: DbClient,
    userId: string,
    at: Date,
  ): Promise<VoucherStatusCounts>;

  // --- validator devices ---------------------------------------------------------------------
  abstract findDeviceById(db: DbClient, id: string): Promise<ValidatorDevice | null>;
  abstract findDeviceByKeyHash(db: DbClient, keyHash: string): Promise<ValidatorDevice | null>;
  abstract listDevices(
    db: DbClient,
    filter: DeviceListFilter,
    page: PageRequest<CreatedAtCursor>,
  ): Promise<ValidatorDevice[]>;
  abstract createDevice(db: DbClient, data: NewValidatorDevice): Promise<ValidatorDevice>;
  abstract updateDevice(
    db: DbClient,
    id: string,
    patch: ValidatorDevicePatch,
  ): Promise<ValidatorDevice>;
  /** Atomic `failed_pin_attempts = failed_pin_attempts + 1`; returns the new value. */
  abstract incrementPinFailures(db: DbClient, id: string): Promise<number>;

  // --- redemption log ------------------------------------------------------------------------
  abstract createRedemptionLog(db: DbClient, data: NewRedemptionLog): Promise<VoucherRedemptionLog>;
  abstract listRedemptionLogs(
    db: DbClient,
    filter: RedemptionLogFilter,
    page: PageRequest<CreatedAtCursor>,
  ): Promise<RedemptionLogWithVoucher[]>;
}
