import {
  Prisma,
  type Redemption,
  type Reward,
  type ValidatorDevice,
  type Voucher,
  type VoucherRedemptionLog,
} from '@prisma/client';
import {
  VOUCHER_STATUSES,
  type VoucherKind,
  type VoucherSourceType,
} from '../../../src/common/contracts/rewards';
import type { DateRange } from '../../../src/common/contracts/shared';
import type { DbClient } from '../../../src/common/prisma/prisma.service';
import {
  type CreatedAtCursor,
  type SortOrderCursor,
  compareCreatedAtDesc,
  compareSortOrderAsc,
  isAfterCreatedAtCursor,
  isAfterSortOrderCursor,
} from '../../../src/modules/rewards/domain/cursors';
import {
  effectiveVoucherStatus,
  isLiveVoucherStatus,
} from '../../../src/modules/rewards/domain/voucher-state';
import {
  type DeviceListFilter,
  type LiveVoucherFilter,
  type NewRedemption,
  type NewRedemptionLog,
  type NewReward,
  type NewValidatorDevice,
  type NewVoucher,
  type PageRequest,
  type RedemptionLogFilter,
  type RedemptionLogWithVoucher,
  type RedemptionPatch,
  type RewardListFilter,
  type RewardPatch,
  RewardsRepository,
  type ValidatorDevicePatch,
  type VoucherCondition,
  type VoucherListFilter,
  type VoucherPatch,
  type VoucherStatusCounts,
} from '../../../src/modules/rewards/services/rewards.repository';

/** Something whose state can be captured before a fake transaction and restored on rollback. */
export interface Transactional {
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

interface RepositoryState {
  rewards: Map<string, Reward>;
  redemptions: Map<string, Redemption>;
  vouchers: Map<string, Voucher>;
  devices: Map<string, ValidatorDevice>;
  logs: VoucherRedemptionLog[];
}

export function prismaKnownError(
  code: string,
  message: string,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });
}

function time(date: Date | null): number | null {
  return date === null ? null : date.getTime();
}

function plainMeta(meta: Record<string, unknown>): Prisma.JsonObject {
  return JSON.parse(JSON.stringify(meta)) as Prisma.JsonObject;
}

/**
 * In-memory RewardsRepository with the same semantics as PrismaRewardsRepository:
 * cursor pages fetch `limit + 1` rows, effective-status filters follow effectiveVoucherStatus,
 * conditional updates return the number of changed rows, the partial unique index on live
 * voucher codes and the unique device key hash raise P2002, missing rows raise P2025.
 * Snapshots let the fake Prisma client roll a transaction back.
 */
export class InMemoryRewardsRepository extends RewardsRepository implements Transactional {
  private state: RepositoryState = {
    rewards: new Map(),
    redemptions: new Map(),
    vouchers: new Map(),
    devices: new Map(),
    logs: [],
  };

  /** Number of upcoming code writes that fail with P2002 (simulates a lost race on the index). */
  codeWriteConflicts = 0;
  /** Database clients received by the last call, for "same transaction" assertions. */
  readonly clients: DbClient[] = [];
  /**
   * Row locks taken (`voucher:<id>`, `reward:<id>`) in call order. RewardsWorld shares the array
   * with the fake ledger (`ledger.reverse`, `ledger.spend`) to assert the lock order.
   */
  callLog: string[] = [];
  /**
   * One-shot stale read: the next lockVoucher() of this voucher returns this snapshot instead
   * of the current row. Tests commit a concurrent change first and then let the service work
   * from the row it would have read before that change (the read/write interleaving), without
   * the fake transaction rollback undoing the concurrent change.
   */
  private staleLockRead: Voucher | null = null;

  serveStaleLockRead(snapshot: Voucher): void {
    this.staleLockRead = structuredClone(snapshot);
  }

  constructor(private readonly now: () => Date = () => new Date()) {
    super();
  }

  // --- test helpers --------------------------------------------------------------------------

  snapshot(): unknown {
    return structuredClone(this.state);
  }

  restore(snapshot: unknown): void {
    this.state = structuredClone(snapshot as RepositoryState);
  }

  get rewards(): Reward[] {
    return [...this.state.rewards.values()];
  }

  get redemptions(): Redemption[] {
    return [...this.state.redemptions.values()];
  }

  get vouchers(): Voucher[] {
    return [...this.state.vouchers.values()];
  }

  get devices(): ValidatorDevice[] {
    return [...this.state.devices.values()];
  }

  get logs(): VoucherRedemptionLog[] {
    return [...this.state.logs];
  }

  voucher(id: string): Voucher | undefined {
    return this.state.vouchers.get(id);
  }

