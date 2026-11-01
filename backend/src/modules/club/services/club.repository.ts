import type {
  PointsCounterparty,
  PointsSourceType,
  PointsTxState,
  PointsTxType,
} from '../../../common/contracts/club';
import type { Tx } from '../../../common/prisma/prisma.service';
import type { ExpiryReminderState } from '../domain/reminders';
import type { WelcomeState } from '../domain/welcome';

/**
 * Persistence boundary of the club module. `PrismaClubRepository` is the production
 * implementation; `InMemoryClubRepository` (testing/) backs unit and e2e tests, so the ledger
 * orchestration is tested without PostgreSQL and the SQL itself by the integration spec.
 *
 * Every method that must run inside the caller's transaction takes `tx` first; read methods
 * accept an optional `tx` to see uncommitted rows of the current transaction.
 */

export interface AccountRecord {
  id: string;
  userId: string;
  availableBalance: number;
  pendingBalance: number;
  lifetimeEarned: number;
  newcomerLockUntil: Date | null;
  welcomeState: WelcomeState;
  /** Expiry reminders already emitted (column expiry_reminders, see domain/reminders.ts). */
  expiryReminders: ExpiryReminderState;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountPatch {
  availableBalance?: number;
  pendingBalance?: number;
  lifetimeEarned?: number;
  newcomerLockUntil?: Date | null;
  welcomeState?: WelcomeState;
  expiryReminders?: ExpiryReminderState;
}

export interface EntryRecord {
  id: string;
  accountId: string;
  /** Owner of the account (joined for convenience; not a column of points_transactions). */
  userId: string;
  type: PointsTxType;
  state: PointsTxState;
  amount: number;
  sourceType: PointsSourceType;
  sourceId: string | null;
  idempotencyKey: string | null;
  availableAt: Date | null;
  expiresAt: Date | null;
  reason: string | null;
  createdById: string | null;
  createdAt: Date;
  /** Display data written at posting time (null on older rows). */
  title: string | null;
  subtitle: string | null;
  counterparty: PointsCounterparty | null;
}

/** One expiry bucket portion consumed by a debit row (table points_spend_allocations). */
export interface SpendAllocationRecord {
  /** Kyiv calendar day `yyyy-MM-dd` of the bucket. */
  dayKey: string;
  amount: number;
}

/** Per-account totals of a period for the history summary (all positive numbers). */
export interface AccountPeriodTotals {
  /** Positive earn/welcome/adjust rows that reached the available balance (not pending/cancelled). */
  earned: number;
  /** Spend rows and negative manual adjustments. */
  spent: number;
  expired: number;
  /** Refund rows (points returned after a cancelled voucher). */
  refunded: number;
  /** Reverse rows (credits taken back). */
  reversed: number;
}

export interface BucketRecord {
  accountId: string;
  /** Kyiv calendar day `yyyy-MM-dd` (stored as a `date` column). */
  dayKey: string;
  remaining: number;
}

export interface BucketWithOwner extends BucketRecord {
  userId: string;
}

export interface BucketCursor {
  accountId: string;
  dayKey: string;
}

export interface RuleSetRecord {
  id: string;
  version: number;
  activeFrom: Date;
  /** Raw jsonb; normalised by `normalizeLoyaltyRules()`. */
  config: unknown;
  note: string | null;
  createdById: string | null;
  createdAt: Date;
}

export interface RuleSetPatch {
  activeFrom?: Date;
  config?: unknown;
  note?: string | null;
}

export interface EntryListFilter {
  accountId: string;
  /** Rows to fetch (callers pass `limit + 1` to detect the next page). */
  limit: number;
  /** Exclusive: rows strictly before (createdAt, id) in descending order. */
  cursor?: { createdAt: Date; id: string };
  type?: PointsTxType;
  state?: PointsTxState;
  /** Inclusive lower bound on createdAt. */
  from?: Date;
  /** Exclusive upper bound on createdAt. */
  to?: Date;
}

export interface AmountSumFilter {
  /** Half-open UTC range `[from, to)` on createdAt. */
  from: Date;
  to: Date;
  types: readonly PointsTxType[];
  sign?: 'positive' | 'negative';
  excludeCancelled?: boolean;
}

export interface CreateAccountInput {
  id: string;
  userId: string;
  newcomerLockUntil: Date | null;
  now: Date;
}

export abstract class ClubRepository {
  /** Joins `tx` when given, otherwise opens a new interactive transaction. */
  abstract inTx<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T>;

  // --- accounts -----------------------------------------------------------------------------

