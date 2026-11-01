import { Injectable } from '@nestjs/common';
import {
  type LoyaltyAccount,
  type LoyaltyRuleSet,
  type PointsTransaction,
  Prisma,
} from '@prisma/client';
import type { PointsCounterparty, PointsTxState } from '../../../common/contracts/club';
import { type DbClient, PrismaService, type Tx } from '../../../common/prisma/prisma.service';
import { dateToDayKey, dayKeyToDate } from '../domain/expiry';
import { AVAILABLE_SUM_STATES } from '../domain/points-state';
import { parseExpiryReminderState } from '../domain/reminders';
import { parseWelcomeState } from '../domain/welcome';
import {
  type AccountPatch,
  type AccountPeriodTotals,
  type AccountRecord,
  type AmountSumFilter,
  type BucketCursor,
  type BucketRecord,
  type BucketWithOwner,
  ClubRepository,
  type CreateAccountInput,
  type EntryListFilter,
  type EntryRecord,
  type RuleSetPatch,
  type RuleSetRecord,
  type SpendAllocationRecord,
} from './club.repository';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EntryRow = PointsTransaction & { account: { userId: string } };
type BucketRow = { accountId: string; expiresOn: Date; remaining: number };

const ENTRY_INCLUDE = { account: { select: { userId: true } } } as const;

function toAccount(row: LoyaltyAccount): AccountRecord {
  return {
    id: row.id,
    userId: row.userId,
    availableBalance: row.availableBalance,
    pendingBalance: row.pendingBalance,
    lifetimeEarned: row.lifetimeEarned,
    newcomerLockUntil: row.newcomerLockUntil,
    welcomeState: parseWelcomeState(row.welcomeState),
    expiryReminders: parseExpiryReminderState(row.expiryReminders),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEntry(row: EntryRow): EntryRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    userId: row.account.userId,
    type: row.type,
    state: row.state,
    amount: row.amount,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    idempotencyKey: row.idempotencyKey,
    availableAt: row.availableAt,
    expiresAt: row.expiresAt,
    reason: row.reason,
    createdById: row.createdById,
    createdAt: row.createdAt,
    title: row.title,
    subtitle: row.subtitle,
    counterparty: parseCounterparty(row.counterparty),
  };
}

const COUNTERPARTY_STRING_FIELDS = [
  'tenantId',
  'tenantName',
  'receiptId',
  'rewardId',
  'rewardTitle',
  'voucherId',
] as const;

