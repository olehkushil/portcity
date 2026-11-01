import type { PointsTxState } from '../../../common/contracts/club';
import type { Tx } from '../../../common/prisma/prisma.service';
import { AVAILABLE_SUM_STATES } from '../domain/points-state';
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
} from '../services/club.repository';

/** Stand-in transaction handle passed to callbacks; never dereferenced by the fake. */
export const FAKE_TX = {} as unknown as Tx;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function newestFirst(a: EntryRecord, b: EntryRecord): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || compareStrings(b.id, a.id);
}

function oldestFirst(a: EntryRecord, b: EntryRecord): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || compareStrings(a.id, b.id);
}

/**
 * In-memory implementation of ClubRepository for unit and e2e tests (no PostgreSQL).
 * It keeps the same read/write semantics as the Prisma implementation (ordering, filters,
 * keyset pagination) but no locking or rollback: those are covered by the integration spec.
 */
export class InMemoryClubRepository extends ClubRepository {
  readonly accounts = new Map<string, AccountRecord>();
  readonly entries: EntryRecord[] = [];
  readonly buckets = new Map<string, BucketRecord>();
  readonly ruleSets = new Map<string, RuleSetRecord>();
  /** points_spend_allocations: debit row id -> consumed bucket portions. */
  readonly allocations = new Map<string, SpendAllocationRecord[]>();
  /** Number of transactions opened by the module itself (callers' transactions are joined). */
  openedTransactions = 0;

  reset(): void {
    this.accounts.clear();
    this.entries.length = 0;
    this.buckets.clear();
    this.ruleSets.clear();
    this.allocations.clear();
    this.openedTransactions = 0;
  }