  /** `INSERT ... ON CONFLICT (user_id) DO NOTHING`; true when this call created the row. */
  abstract createAccountIfMissing(tx: Tx, input: CreateAccountInput): Promise<boolean>;
  /** `SELECT ... FOR UPDATE` by account id; null when the account does not exist. */
  abstract lockAccount(tx: Tx, accountId: string): Promise<AccountRecord | null>;
  /** `SELECT ... FOR UPDATE` by user id; null when the user has no account yet. */
  abstract lockAccountByUserId(tx: Tx, userId: string): Promise<AccountRecord | null>;
  abstract findAccountById(accountId: string, tx?: Tx): Promise<AccountRecord | null>;
  abstract findAccountByUserId(userId: string, tx?: Tx): Promise<AccountRecord | null>;
  abstract updateAccount(tx: Tx, accountId: string, patch: AccountPatch): Promise<AccountRecord>;
  /** Accounts ordered by id, after `afterId` (keyset pagination for jobs). */
  abstract listAccounts(afterId: string | null, limit: number): Promise<AccountRecord[]>;
  /** Balances recomputed from the ledger rows (drift check). */
  abstract recomputeBalances(
    accountId: string,
    tx?: Tx,
  ): Promise<{ available: number; pending: number }>;

  // --- ledger rows --------------------------------------------------------------------------

  abstract findEntryById(id: string, tx?: Tx): Promise<EntryRecord | null>;
  abstract findEntryByKey(idempotencyKey: string, tx?: Tx): Promise<EntryRecord | null>;
  abstract insertEntry(tx: Tx, entry: EntryRecord): Promise<EntryRecord>;
  abstract updateEntryState(tx: Tx, id: string, state: PointsTxState): Promise<EntryRecord>;
  abstract updateEntriesState(
    tx: Tx,
    ids: readonly string[],
    state: PointsTxState,
  ): Promise<number>;
  /** Newest first (createdAt desc, id desc). */
  abstract listEntries(filter: EntryListFilter, tx?: Tx): Promise<EntryRecord[]>;
  /** Pending credits whose availableAt has passed, oldest first. */
  abstract listReleasableHolds(now: Date, limit: number): Promise<EntryRecord[]>;
  /** Available credits of the account with expiresAt in `[from, to)`, oldest first. */
  abstract listAvailableCreditsExpiringBetween(
    tx: Tx,
    accountId: string,
    from: Date,
    to: Date,
  ): Promise<EntryRecord[]>;
  /** Number of non-cancelled `earn` rows from receipts (newcomer lock early release). */
  abstract countReceiptCredits(accountId: string, tx?: Tx): Promise<number>;
  abstract sumAmount(filter: AmountSumFilter): Promise<number>;
  /** Totals of one account over `[from, to)` on createdAt (history summary of a month). */
  abstract sumAccountPeriod(accountId: string, from: Date, to: Date): Promise<AccountPeriodTotals>;

  // --- spend allocations --------------------------------------------------------------------

  /** Records the buckets a debit row consumed (portions with amount <= 0 are skipped). */
  abstract insertSpendAllocations(
    tx: Tx,
    spendTxId: string,
    allocations: readonly SpendAllocationRecord[],
  ): Promise<void>;
  /** Allocations of a debit row, ascending by day; empty for rows posted before allocations existed. */
  abstract listSpendAllocations(spendTxId: string, tx?: Tx): Promise<SpendAllocationRecord[]>;

  // --- expiry buckets -----------------------------------------------------------------------

  /** Buckets with remaining > 0, ascending by day. */
  abstract listBuckets(accountId: string, tx?: Tx): Promise<BucketRecord[]>;
  abstract findBucket(accountId: string, dayKey: string, tx?: Tx): Promise<BucketRecord | null>;
  /** Upserts the remainder; a value <= 0 removes the bucket row. */
  abstract setBucket(tx: Tx, accountId: string, dayKey: string, remaining: number): Promise<void>;
  /**
   * Buckets with remaining > 0 whose day is strictly before `beforeDayKey`, ordered by
   * (accountId, dayKey) and starting after `after` (keyset pagination for the expiry job).
   */
  abstract listExpiredBuckets(
    beforeDayKey: string,
    after: BucketCursor | null,
    limit: number,
  ): Promise<BucketWithOwner[]>;
  /** Buckets with remaining > 0 on exactly that day, ordered by accountId after `afterAccountId`. */
  abstract listBucketsOnDay(
    dayKey: string,
    afterAccountId: string | null,
    limit: number,
  ): Promise<BucketWithOwner[]>;
  abstract sumBuckets(accountId: string, tx?: Tx): Promise<number>;

  // --- rule sets ----------------------------------------------------------------------------

  /** Latest rule set with activeFrom <= at (ties broken by the highest version). */
  abstract findActiveRuleSet(at: Date, tx?: Tx): Promise<RuleSetRecord | null>;
  /** Newest version first. */
  abstract listRuleSets(): Promise<RuleSetRecord[]>;
  abstract findRuleSetById(id: string, tx?: Tx): Promise<RuleSetRecord | null>;
  abstract findRuleSetByVersion(version: number, tx?: Tx): Promise<RuleSetRecord | null>;
  abstract maxRuleSetVersion(tx?: Tx): Promise<number>;
  abstract insertRuleSet(tx: Tx, row: RuleSetRecord): Promise<RuleSetRecord>;
  abstract updateRuleSet(tx: Tx, id: string, patch: RuleSetPatch): Promise<RuleSetRecord>;
  abstract deleteRuleSet(tx: Tx, id: string): Promise<void>;
}