  reward(id: string): Reward | undefined {
    return this.state.rewards.get(id);
  }

  device(id: string): ValidatorDevice | undefined {
    return this.state.devices.get(id);
  }

  /** Inserts or replaces rows directly (seeding). */
  putReward(reward: Reward): void {
    this.state.rewards.set(reward.id, structuredClone(reward));
  }

  putVoucher(voucher: Voucher): void {
    this.state.vouchers.set(voucher.id, structuredClone(voucher));
  }

  putDevice(device: ValidatorDevice): void {
    this.state.devices.set(device.id, structuredClone(device));
  }

  putRedemption(redemption: Redemption): void {
    this.state.redemptions.set(redemption.id, structuredClone(redemption));
  }

  private track(db: DbClient): void {
    this.clients.push(db);
  }

  // --- rewards -------------------------------------------------------------------------------

  async listRewards(
    db: DbClient,
    filter: RewardListFilter,
    page: PageRequest<SortOrderCursor>,
  ): Promise<Reward[]> {
    this.track(db);
    const listedAt = filter.listedAt;
    return this.rewards
      .filter((reward) => filter.active === undefined || reward.active === filter.active)
      .filter((reward) => filter.kind === undefined || reward.kind === filter.kind)
      .filter((reward) => filter.tenantId === undefined || reward.tenantId === filter.tenantId)
      .filter(
        (reward) => filter.maxCostPoints === undefined || reward.costPoints <= filter.maxCostPoints,
      )
      .filter(
        (reward) =>
          listedAt === undefined ||
          (reward.active &&
            (reward.validFrom === null || reward.validFrom.getTime() <= listedAt.getTime()) &&
            (reward.validTo === null || reward.validTo.getTime() > listedAt.getTime())),
      )
      .filter((reward) => !page.cursor || isAfterSortOrderCursor(reward, page.cursor))
      .sort(compareSortOrderAsc)
      .slice(0, page.limit + 1)
      .map((reward) => structuredClone(reward));
  }

  async findRewardById(db: DbClient, id: string): Promise<Reward | null> {
    this.track(db);
    const reward = this.state.rewards.get(id);
    return reward ? structuredClone(reward) : null;
  }

  async lockReward(db: DbClient, id: string): Promise<void> {
    this.track(db);
    this.callLog.push(`reward:${id}`);
  }

  async createReward(db: DbClient, data: NewReward): Promise<Reward> {
    this.track(db);
    const reward: Reward = { ...data, updatedAt: this.now() };
    this.state.rewards.set(reward.id, reward);
    return structuredClone(reward);
  }

  async updateReward(db: DbClient, id: string, patch: RewardPatch): Promise<Reward> {
    this.track(db);
    const current = this.state.rewards.get(id);
    if (!current) {
      throw prismaKnownError('P2025', `Reward ${id} not found`);
    }
    const updated: Reward = { ...current, ...patch, updatedAt: this.now() };
    this.state.rewards.set(id, updated);
    return structuredClone(updated);
  }

  async takeRewardStock(db: DbClient, id: string): Promise<boolean> {
    this.track(db);
    const reward = this.state.rewards.get(id);
    if (!reward) {
      return false;
    }
    if (reward.stock === null) {
      return true;
    }
    if (reward.stock <= 0) {
      return false;
    }
    reward.stock -= 1;
    return true;
  }

  async returnRewardStock(db: DbClient, id: string): Promise<void> {
    this.track(db);
    const reward = this.state.rewards.get(id);
    if (reward && reward.stock !== null) {
      reward.stock += 1;
    }
  }

  // --- redemptions ---------------------------------------------------------------------------

  async countUserRedemptions(db: DbClient, userId: string, rewardId: string): Promise<number> {
    this.track(db);
    return this.redemptions.filter(
      (row) =>
        row.userId === userId &&
        row.rewardId === rewardId &&
        (row.status === 'created' || row.status === 'issued'),
    ).length;
  }

  async countUserRedemptionsForRewards(
    db: DbClient,
    userId: string,
    rewardIds: readonly string[],
  ): Promise<Map<string, number>> {
    this.track(db);
    const counts = new Map<string, number>();
    for (const row of this.redemptions) {
      if (
        row.userId === userId &&
        rewardIds.includes(row.rewardId) &&
        (row.status === 'created' || row.status === 'issued')
      ) {
        counts.set(row.rewardId, (counts.get(row.rewardId) ?? 0) + 1);
      }
    }
    return counts;
  }