  inTx<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (tx) {
      return fn(tx);
    }
    this.openedTransactions += 1;
    return fn(FAKE_TX);
  }

  // --- accounts -----------------------------------------------------------------------------

  async createAccountIfMissing(_tx: Tx, input: CreateAccountInput): Promise<boolean> {
    if ([...this.accounts.values()].some((account) => account.userId === input.userId)) {
      return false;
    }
    this.accounts.set(input.id, {
      id: input.id,
      userId: input.userId,
      availableBalance: 0,
      pendingBalance: 0,
      lifetimeEarned: 0,
      newcomerLockUntil: input.newcomerLockUntil,
      welcomeState: { register: false, profile: false, firstReceipt: false },
      expiryReminders: {},
      createdAt: input.now,
      updatedAt: input.now,
    });
    return true;
  }

  lockAccount(_tx: Tx, accountId: string): Promise<AccountRecord | null> {
    return this.findAccountById(accountId);
  }

  lockAccountByUserId(_tx: Tx, userId: string): Promise<AccountRecord | null> {
    return this.findAccountByUserId(userId);
  }

  async findAccountById(accountId: string): Promise<AccountRecord | null> {
    const account = this.accounts.get(accountId);
    return account ? structuredClone(account) : null;
  }

  async findAccountByUserId(userId: string): Promise<AccountRecord | null> {
    const account = [...this.accounts.values()].find((item) => item.userId === userId);
    return account ? structuredClone(account) : null;
  }

  async updateAccount(_tx: Tx, accountId: string, patch: AccountPatch): Promise<AccountRecord> {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(`InMemoryClubRepository: account ${accountId} not found`);
    }
    const updated: AccountRecord = {
      ...account,
      ...(patch.availableBalance !== undefined ? { availableBalance: patch.availableBalance } : {}),
      ...(patch.pendingBalance !== undefined ? { pendingBalance: patch.pendingBalance } : {}),
      ...(patch.lifetimeEarned !== undefined ? { lifetimeEarned: patch.lifetimeEarned } : {}),
      ...(patch.newcomerLockUntil !== undefined
        ? { newcomerLockUntil: patch.newcomerLockUntil }
        : {}),
      ...(patch.welcomeState !== undefined ? { welcomeState: { ...patch.welcomeState } } : {}),
      ...(patch.expiryReminders !== undefined
        ? { expiryReminders: structuredClone(patch.expiryReminders) }
        : {}),
      updatedAt: new Date(account.updatedAt.getTime() + 1),
    };
    this.accounts.set(accountId, updated);
    return structuredClone(updated);
  }

  async listAccounts(afterId: string | null, limit: number): Promise<AccountRecord[]> {
    return [...this.accounts.values()]
      .filter((account) => afterId === null || account.id > afterId)
      .sort((a, b) => compareStrings(a.id, b.id))
      .slice(0, limit)
      .map((account) => structuredClone(account));
  }

  async recomputeBalances(accountId: string): Promise<{ available: number; pending: number }> {
    let available = 0;
    let pending = 0;
    for (const entry of this.entries) {
      if (entry.accountId !== accountId) {
        continue;
      }
      if (AVAILABLE_SUM_STATES.includes(entry.state)) {
        available += entry.amount;
      } else if (entry.state === 'pending') {
        pending += entry.amount;
      }
    }
    return { available, pending };
  }

  // --- ledger rows --------------------------------------------------------------------------

  async findEntryById(id: string): Promise<EntryRecord | null> {
    const entry = this.entries.find((item) => item.id === id);
    return entry ? structuredClone(entry) : null;
  }

  async findEntryByKey(idempotencyKey: string): Promise<EntryRecord | null> {
    const entry = this.entries.find((item) => item.idempotencyKey === idempotencyKey);
    return entry ? structuredClone(entry) : null;
  }

  async insertEntry(_tx: Tx, entry: EntryRecord): Promise<EntryRecord> {
    if (this.entries.some((item) => item.id === entry.id)) {
      throw new Error(`InMemoryClubRepository: duplicate entry id ${entry.id}`);
    }
    if (
      entry.idempotencyKey !== null &&
      this.entries.some((item) => item.idempotencyKey === entry.idempotencyKey)
    ) {
      throw new Error(`InMemoryClubRepository: duplicate idempotency key ${entry.idempotencyKey}`);
    }
    if (entry.amount === 0) {
      throw new Error('InMemoryClubRepository: CHECK (amount <> 0) violated');
    }
    this.entries.push(structuredClone(entry));
    return structuredClone(entry);
  }

  async updateEntryState(_tx: Tx, id: string, state: PointsTxState): Promise<EntryRecord> {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) {
      throw new Error(`InMemoryClubRepository: entry ${id} not found`);
    }
    entry.state = state;
    return structuredClone(entry);
  }

  async updateEntriesState(_tx: Tx, ids: readonly string[], state: PointsTxState): Promise<number> {
    let count = 0;
    for (const entry of this.entries) {
      if (ids.includes(entry.id)) {
        entry.state = state;
        count += 1;
      }
    }
    return count;
  }

  async listEntries(filter: EntryListFilter): Promise<EntryRecord[]> {
    const cursor = filter.cursor;
    return this.entries
      .filter((entry) => entry.accountId === filter.accountId)
      .filter((entry) => filter.type === undefined || entry.type === filter.type)
      .filter((entry) => filter.state === undefined || entry.state === filter.state)
      .filter(
        (entry) => filter.from === undefined || entry.createdAt.getTime() >= filter.from.getTime(),
      )
      .filter((entry) => filter.to === undefined || entry.createdAt.getTime() < filter.to.getTime())
      .filter(
        (entry) =>
          cursor === undefined ||
          entry.createdAt.getTime() < cursor.createdAt.getTime() ||
          (entry.createdAt.getTime() === cursor.createdAt.getTime() && entry.id < cursor.id),
      )
      .sort(newestFirst)
      .slice(0, filter.limit)
      .map((entry) => structuredClone(entry));
  }

  async listReleasableHolds(now: Date, limit: number): Promise<EntryRecord[]> {
    return this.entries
      .filter(
        (entry) =>
          entry.state === 'pending' &&
          entry.amount > 0 &&
          entry.availableAt !== null &&
          entry.availableAt.getTime() <= now.getTime(),
      )
      .sort(
        (a, b) =>
          (a.availableAt?.getTime() ?? 0) - (b.availableAt?.getTime() ?? 0) ||
          compareStrings(a.id, b.id),
      )
      .slice(0, limit)
      .map((entry) => structuredClone(entry));
  }

  async listAvailableCreditsExpiringBetween(
    _tx: Tx,
    accountId: string,
    from: Date,
    to: Date,
  ): Promise<EntryRecord[]> {
    return this.entries
      .filter(
        (entry) =>
          entry.accountId === accountId &&
          entry.state === 'available' &&
          entry.amount > 0 &&
          entry.expiresAt !== null &&
          entry.expiresAt.getTime() >= from.getTime() &&
          entry.expiresAt.getTime() < to.getTime(),
      )
      .sort(oldestFirst)
      .map((entry) => structuredClone(entry));
  }

  async countReceiptCredits(accountId: string): Promise<number> {
    return this.entries.filter(
      (entry) =>
        entry.accountId === accountId &&
        entry.type === 'earn' &&
        entry.sourceType === 'receipt' &&
        entry.state !== 'cancelled',
    ).length;
  }

  async sumAmount(filter: AmountSumFilter): Promise<number> {
    return this.entries
      .filter(
        (entry) =>
          entry.createdAt.getTime() >= filter.from.getTime() &&
          entry.createdAt.getTime() < filter.to.getTime() &&
          filter.types.includes(entry.type) &&
          (filter.sign !== 'positive' || entry.amount > 0) &&
          (filter.sign !== 'negative' || entry.amount < 0) &&
          (!filter.excludeCancelled || entry.state !== 'cancelled'),
      )
      .reduce((sum, entry) => sum + entry.amount, 0);
  }

  async sumAccountPeriod(accountId: string, from: Date, to: Date): Promise<AccountPeriodTotals> {
    const totals: AccountPeriodTotals = {
      earned: 0,
      spent: 0,
      expired: 0,
      refunded: 0,
      reversed: 0,
    };
    for (const entry of this.entries) {
      if (
        entry.accountId !== accountId ||
        entry.createdAt.getTime() < from.getTime() ||
        entry.createdAt.getTime() >= to.getTime()
      ) {
        continue;
      }
      const counted = AVAILABLE_SUM_STATES.includes(entry.state);
      switch (entry.type) {
        case 'earn':
        case 'welcome':
          totals.earned += counted ? entry.amount : 0;
          break;
        case 'adjust':
          if (entry.amount > 0) {
            totals.earned += counted ? entry.amount : 0;
          } else {
            totals.spent += -entry.amount;
          }
          break;
        case 'spend':
          totals.spent += -entry.amount;
          break;
        case 'expire':
          totals.expired += -entry.amount;
          break;
        case 'refund':
          totals.refunded += counted ? entry.amount : 0;
          break;
        case 'reverse':
          totals.reversed += -entry.amount;
          break;
        default:
          break;
      }
    }
    return totals;
  }

  // --- spend allocations --------------------------------------------------------------------

  async insertSpendAllocations(
    _tx: Tx,
    spendTxId: string,
    allocations: readonly SpendAllocationRecord[],
  ): Promise<void> {
    const rows = allocations.filter((allocation) => allocation.amount > 0);
    if (rows.length === 0) {
      return;
    }
    if (this.allocations.has(spendTxId)) {
      throw new Error(`InMemoryClubRepository: allocations of ${spendTxId} already recorded`);
    }
    this.allocations.set(
      spendTxId,
      rows.map((row) => ({ ...row })).sort((a, b) => compareStrings(a.dayKey, b.dayKey)),
    );
  }

  async listSpendAllocations(spendTxId: string): Promise<SpendAllocationRecord[]> {
    return (this.allocations.get(spendTxId) ?? []).map((row) => ({ ...row }));
  }

  // --- expiry buckets -----------------------------------------------------------------------

  private bucketKey(accountId: string, dayKey: string): string {
    return `${accountId}|${dayKey}`;
  }

  private bucketsOf(accountId: string): BucketRecord[] {
    return [...this.buckets.values()]
      .filter((bucket) => bucket.accountId === accountId && bucket.remaining > 0)
      .sort((a, b) => compareStrings(a.dayKey, b.dayKey));
  }

  async listBuckets(accountId: string): Promise<BucketRecord[]> {
    return this.bucketsOf(accountId).map((bucket) => ({ ...bucket }));
  }

  async findBucket(accountId: string, dayKey: string): Promise<BucketRecord | null> {
    const bucket = this.buckets.get(this.bucketKey(accountId, dayKey));
    return bucket ? { ...bucket } : null;
  }

  async setBucket(_tx: Tx, accountId: string, dayKey: string, remaining: number): Promise<void> {
    const key = this.bucketKey(accountId, dayKey);
    if (remaining <= 0) {
      this.buckets.delete(key);
      return;
    }
    this.buckets.set(key, { accountId, dayKey, remaining });
  }

  private withOwner(bucket: BucketRecord): BucketWithOwner {
    const account = this.accounts.get(bucket.accountId);
    return { ...bucket, userId: account?.userId ?? '' };
  }

  async listExpiredBuckets(
    beforeDayKey: string,
    after: BucketCursor | null,
    limit: number,
  ): Promise<BucketWithOwner[]> {
    return [...this.buckets.values()]
      .filter((bucket) => bucket.remaining > 0 && bucket.dayKey < beforeDayKey)
      .filter(
        (bucket) =>
          after === null ||
          bucket.accountId > after.accountId ||
          (bucket.accountId === after.accountId && bucket.dayKey > after.dayKey),
      )
      .sort(
        (a, b) => compareStrings(a.accountId, b.accountId) || compareStrings(a.dayKey, b.dayKey),
      )
      .slice(0, limit)
      .map((bucket) => this.withOwner(bucket));
  }

  async listBucketsOnDay(
    dayKey: string,
    afterAccountId: string | null,
    limit: number,
  ): Promise<BucketWithOwner[]> {
    return [...this.buckets.values()]
      .filter((bucket) => bucket.remaining > 0 && bucket.dayKey === dayKey)
      .filter((bucket) => afterAccountId === null || bucket.accountId > afterAccountId)
      .sort((a, b) => compareStrings(a.accountId, b.accountId))
      .slice(0, limit)
      .map((bucket) => this.withOwner(bucket));
  }

  async sumBuckets(accountId: string): Promise<number> {
    return this.bucketsOf(accountId).reduce((sum, bucket) => sum + bucket.remaining, 0);
  }

  // --- rule sets ----------------------------------------------------------------------------

  async findActiveRuleSet(at: Date): Promise<RuleSetRecord | null> {
    const candidates = [...this.ruleSets.values()]
      .filter((set) => set.activeFrom.getTime() <= at.getTime())
      .sort((a, b) => b.activeFrom.getTime() - a.activeFrom.getTime() || b.version - a.version);
    const active = candidates[0];
    return active ? structuredClone(active) : null;
  }

  async listRuleSets(): Promise<RuleSetRecord[]> {
    return [...this.ruleSets.values()]
      .sort((a, b) => b.version - a.version)
      .map((set) => structuredClone(set));
  }

  async findRuleSetById(id: string): Promise<RuleSetRecord | null> {
    const set = this.ruleSets.get(id);
    return set ? structuredClone(set) : null;
  }

  async findRuleSetByVersion(version: number): Promise<RuleSetRecord | null> {
    const set = [...this.ruleSets.values()].find((item) => item.version === version);
    return set ? structuredClone(set) : null;
  }

  async maxRuleSetVersion(): Promise<number> {
    return Math.max(0, ...[...this.ruleSets.values()].map((set) => set.version));
  }

  async insertRuleSet(_tx: Tx, row: RuleSetRecord): Promise<RuleSetRecord> {
    if ([...this.ruleSets.values()].some((set) => set.version === row.version)) {
      throw new Error(`InMemoryClubRepository: duplicate rule set version ${row.version}`);
    }
    this.ruleSets.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  async updateRuleSet(_tx: Tx, id: string, patch: RuleSetPatch): Promise<RuleSetRecord> {
    const set = this.ruleSets.get(id);
    if (!set) {
      throw new Error(`InMemoryClubRepository: rule set ${id} not found`);
    }
    const updated: RuleSetRecord = {
      ...set,
      ...(patch.activeFrom !== undefined ? { activeFrom: patch.activeFrom } : {}),
      ...(patch.config !== undefined ? { config: structuredClone(patch.config) } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
    };
    this.ruleSets.set(id, updated);
    return structuredClone(updated);
  }

  async deleteRuleSet(_tx: Tx, id: string): Promise<void> {
    this.ruleSets.delete(id);
  }
}
