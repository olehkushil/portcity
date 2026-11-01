import { Injectable } from '@nestjs/common';
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
  type VoucherStatus,
} from '../../../common/contracts/rewards';
import type { DateRange } from '../../../common/contracts/shared';
import type { DbClient } from '../../../common/prisma/prisma.service';
import type { CreatedAtCursor, SortOrderCursor } from '../domain/cursors';
import { VOUCHER_LIVE_STATUSES } from '../domain/voucher-state';
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
} from './rewards.repository';

const LIVE: VoucherStatus[] = [...VOUCHER_LIVE_STATUSES];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createdAtCursorWhere(cursor: CreatedAtCursor | undefined): Prisma.VoucherWhereInput[] {
  if (!cursor) {
    return [];
  }
  const createdAt = new Date(cursor.createdAt);
  return [{ OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }] }];
}

function metaJson(meta: Record<string, unknown>): Prisma.InputJsonObject {
  // Voucher.meta is free-form JSON by contract; callers pass plain objects.
  return JSON.parse(JSON.stringify(meta)) as Prisma.InputJsonObject;
}

/** Translates an effective-status filter into stored-column predicates. */
function effectiveStatusWhere(status: VoucherStatus, at: Date): Prisma.VoucherWhereInput {
  const notExpired: Prisma.VoucherWhereInput = {
    OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
  };
  switch (status) {
    case 'active':
      return { AND: [{ status: 'active', activationExpiresAt: { gt: at } }, notExpired] };
    case 'issued':
      return {
        AND: [
          {
            OR: [
              { status: 'issued' },
              { status: 'active', activationExpiresAt: null },
              { status: 'active', activationExpiresAt: { lte: at } },
            ],
          },
          notExpired,
        ],
      };
    case 'expired':
      return { OR: [{ status: 'expired' }, { status: { in: LIVE }, expiresAt: { lte: at } }] };
    case 'redeemed':
    case 'cancelled':
      return { status };
  }
}

@Injectable()
export class PrismaRewardsRepository extends RewardsRepository {
  // --- rewards -------------------------------------------------------------------------------

  async listRewards(
    db: DbClient,
    filter: RewardListFilter,
    page: PageRequest<SortOrderCursor>,
  ): Promise<Reward[]> {
    const and: Prisma.RewardWhereInput[] = [];
    if (filter.active !== undefined) {
      and.push({ active: filter.active });
    }
    if (filter.kind !== undefined) {
      and.push({ kind: filter.kind });
    }
    if (filter.tenantId !== undefined) {
      and.push({ tenantId: filter.tenantId });
    }
    if (filter.maxCostPoints !== undefined) {
      and.push({ costPoints: { lte: filter.maxCostPoints } });
    }
    if (filter.listedAt !== undefined) {
      and.push(
        { active: true },
        { OR: [{ validFrom: null }, { validFrom: { lte: filter.listedAt } }] },
        { OR: [{ validTo: null }, { validTo: { gt: filter.listedAt } }] },
      );
    }
    if (page.cursor) {
      and.push({
        OR: [
          { sortOrder: { gt: page.cursor.sortOrder } },
          { sortOrder: page.cursor.sortOrder, id: { gt: page.cursor.id } },
        ],
      });
    }
    return db.reward.findMany({
      where: and.length > 0 ? { AND: and } : undefined,
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      take: page.limit + 1,
    });
  }

  findRewardById(db: DbClient, id: string): Promise<Reward | null> {
    return db.reward.findUnique({ where: { id } });
  }

  async lockReward(db: DbClient, id: string): Promise<void> {
    await db.$queryRaw`SELECT id FROM rewards WHERE id = ${id}::uuid FOR UPDATE`;
  }

  createReward(db: DbClient, data: NewReward): Promise<Reward> {
    return db.reward.create({ data });
  }

  updateReward(db: DbClient, id: string, patch: RewardPatch): Promise<Reward> {
    return db.reward.update({ where: { id }, data: patch });
  }

  async takeRewardStock(db: DbClient, id: string): Promise<boolean> {
    const reward = await db.reward.findUnique({ where: { id }, select: { stock: true } });
    if (!reward) {
      return false;
    }
    if (reward.stock === null) {
      return true;
    }
    const result = await db.reward.updateMany({
      where: { id, stock: { gt: 0 } },
      data: { stock: { decrement: 1 } },
    });
    return result.count === 1;
  }

  async returnRewardStock(db: DbClient, id: string): Promise<void> {
    await db.reward.updateMany({
      where: { id, stock: { not: null } },
      data: { stock: { increment: 1 } },
    });
  }

  // --- redemptions ---------------------------------------------------------------------------

  countUserRedemptions(db: DbClient, userId: string, rewardId: string): Promise<number> {
    return db.redemption.count({
      where: { userId, rewardId, status: { in: ['created', 'issued'] } },
    });
  }