/** Reads the jsonb back defensively: only known fields with the right types survive. */
export function parseCounterparty(json: unknown): PointsCounterparty | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return null;
  }
  const source = json as Record<string, unknown>;
  const result: PointsCounterparty = {};
  for (const field of COUNTERPARTY_STRING_FIELDS) {
    const value = source[field];
    if (typeof value === 'string') {
      result[field] = value;
    }
  }
  const total = source['receiptTotalKopecks'];
  if (typeof total === 'number' && Number.isSafeInteger(total)) {
    result.receiptTotalKopecks = total;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function toBucket(row: BucketRow): BucketRecord {
  return {
    accountId: row.accountId,
    dayKey: dateToDayKey(row.expiresOn),
    remaining: row.remaining,
  };
}

function toBucketWithOwner(row: BucketRow & { account: { userId: string } }): BucketWithOwner {
  return { ...toBucket(row), userId: row.account.userId };
}

function toRuleSet(row: LoyaltyRuleSet): RuleSetRecord {
  return {
    id: row.id,
    version: row.version,
    activeFrom: row.activeFrom,
    config: row.config,
    note: row.note,
    createdById: row.createdById,
    createdAt: row.createdAt,
  };
}

/** jsonb columns accept plain objects; the cast documents the escape hatch. */
function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

/**
 * Prisma implementation of the club persistence boundary. Row locks use raw SQL
 * (`SELECT ... FOR UPDATE`), account creation uses `INSERT ... ON CONFLICT DO NOTHING` so two
 * concurrent first credits never poison a transaction with a unique violation.
 */
@Injectable()
export class PrismaClubRepository extends ClubRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  private db(tx?: Tx): DbClient {
    return tx ?? this.prisma;
  }

  inTx<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.runInTx(tx, fn);
  }

  // --- accounts -----------------------------------------------------------------------------

  async createAccountIfMissing(tx: Tx, input: CreateAccountInput): Promise<boolean> {
    const inserted = await tx.$executeRaw`
      INSERT INTO loyalty_accounts (id, user_id, newcomer_lock_until, created_at, updated_at)
      VALUES (${input.id}::uuid, ${input.userId}::uuid, ${input.newcomerLockUntil}, ${input.now}, ${input.now})
      ON CONFLICT (user_id) DO NOTHING`;
    return inserted === 1;
  }

  async lockAccount(tx: Tx, accountId: string): Promise<AccountRecord | null> {
    if (!UUID_PATTERN.test(accountId)) {
      return null;
    }
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM loyalty_accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
    return rows.length === 0 ? null : this.findAccountById(accountId, tx);
  }

  async lockAccountByUserId(tx: Tx, userId: string): Promise<AccountRecord | null> {
    if (!UUID_PATTERN.test(userId)) {
      return null;
    }
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM loyalty_accounts WHERE user_id = ${userId}::uuid FOR UPDATE`;
    const id = rows[0]?.id;
    return id === undefined ? null : this.findAccountById(id, tx);
  }

  async findAccountById(accountId: string, tx?: Tx): Promise<AccountRecord | null> {
    if (!UUID_PATTERN.test(accountId)) {
      return null;
    }
    const row = await this.db(tx).loyaltyAccount.findUnique({ where: { id: accountId } });
    return row ? toAccount(row) : null;
  }

  async findAccountByUserId(userId: string, tx?: Tx): Promise<AccountRecord | null> {
    if (!UUID_PATTERN.test(userId)) {
      return null;
    }
    const row = await this.db(tx).loyaltyAccount.findUnique({ where: { userId } });
    return row ? toAccount(row) : null;
  }

  async updateAccount(tx: Tx, accountId: string, patch: AccountPatch): Promise<AccountRecord> {
    const data: Prisma.LoyaltyAccountUncheckedUpdateInput = {};
    if (patch.availableBalance !== undefined) {
      data.availableBalance = patch.availableBalance;
    }
    if (patch.pendingBalance !== undefined) {
      data.pendingBalance = patch.pendingBalance;
    }
    if (patch.lifetimeEarned !== undefined) {
      data.lifetimeEarned = patch.lifetimeEarned;
    }
    if (patch.newcomerLockUntil !== undefined) {
      data.newcomerLockUntil = patch.newcomerLockUntil;
    }
    if (patch.welcomeState !== undefined) {
      data.welcomeState = asJson(parseWelcomeState(patch.welcomeState));
    }
    if (patch.expiryReminders !== undefined) {
      data.expiryReminders = asJson(patch.expiryReminders);
    }
    const row = await tx.loyaltyAccount.update({ where: { id: accountId }, data });
    return toAccount(row);
  }

  async listAccounts(afterId: string | null, limit: number): Promise<AccountRecord[]> {
    const rows = await this.prisma.loyaltyAccount.findMany({
      where: afterId ? { id: { gt: afterId } } : undefined,
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map(toAccount);
  }

  async recomputeBalances(
    accountId: string,
    tx?: Tx,
  ): Promise<{ available: number; pending: number }> {
    const db = this.db(tx);
    const available = await db.pointsTransaction.aggregate({
      _sum: { amount: true },
      where: { accountId, state: { in: [...AVAILABLE_SUM_STATES] } },
    });
    const pending = await db.pointsTransaction.aggregate({
      _sum: { amount: true },
      where: { accountId, state: 'pending' },
    });
    return { available: available._sum.amount ?? 0, pending: pending._sum.amount ?? 0 };
  }

  // --- ledger rows --------------------------------------------------------------------------

  async findEntryById(id: string, tx?: Tx): Promise<EntryRecord | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const row = await this.db(tx).pointsTransaction.findUnique({
      where: { id },
      include: ENTRY_INCLUDE,
    });
    return row ? toEntry(row) : null;
  }

  async findEntryByKey(idempotencyKey: string, tx?: Tx): Promise<EntryRecord | null> {
    const row = await this.db(tx).pointsTransaction.findUnique({
      where: { idempotencyKey },
      include: ENTRY_INCLUDE,
    });
    return row ? toEntry(row) : null;
  }

  async insertEntry(tx: Tx, entry: EntryRecord): Promise<EntryRecord> {
    const row = await tx.pointsTransaction.create({
      data: {
        id: entry.id,
        accountId: entry.accountId,
        type: entry.type,
        state: entry.state,
        amount: entry.amount,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        idempotencyKey: entry.idempotencyKey,
        availableAt: entry.availableAt,
        expiresAt: entry.expiresAt,
        reason: entry.reason,
        createdById: entry.createdById,
        createdAt: entry.createdAt,
        title: entry.title,
        subtitle: entry.subtitle,
        counterparty: entry.counterparty ? asJson(entry.counterparty) : Prisma.DbNull,
      },
      include: ENTRY_INCLUDE,
    });
    return toEntry(row);
  }

  async updateEntryState(tx: Tx, id: string, state: PointsTxState): Promise<EntryRecord> {
    const row = await tx.pointsTransaction.update({
      where: { id },
      data: { state },
      include: ENTRY_INCLUDE,
    });
    return toEntry(row);
  }

  async updateEntriesState(tx: Tx, ids: readonly string[], state: PointsTxState): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const result = await tx.pointsTransaction.updateMany({
      where: { id: { in: [...ids] } },
      data: { state },
    });
    return result.count;
  }

  async listEntries(filter: EntryListFilter, tx?: Tx): Promise<EntryRecord[]> {
    const where: Prisma.PointsTransactionWhereInput = { accountId: filter.accountId };
    if (filter.type) {
      where.type = filter.type;
    }
    if (filter.state) {
      where.state = filter.state;
    }
    if (filter.from || filter.to) {
      where.createdAt = {
        ...(filter.from ? { gte: filter.from } : {}),
        ...(filter.to ? { lt: filter.to } : {}),
      };
    }
    if (filter.cursor) {
      where.OR = [
        { createdAt: { lt: filter.cursor.createdAt } },
        { createdAt: filter.cursor.createdAt, id: { lt: filter.cursor.id } },
      ];
    }
    const rows = await this.db(tx).pointsTransaction.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit,
      include: ENTRY_INCLUDE,
    });
    return rows.map(toEntry);
  }

  async listReleasableHolds(now: Date, limit: number): Promise<EntryRecord[]> {
    const rows = await this.prisma.pointsTransaction.findMany({
      where: { state: 'pending', amount: { gt: 0 }, availableAt: { lte: now } },
      orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
      take: limit,
      include: ENTRY_INCLUDE,
    });
    return rows.map(toEntry);
  }

  async listAvailableCreditsExpiringBetween(
    tx: Tx,
    accountId: string,
    from: Date,
    to: Date,
  ): Promise<EntryRecord[]> {
    const rows = await tx.pointsTransaction.findMany({
      where: { accountId, state: 'available', amount: { gt: 0 }, expiresAt: { gte: from, lt: to } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: ENTRY_INCLUDE,
    });
    return rows.map(toEntry);
  }

  countReceiptCredits(accountId: string, tx?: Tx): Promise<number> {
    return this.db(tx).pointsTransaction.count({
      where: { accountId, type: 'earn', sourceType: 'receipt', state: { not: 'cancelled' } },
    });
  }

  async sumAmount(filter: AmountSumFilter): Promise<number> {
    const where: Prisma.PointsTransactionWhereInput = {
      createdAt: { gte: filter.from, lt: filter.to },
      type: { in: [...filter.types] },
    };
    if (filter.sign === 'positive') {
      where.amount = { gt: 0 };
    } else if (filter.sign === 'negative') {
      where.amount = { lt: 0 };
    }
    if (filter.excludeCancelled) {
      where.state = { not: 'cancelled' };
    }
    const result = await this.prisma.pointsTransaction.aggregate({ _sum: { amount: true }, where });
    return result._sum.amount ?? 0;
  }

  async sumAccountPeriod(accountId: string, from: Date, to: Date): Promise<AccountPeriodTotals> {
    const groups = await this.prisma.pointsTransaction.groupBy({
      by: ['type'],
      where: {
        accountId,
        createdAt: { gte: from, lt: to },
        state: { in: [...AVAILABLE_SUM_STATES] },
      },
      _sum: { amount: true },
    });
    // Positive and negative adjustments must not cancel out: sum them separately.
    const [adjustPlus, adjustMinus] = await Promise.all([
      this.prisma.pointsTransaction.aggregate({
        _sum: { amount: true },
        where: {
          accountId,
          type: 'adjust',
          amount: { gt: 0 },
          createdAt: { gte: from, lt: to },
          state: { in: [...AVAILABLE_SUM_STATES] },
        },
      }),
      this.prisma.pointsTransaction.aggregate({
        _sum: { amount: true },
        where: { accountId, type: 'adjust', amount: { lt: 0 }, createdAt: { gte: from, lt: to } },
      }),
    ]);
    const byType = new Map(groups.map((group) => [group.type, group._sum.amount ?? 0]));
    const sum = (type: PointsTransaction['type']): number => byType.get(type) ?? 0;
    return {
      earned: sum('earn') + sum('welcome') + (adjustPlus._sum.amount ?? 0),
      spent: Math.abs(sum('spend') + (adjustMinus._sum.amount ?? 0)),
      expired: Math.abs(sum('expire')),
      refunded: sum('refund'),
      reversed: Math.abs(sum('reverse')),
    };
  }

  // --- spend allocations --------------------------------------------------------------------

  async insertSpendAllocations(
    tx: Tx,
    spendTxId: string,
    allocations: readonly SpendAllocationRecord[],
  ): Promise<void> {
    const data = allocations
      .filter((allocation) => allocation.amount > 0)
      .map((allocation) => ({
        spendTxId,
        expiresOn: dayKeyToDate(allocation.dayKey),
        amount: allocation.amount,
      }));
    if (data.length > 0) {
      await tx.pointsSpendAllocation.createMany({ data });
    }
  }

  async listSpendAllocations(spendTxId: string, tx?: Tx): Promise<SpendAllocationRecord[]> {
    if (!UUID_PATTERN.test(spendTxId)) {
      return [];
    }
    const rows = await this.db(tx).pointsSpendAllocation.findMany({
      where: { spendTxId },
      orderBy: { expiresOn: 'asc' },
    });
    return rows.map((row) => ({ dayKey: dateToDayKey(row.expiresOn), amount: row.amount }));
  }

  // --- expiry buckets -----------------------------------------------------------------------

  async listBuckets(accountId: string, tx?: Tx): Promise<BucketRecord[]> {
    const rows = await this.db(tx).pointsExpiryBucket.findMany({
      where: { accountId, remaining: { gt: 0 } },
      orderBy: { expiresOn: 'asc' },
    });
    return rows.map(toBucket);
  }

  async findBucket(accountId: string, dayKey: string, tx?: Tx): Promise<BucketRecord | null> {
    const row = await this.db(tx).pointsExpiryBucket.findUnique({
      where: { accountId_expiresOn: { accountId, expiresOn: dayKeyToDate(dayKey) } },
    });
    return row ? toBucket(row) : null;
  }

  async setBucket(tx: Tx, accountId: string, dayKey: string, remaining: number): Promise<void> {
    const expiresOn = dayKeyToDate(dayKey);
    if (remaining <= 0) {
      await tx.pointsExpiryBucket.deleteMany({ where: { accountId, expiresOn } });
      return;
    }
    await tx.pointsExpiryBucket.upsert({
      where: { accountId_expiresOn: { accountId, expiresOn } },
      create: { accountId, expiresOn, remaining },
      update: { remaining },
    });
  }

  async listExpiredBuckets(
    beforeDayKey: string,
    after: BucketCursor | null,
    limit: number,
  ): Promise<BucketWithOwner[]> {
    const where: Prisma.PointsExpiryBucketWhereInput = {
      remaining: { gt: 0 },
      expiresOn: { lt: dayKeyToDate(beforeDayKey) },
    };
    if (after) {
      where.OR = [
        { accountId: { gt: after.accountId } },
        { accountId: after.accountId, expiresOn: { gt: dayKeyToDate(after.dayKey) } },
      ];
    }
    const rows = await this.prisma.pointsExpiryBucket.findMany({
      where,
      orderBy: [{ accountId: 'asc' }, { expiresOn: 'asc' }],
      take: limit,
      include: { account: { select: { userId: true } } },
    });
    return rows.map(toBucketWithOwner);
  }

  async listBucketsOnDay(
    dayKey: string,
    afterAccountId: string | null,
    limit: number,
  ): Promise<BucketWithOwner[]> {
    const rows = await this.prisma.pointsExpiryBucket.findMany({
      where: {
        remaining: { gt: 0 },
        expiresOn: dayKeyToDate(dayKey),
        ...(afterAccountId ? { accountId: { gt: afterAccountId } } : {}),
      },
      orderBy: { accountId: 'asc' },
      take: limit,
      include: { account: { select: { userId: true } } },
    });
    return rows.map(toBucketWithOwner);
  }

  async sumBuckets(accountId: string, tx?: Tx): Promise<number> {
    const result = await this.db(tx).pointsExpiryBucket.aggregate({
      _sum: { remaining: true },
      where: { accountId, remaining: { gt: 0 } },
    });
    return result._sum.remaining ?? 0;
  }

  // --- rule sets ----------------------------------------------------------------------------

  async findActiveRuleSet(at: Date, tx?: Tx): Promise<RuleSetRecord | null> {
    const row = await this.db(tx).loyaltyRuleSet.findFirst({
      where: { activeFrom: { lte: at } },
      orderBy: [{ activeFrom: 'desc' }, { version: 'desc' }],
    });
    return row ? toRuleSet(row) : null;
  }

  async listRuleSets(): Promise<RuleSetRecord[]> {
    const rows = await this.prisma.loyaltyRuleSet.findMany({ orderBy: { version: 'desc' } });
    return rows.map(toRuleSet);
  }

  async findRuleSetById(id: string, tx?: Tx): Promise<RuleSetRecord | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const row = await this.db(tx).loyaltyRuleSet.findUnique({ where: { id } });
    return row ? toRuleSet(row) : null;
  }

  async findRuleSetByVersion(version: number, tx?: Tx): Promise<RuleSetRecord | null> {
    const row = await this.db(tx).loyaltyRuleSet.findUnique({ where: { version } });
    return row ? toRuleSet(row) : null;
  }

  async maxRuleSetVersion(tx?: Tx): Promise<number> {
    const result = await this.db(tx).loyaltyRuleSet.aggregate({ _max: { version: true } });
    return result._max.version ?? 0;
  }

  async insertRuleSet(tx: Tx, row: RuleSetRecord): Promise<RuleSetRecord> {
    const created = await tx.loyaltyRuleSet.create({
      data: {
        id: row.id,
        version: row.version,
        activeFrom: row.activeFrom,
        config: asJson(row.config),
        note: row.note,
        createdById: row.createdById,
        createdAt: row.createdAt,
      },
    });
    return toRuleSet(created);
  }

  async updateRuleSet(tx: Tx, id: string, patch: RuleSetPatch): Promise<RuleSetRecord> {
    const data: Prisma.LoyaltyRuleSetUncheckedUpdateInput = {};
    if (patch.activeFrom !== undefined) {
      data.activeFrom = patch.activeFrom;
    }
    if (patch.config !== undefined) {
      data.config = asJson(patch.config);
    }
    if (patch.note !== undefined) {
      data.note = patch.note;
    }
    const row = await tx.loyaltyRuleSet.update({ where: { id }, data });
    return toRuleSet(row);
  }

  async deleteRuleSet(tx: Tx, id: string): Promise<void> {
    await tx.loyaltyRuleSet.delete({ where: { id } });
  }
}