  async createRedemption(db: DbClient, data: NewRedemption): Promise<Redemption> {
    this.track(db);
    const redemption: Redemption = { ...data, updatedAt: this.now() };
    this.state.redemptions.set(redemption.id, redemption);
    return structuredClone(redemption);
  }

  async updateRedemption(db: DbClient, id: string, patch: RedemptionPatch): Promise<Redemption> {
    this.track(db);
    const current = this.state.redemptions.get(id);
    if (!current) {
      throw prismaKnownError('P2025', `Redemption ${id} not found`);
    }
    const updated: Redemption = { ...current, ...patch, updatedAt: this.now() };
    this.state.redemptions.set(id, updated);
    return structuredClone(updated);
  }

  async findRedemptionByVoucherId(db: DbClient, voucherId: string): Promise<Redemption | null> {
    this.track(db);
    const found = this.redemptions.find((row) => row.voucherId === voucherId);
    return found ? structuredClone(found) : null;
  }

  // --- vouchers ------------------------------------------------------------------------------

  private assertCodeFree(candidate: Voucher): void {
    if (candidate.code === null || !isLiveVoucherStatus(candidate.status)) {
      return;
    }
    for (const other of this.state.vouchers.values()) {
      if (
        other.id !== candidate.id &&
        other.code === candidate.code &&
        isLiveVoucherStatus(other.status)
      ) {
        throw prismaKnownError('P2002', 'Unique constraint failed on vouchers_code_live_key');
      }
    }
  }

  private applyVoucherPatch(current: Voucher, patch: VoucherPatch): Voucher {
    const { meta, ...rest } = patch;
    const updated: Voucher = { ...current, ...rest, updatedAt: this.now() };
    if (meta !== undefined) {
      updated.meta = plainMeta(meta);
    }
    if (patch.code !== undefined && patch.code !== null && this.codeWriteConflicts > 0) {
      this.codeWriteConflicts -= 1;
      throw prismaKnownError('P2002', 'Unique constraint failed on vouchers_code_live_key');
    }
    this.assertCodeFree(updated);
    return updated;
  }

  async createVoucher(db: DbClient, data: NewVoucher): Promise<Voucher | null> {
    this.track(db);
    // ON CONFLICT DO NOTHING on the partial unique index (source_type, source_id, kind).
    if (
      data.sourceId !== null &&
      this.vouchers.some(
        (row) =>
          row.sourceType === data.sourceType &&
          row.sourceId === data.sourceId &&
          row.kind === data.kind,
      )
    ) {
      return null;
    }
    const voucher: Voucher = {
      ...data,
      meta: plainMeta(data.meta),
      code: null,
      tokenHash: null,
      activatedAt: null,
      activationExpiresAt: null,
      redeemedAt: null,
      redeemedByDeviceId: null,
      redeemedByTenantId: null,
      updatedAt: this.now(),
    };
    this.state.vouchers.set(voucher.id, voucher);
    return structuredClone(voucher);
  }

  async findVoucherById(db: DbClient, id: string): Promise<Voucher | null> {
    this.track(db);
    const voucher = this.state.vouchers.get(id);
    return voucher ? structuredClone(voucher) : null;
  }

  async lockVoucher(db: DbClient, id: string): Promise<Voucher | null> {
    this.track(db);
    this.callLog.push(`voucher:${id}`);
    if (this.staleLockRead?.id === id) {
      const stale = this.staleLockRead;
      this.staleLockRead = null;
      return stale;
    }
    const voucher = this.state.vouchers.get(id);
    return voucher ? structuredClone(voucher) : null;
  }