  async countUserRedemptionsForRewards(
    db: DbClient,
    userId: string,
    rewardIds: readonly string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (rewardIds.length === 0) {
      return counts;
    }
    const groups = await db.redemption.groupBy({
      by: ['rewardId'],
      where: { userId, rewardId: { in: [...rewardIds] }, status: { in: ['created', 'issued'] } },
      _count: { _all: true },
    });
    for (const group of groups) {
      counts.set(group.rewardId, group._count._all);
    }
    return counts;
  }

  createRedemption(db: DbClient, data: NewRedemption): Promise<Redemption> {
    return db.redemption.create({ data });
  }

  updateRedemption(db: DbClient, id: string, patch: RedemptionPatch): Promise<Redemption> {
    return db.redemption.update({ where: { id }, data: patch });
  }

  findRedemptionByVoucherId(db: DbClient, voucherId: string): Promise<Redemption | null> {
    return db.redemption.findUnique({ where: { voucherId } });
  }

  // --- vouchers ------------------------------------------------------------------------------

  async createVoucher(db: DbClient, data: NewVoucher): Promise<Voucher | null> {
    // createMany + skipDuplicates = INSERT ... ON CONFLICT DO NOTHING: a duplicate on the
    // partial unique index (source_type, source_id, kind) inserts nothing and keeps the
    // surrounding transaction usable (a plain create would abort it with P2002).
    const inserted = await db.voucher.createMany({
      data: [{ ...data, meta: metaJson(data.meta) }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) {
      return null;
    }
    return db.voucher.findUnique({ where: { id: data.id } });
  }

  findVoucherById(db: DbClient, id: string): Promise<Voucher | null> {
    return db.voucher.findUnique({ where: { id } });
  }

  async lockVoucher(db: DbClient, id: string): Promise<Voucher | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM vouchers WHERE id = ${id}::uuid FOR UPDATE`;
    return rows.length === 0 ? null : db.voucher.findUnique({ where: { id } });
  }

  findVoucherBySource(
    db: DbClient,
    sourceType: VoucherSourceType,
    sourceId: string,
    kind: VoucherKind,
  ): Promise<Voucher | null> {
    return db.voucher.findFirst({
      where: { sourceType, sourceId, kind },
      orderBy: { createdAt: 'asc' },
    });
  }

  findLiveVoucherByCode(db: DbClient, code: string): Promise<Voucher | null> {
    return db.voucher.findFirst({ where: { code, status: { in: LIVE } } });
  }

  updateVoucher(db: DbClient, id: string, patch: VoucherPatch): Promise<Voucher> {
    return db.voucher.update({ where: { id }, data: toVoucherUpdate(patch) });
  }

  async updateVoucherIf(
    db: DbClient,
    condition: VoucherCondition,
    patch: VoucherPatch,
  ): Promise<number> {
    const and: Prisma.VoucherWhereInput[] = [
      { id: condition.id, status: { in: [...condition.statuses] } },
    ];
    if (condition.activationLiveAt) {
      and.push({ activationExpiresAt: { gt: condition.activationLiveAt } });
    }
    if (condition.activationLapsedAt) {
      and.push({
        OR: [
          { activationExpiresAt: null },
          { activationExpiresAt: { lte: condition.activationLapsedAt } },
        ],
      });
    }
    if (condition.notExpiredAt) {
      and.push({ OR: [{ expiresAt: null }, { expiresAt: { gt: condition.notExpiredAt } }] });
    }
    if (condition.expiredAt) {
      and.push({ expiresAt: { lte: condition.expiredAt } });
    }
    const result = await db.voucher.updateMany({
      where: { AND: and },
      data: toVoucherUpdate(patch),
    });
    return result.count;
  }

  listVouchers(
    db: DbClient,
    filter: VoucherListFilter,
    page: PageRequest<CreatedAtCursor>,
  ): Promise<Voucher[]> {
    const and: Prisma.VoucherWhereInput[] = [];
    if (filter.userId !== undefined) {
      and.push({ userId: filter.userId });
    }
    if (filter.kind !== undefined) {
      and.push({ kind: filter.kind });
    }
    if (filter.tenantId !== undefined) {
      and.push({ tenantId: filter.tenantId });
    }
    if (filter.sourceType !== undefined) {
      and.push({ sourceType: filter.sourceType });
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      const statuses = [...new Set(filter.statuses)];
      and.push(
        statuses.length === 1
          ? effectiveStatusWhere(statuses[0] as VoucherStatus, filter.at)
          : { OR: statuses.map((status) => effectiveStatusWhere(status, filter.at)) },
      );
    }
    and.push(...createdAtCursorWhere(page.cursor));
    return db.voucher.findMany({
      where: and.length > 0 ? { AND: and } : undefined,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
    });
  }

  listVouchersBySource(
    db: DbClient,
    sourceType: VoucherSourceType,
    sourceId: string,
  ): Promise<Voucher[]> {
    return db.voucher.findMany({
      where: { sourceType, sourceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  listLiveVouchers(db: DbClient, filter: LiveVoucherFilter, limit: number): Promise<Voucher[]> {
    const where: Prisma.VoucherWhereInput = { status: { in: LIVE } };
    if (filter.userId !== undefined) {
      where.userId = filter.userId;
    }
    if (filter.kind !== undefined) {
      where.kind = filter.kind;
    }
    if (filter.metaEventId !== undefined) {
      where.meta = { path: ['eventId'], equals: filter.metaEventId };
    }
    return db.voucher.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  }

  findSweepCandidates(db: DbClient, now: Date, limit: number): Promise<Voucher[]> {
    return db.voucher.findMany({
      where: {
        OR: [
          { status: 'active', activationExpiresAt: { lte: now } },
          { status: 'active', activationExpiresAt: null },
          { status: { in: LIVE }, expiresAt: { lte: now } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  }

  countVouchersIssued(db: DbClient, range: DateRange): Promise<number> {
    return db.voucher.count({ where: { createdAt: { gte: range.from, lt: range.to } } });
  }

  countVouchersRedeemed(db: DbClient, range: DateRange): Promise<number> {
    return db.voucher.count({
      where: { status: 'redeemed', redeemedAt: { gte: range.from, lt: range.to } },
    });
  }

  countVouchersLive(db: DbClient, at: Date): Promise<number> {
    return db.voucher.count({ where: { status: { in: LIVE }, createdAt: { lt: at } } });
  }

  async countUserVouchersByStatus(
    db: DbClient,
    userId: string,
    at: Date,
  ): Promise<VoucherStatusCounts> {
    // One count per effective status (index vouchers(user_id, status)); five cheap queries.
    const counts = await Promise.all(
      VOUCHER_STATUSES.map((status) =>
        db.voucher.count({ where: { AND: [{ userId }, effectiveStatusWhere(status, at)] } }),
      ),
    );
    const result = Object.fromEntries(
      VOUCHER_STATUSES.map((status) => [status, 0]),
    ) as VoucherStatusCounts;
    VOUCHER_STATUSES.forEach((status, index) => {
      result[status] = counts[index] ?? 0;
    });
    return result;
  }

  // --- validator devices ---------------------------------------------------------------------

  findDeviceById(db: DbClient, id: string): Promise<ValidatorDevice | null> {
    return db.validatorDevice.findUnique({ where: { id } });
  }

  findDeviceByKeyHash(db: DbClient, keyHash: string): Promise<ValidatorDevice | null> {
    return db.validatorDevice.findUnique({ where: { deviceKeyHash: keyHash } });
  }

  listDevices(
    db: DbClient,
    filter: DeviceListFilter,
    page: PageRequest<CreatedAtCursor>,
  ): Promise<ValidatorDevice[]> {
    const and: Prisma.ValidatorDeviceWhereInput[] = [];
    if (filter.tenantId !== undefined) {
      and.push({ tenantId: filter.tenantId });
    }
    if (filter.active !== undefined) {
      and.push({ active: filter.active });
    }
    if (page.cursor) {
      const createdAt = new Date(page.cursor.createdAt);
      and.push({
        OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: page.cursor.id } }],
      });
    }
    return db.validatorDevice.findMany({
      where: and.length > 0 ? { AND: and } : undefined,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
    });
  }

  createDevice(db: DbClient, data: NewValidatorDevice): Promise<ValidatorDevice> {
    return db.validatorDevice.create({ data });
  }

  updateDevice(db: DbClient, id: string, patch: ValidatorDevicePatch): Promise<ValidatorDevice> {
    return db.validatorDevice.update({ where: { id }, data: patch });
  }

  async incrementPinFailures(db: DbClient, id: string): Promise<number> {
    const updated = await db.validatorDevice.update({
      where: { id },
      data: { failedPinAttempts: { increment: 1 } },
      select: { failedPinAttempts: true },
    });
    return updated.failedPinAttempts;
  }

  // --- redemption log ------------------------------------------------------------------------

  createRedemptionLog(db: DbClient, data: NewRedemptionLog): Promise<VoucherRedemptionLog> {
    return db.voucherRedemptionLog.create({ data });
  }

  listRedemptionLogs(
    db: DbClient,
    filter: RedemptionLogFilter,
    page: PageRequest<CreatedAtCursor>,
  ): Promise<RedemptionLogWithVoucher[]> {
    const and: Prisma.VoucherRedemptionLogWhereInput[] = [];
    if (filter.deviceId !== undefined) {
      and.push({ validatorDeviceId: filter.deviceId });
    }
    if (filter.voucherId !== undefined) {
      and.push({ voucherId: filter.voucherId });
    }
    if (page.cursor) {
      const createdAt = new Date(page.cursor.createdAt);
      and.push({
        OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: page.cursor.id } }],
      });
    }
    return db.voucherRedemptionLog.findMany({
      where: and.length > 0 ? { AND: and } : undefined,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
      include: { voucher: { select: { id: true, title: true, kind: true } } },
    });
  }
}

function toVoucherUpdate(patch: VoucherPatch): Prisma.VoucherUncheckedUpdateInput {
  const { meta, ...rest } = patch;
  const data: Prisma.VoucherUncheckedUpdateInput = { ...rest };
  if (meta !== undefined) {
    data.meta = metaJson(meta);
  }
  return data;
}