  async findVoucherBySource(
    db: DbClient,
    sourceType: VoucherSourceType,
    sourceId: string,
    kind: VoucherKind,
  ): Promise<Voucher | null> {
    this.track(db);
    const found = this.vouchers
      .filter(
        (row) => row.sourceType === sourceType && row.sourceId === sourceId && row.kind === kind,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    return found ? structuredClone(found) : null;
  }

  async findLiveVoucherByCode(db: DbClient, code: string): Promise<Voucher | null> {
    this.track(db);
    const found = this.vouchers.find((row) => row.code === code && isLiveVoucherStatus(row.status));
    return found ? structuredClone(found) : null;
  }

  async updateVoucher(db: DbClient, id: string, patch: VoucherPatch): Promise<Voucher> {
    this.track(db);
    const current = this.state.vouchers.get(id);
    if (!current) {
      throw prismaKnownError('P2025', `Voucher ${id} not found`);
    }
    const updated = this.applyVoucherPatch(current, patch);
    this.state.vouchers.set(id, updated);
    return structuredClone(updated);
  }

  private matchesCondition(voucher: Voucher, condition: VoucherCondition): boolean {
    if (voucher.id !== condition.id || !condition.statuses.includes(voucher.status)) {
      return false;
    }
    const activation = time(voucher.activationExpiresAt);
    const expires = time(voucher.expiresAt);
    if (condition.activationLiveAt) {
      if (activation === null || activation <= condition.activationLiveAt.getTime()) {
        return false;
      }
    }
    if (condition.activationLapsedAt) {
      if (activation !== null && activation > condition.activationLapsedAt.getTime()) {
        return false;
      }
    }
    if (condition.notExpiredAt) {
      if (expires !== null && expires <= condition.notExpiredAt.getTime()) {
        return false;
      }
    }
    if (condition.expiredAt) {
      if (expires === null || expires > condition.expiredAt.getTime()) {
        return false;
      }
    }
    return true;
  }

  async updateVoucherIf(
    db: DbClient,
    condition: VoucherCondition,
    patch: VoucherPatch,
  ): Promise<number> {
    this.track(db);
    const current = this.state.vouchers.get(condition.id);
    if (!current || !this.matchesCondition(current, condition)) {
      return 0;
    }
    this.state.vouchers.set(current.id, this.applyVoucherPatch(current, patch));
    return 1;
  }

  async listVouchers(
    db: DbClient,
    filter: VoucherListFilter,
    page: PageRequest<CreatedAtCursor>,
  ): Promise<Voucher[]> {
    this.track(db);
    return this.vouchers
      .filter((row) => filter.userId === undefined || row.userId === filter.userId)
      .filter((row) => filter.kind === undefined || row.kind === filter.kind)
      .filter((row) => filter.tenantId === undefined || row.tenantId === filter.tenantId)
      .filter((row) => filter.sourceType === undefined || row.sourceType === filter.sourceType)
      .filter(
        (row) =>
          filter.statuses === undefined ||
          filter.statuses.length === 0 ||
          filter.statuses.includes(effectiveVoucherStatus(row, filter.at)),
      )
      .filter((row) => !page.cursor || isAfterCreatedAtCursor(row, page.cursor))
      .sort(compareCreatedAtDesc)
      .slice(0, page.limit + 1)
      .map((row) => structuredClone(row));
  }

  async listVouchersBySource(
    db: DbClient,
    sourceType: VoucherSourceType,
    sourceId: string,
  ): Promise<Voucher[]> {
    this.track(db);
    return this.vouchers
      .filter((row) => row.sourceType === sourceType && row.sourceId === sourceId)
      .sort((a, b) => compareCreatedAtDesc(b, a))
      .map((row) => structuredClone(row));
  }

  async listLiveVouchers(
    db: DbClient,
    filter: LiveVoucherFilter,
    limit: number,
  ): Promise<Voucher[]> {
    this.track(db);
    return this.vouchers
      .filter((row) => isLiveVoucherStatus(row.status))
      .filter((row) => filter.userId === undefined || row.userId === filter.userId)
      .filter((row) => filter.kind === undefined || row.kind === filter.kind)
      .filter(
        (row) =>
          filter.metaEventId === undefined ||
          (row.meta as Record<string, unknown> | null)?.['eventId'] === filter.metaEventId,
      )
      .sort((a, b) => compareCreatedAtDesc(b, a))
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }

  async findSweepCandidates(db: DbClient, now: Date, limit: number): Promise<Voucher[]> {
    this.track(db);
    const at = now.getTime();
    return this.vouchers
      .filter((row) => {
        const activation = time(row.activationExpiresAt);
        const expires = time(row.expiresAt);
        const lapsed = row.status === 'active' && (activation === null || activation <= at);
        const expired = isLiveVoucherStatus(row.status) && expires !== null && expires <= at;
        return lapsed || expired;
      })
      .sort((a, b) => compareCreatedAtDesc(b, a))
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }

  async countVouchersIssued(db: DbClient, range: DateRange): Promise<number> {
    this.track(db);
    return this.vouchers.filter(
      (row) =>
        row.createdAt.getTime() >= range.from.getTime() &&
        row.createdAt.getTime() < range.to.getTime(),
    ).length;
  }

  async countVouchersRedeemed(db: DbClient, range: DateRange): Promise<number> {
    this.track(db);
    return this.vouchers.filter(
      (row) =>
        row.status === 'redeemed' &&
        row.redeemedAt !== null &&
        row.redeemedAt.getTime() >= range.from.getTime() &&
        row.redeemedAt.getTime() < range.to.getTime(),
    ).length;
  }

  async countVouchersLive(db: DbClient, at: Date): Promise<number> {
    this.track(db);
    return this.vouchers.filter(
      (row) => isLiveVoucherStatus(row.status) && row.createdAt.getTime() < at.getTime(),
    ).length;
  }

  async countUserVouchersByStatus(
    db: DbClient,
    userId: string,
    at: Date,
  ): Promise<VoucherStatusCounts> {
    this.track(db);
    const counts = Object.fromEntries(
      VOUCHER_STATUSES.map((status) => [status, 0]),
    ) as VoucherStatusCounts;
    for (const row of this.vouchers) {
      if (row.userId === userId) {
        counts[effectiveVoucherStatus(row, at)] += 1;
      }
    }
    return counts;
  }

  // --- validator devices ---------------------------------------------------------------------

  async findDeviceById(db: DbClient, id: string): Promise<ValidatorDevice | null> {
    this.track(db);
    const device = this.state.devices.get(id);
    return device ? structuredClone(device) : null;
  }

  async findDeviceByKeyHash(db: DbClient, keyHash: string): Promise<ValidatorDevice | null> {
    this.track(db);
    const device = this.devices.find((row) => row.deviceKeyHash === keyHash);
    return device ? structuredClone(device) : null;
  }

  async listDevices(
    db: DbClient,
    filter: DeviceListFilter,
    page: PageRequest<CreatedAtCursor>,
  ): Promise<ValidatorDevice[]> {
    this.track(db);
    return this.devices
      .filter((row) => filter.tenantId === undefined || row.tenantId === filter.tenantId)
      .filter((row) => filter.active === undefined || row.active === filter.active)
      .filter((row) => !page.cursor || isAfterCreatedAtCursor(row, page.cursor))
      .sort(compareCreatedAtDesc)
      .slice(0, page.limit + 1)
      .map((row) => structuredClone(row));
  }

  private assertKeyHashFree(candidate: ValidatorDevice): void {
    for (const other of this.state.devices.values()) {
      if (other.id !== candidate.id && other.deviceKeyHash === candidate.deviceKeyHash) {
        throw prismaKnownError('P2002', 'Unique constraint failed on device_key_hash');
      }
    }
  }

  async createDevice(db: DbClient, data: NewValidatorDevice): Promise<ValidatorDevice> {
    this.track(db);
    const device: ValidatorDevice = {
      ...data,
      lastSeenAt: null,
      revokedAt: null,
      failedPinAttempts: 0,
      pinLockedUntil: null,
      updatedAt: this.now(),
    };
    this.assertKeyHashFree(device);
    this.state.devices.set(device.id, device);
    return structuredClone(device);
  }

  async incrementPinFailures(db: DbClient, id: string): Promise<number> {
    this.track(db);
    const current = this.state.devices.get(id);
    if (!current) {
      throw prismaKnownError('P2025', `Validator device ${id} not found`);
    }
    current.failedPinAttempts += 1;
    current.updatedAt = this.now();
    return current.failedPinAttempts;
  }

  async updateDevice(
    db: DbClient,
    id: string,
    patch: ValidatorDevicePatch,
  ): Promise<ValidatorDevice> {
    this.track(db);
    const current = this.state.devices.get(id);
    if (!current) {
      throw prismaKnownError('P2025', `Validator device ${id} not found`);
    }
    const updated: ValidatorDevice = { ...current, ...patch, updatedAt: this.now() };
    this.assertKeyHashFree(updated);
    this.state.devices.set(id, updated);
    return structuredClone(updated);
  }

  // --- redemption log ------------------------------------------------------------------------

  async createRedemptionLog(db: DbClient, data: NewRedemptionLog): Promise<VoucherRedemptionLog> {
    this.track(db);
    const row: VoucherRedemptionLog = { ...data };
    this.state.logs.push(row);
    return structuredClone(row);
  }

  async listRedemptionLogs(
    db: DbClient,
    filter: RedemptionLogFilter,
    page: PageRequest<CreatedAtCursor>,
  ): Promise<RedemptionLogWithVoucher[]> {
    this.track(db);
    return this.logs
      .filter((row) => filter.deviceId === undefined || row.validatorDeviceId === filter.deviceId)
      .filter((row) => filter.voucherId === undefined || row.voucherId === filter.voucherId)
      .filter((row) => !page.cursor || isAfterCreatedAtCursor(row, page.cursor))
      .sort(compareCreatedAtDesc)
      .slice(0, page.limit + 1)
      .map((row) => {
        const voucher = row.voucherId ? this.state.vouchers.get(row.voucherId) : undefined;
        return {
          ...structuredClone(row),
          voucher: voucher ? { id: voucher.id, title: voucher.title, kind: voucher.kind } : null,
        };
      });
  }
}
