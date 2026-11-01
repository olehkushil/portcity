import { Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import type {
  ActiveRuleSet,
  ClubLedgerPort,
  CreditPointsInput,
  HoldPointsInput,
  LedgerEntry,
  LoyaltyRules,
  PointsBalance,
  PointsDailyStats,
  PointsDisplayInput,
  PointsSourceType,
  PointsTxType,
  ReversePointsInput,
  SpendPointsInput,
} from '../../../common/contracts/club';
import {
  CLUB_EVENTS,
  OUTBOX_AGGREGATES,
  type OutboxEventType,
  type TypedOutboxEventInput,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import type { DateRange } from '../../../common/contracts/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { CommonErrors } from '../../../common/errors/error-codes';
import { OutboxService } from '../../../common/outbox/outbox.service';
import type { Tx } from '../../../common/prisma/prisma.service';
import { isUniqueViolation } from '../../../common/prisma/prisma.errors';
import { Clock } from '../../../common/time/clock';
import {
  type BucketDelta,
  applyCredit,
  consumeFifo,
  planRefund,
  reduceBuckets,
  spendBlockReason,
  splitExpiredCredits,
} from '../domain/balance';
import {
  EXPIRE_TITLE,
  type PointsDisplay,
  REFUND_EXPIRED_SUBTITLE,
  defaultPointsTitle,
  resolvePointsDisplay,
} from '../domain/display';
import { ClubErrors } from '../domain/errors';
import {
  bucketDayKey,
  computeExpiresAt,
  dayEndInstant,
  expiryCutoffDayKey,
  kyivDayBounds,
} from '../domain/expiry';
import { expiryKey, refundExpiryKey, reversalKey } from '../domain/ledger-keys';
import { isNewcomerLockActive, shouldLiftNewcomerLock } from '../domain/newcomer';
import { assertTransition, planReversal } from '../domain/points-state';
import { newcomerLockUntil } from '../domain/rules';
import {
  type AccountRecord,
  type BucketCursor,
  type BucketRecord,
  ClubRepository,
  type EntryRecord,
} from './club.repository';
import { isoOrNull, toLedgerEntry, toPointsBalance } from './mappers';
import { RuleSetsService } from './rule-sets.service';

/** Row types whose positive amount counts towards `lifetimeEarned` (seed: 380 = welcome + earn + adjust). */
const LIFETIME_TYPES: readonly PointsTxType[] = ['earn', 'welcome', 'adjust'];

/** Member-facing reason of an expiry row. */
export const EXPIRY_REASON = 'Термін дії балів минув';

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export interface ExpireRunResult {
  /** Buckets of days strictly before this Kyiv day were due. */
  cutoffDayKey: string;
  buckets: number;
  points: number;
  accounts: number;
  failed: number;
}

export interface BucketExpiryOutcome {
  accountId: string;
  dayKey: string;
  points: number;
  txId: string | null;
}

/**
 * The points ledger (brief section 7), provided as CLUB_LEDGER_PORT.
 *
 * Every write runs in the caller's transaction when one is passed (otherwise in its own), locks
 * the account row first (`SELECT ... FOR UPDATE`), is idempotent by its ledger idempotency key
 * (checked after the lock, so concurrent duplicates serialise and the second one replays), moves
 * the cached balances and the FIFO expiry buckets in the same transaction and publishes its
 * outbox event there too. Ledger rows are never updated except for forward `state` moves
 * (pending -> available | cancelled, available -> spent | expired), matching the
 * `points_transactions_append_only` trigger.
 *
 * Balance convention (seed): available = sum(amount) over rows in available/spent/expired,
 * pending = sum over pending rows; spend/expire/reverse rows are negative and final;
 * `sum(buckets) === max(available, 0)`.
 */
@Injectable()
export class LedgerService implements ClubLedgerPort {
  static readonly EXPIRE_BATCH = 200;

  private readonly logger = new Logger(LedgerService.name);

  constructor(
    private readonly repo: ClubRepository,
    private readonly ruleSets: RuleSetsService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------

  async getBalance(userId: string, tx?: Tx): Promise<PointsBalance | null> {
    const account = await this.repo.findAccountByUserId(userId, tx);
    return account ? toPointsBalance(account, this.clock.now()) : null;
  }

  async getEntry(txId: string, tx?: Tx): Promise<LedgerEntry | null> {
    const entry = await this.repo.findEntryById(txId, tx);
    return entry ? toLedgerEntry(entry) : null;
  }

  getActiveRules(at?: Date): Promise<ActiveRuleSet> {
    return this.ruleSets.getActiveRules(at);
  }

  /**
   * Daily totals for reports: `earned` = positive earn/welcome/adjust rows (pending included,
   * cancelled excluded), `spent` = spend rows plus negative manual adjustments, `expired` and
   * `reversed` = expiry and reversal rows; all as positive numbers.
   */
  async getDailyStats(range: DateRange): Promise<PointsDailyStats> {
    const [earned, spent, expired, reversed] = await Promise.all([
      this.repo.sumAmount({
        ...range,
        types: LIFETIME_TYPES,
        sign: 'positive',
        excludeCancelled: true,
      }),
      this.repo.sumAmount({ ...range, types: ['spend', 'adjust'], sign: 'negative' }),
      this.repo.sumAmount({ ...range, types: ['expire'], sign: 'negative' }),
      this.repo.sumAmount({ ...range, types: ['reverse'], sign: 'negative' }),
    ]);
    return {
      earned: Math.abs(earned),
      spent: Math.abs(spent),
      expired: Math.abs(expired),
      reversed: Math.abs(reversed),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------------------------

  /**
   * Creates the member's account when missing (newcomer lock counted from `registeredAt`) and
   * publishes `points.account_created`. Safe under concurrency (`ON CONFLICT DO NOTHING`).
   */
  async ensureAccount(
    userId: string,
    registeredAt?: Date,
    tx?: Tx,
  ): Promise<{ account: AccountRecord; created: boolean }> {
    return this.repo.inTx(tx, async (db) => {
      const existing = await this.repo.findAccountByUserId(userId, db);
      if (existing) {
        return { account: existing, created: false };
      }
      const now = this.clock.now();
      const rules = await this.rules(db);
      const created = await this.createAccount(db, userId, registeredAt ?? now, rules, now);
      const account = await this.repo.findAccountByUserId(userId, db);
      if (!account) {
        throw new Error(`Loyalty account for user ${userId} vanished right after creation`);
      }
      return { account, created };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Writes (ClubLedgerPort)
  // ---------------------------------------------------------------------------------------------

  async credit(input: CreditPointsInput, tx?: Tx): Promise<LedgerEntry> {
    this.assertAmount(input.amount);
    this.assertKey(input.idempotencyKey);
    return this.repo.inTx(tx, async (db) => {
      const now = this.clock.now();
      const rules = await this.rules(db);
      const account = await this.lockOrCreateAccount(db, input.userId, rules, now);
      const replay = await this.findReplay(db, input.idempotencyKey, account, 'positive');
      if (replay) {
        return replay;
      }
      const expiresAt = input.expiresAt ?? computeExpiresAt(now, rules.pointsTtlMonths);
      this.assertFutureExpiry(expiresAt, now);

      const { availableBalance, toBucket } = applyCredit(account.availableBalance, input.amount);
      if (toBucket > 0) {
        await this.addToBucket(db, account.id, bucketDayKey(expiresAt), toBucket);
      }
      const type = input.type ?? 'earn';
      const entry = await this.insertEntry(db, {
        id: uuidv7(),
        accountId: account.id,
        userId: account.userId,
        type,
        state: 'available',
        amount: input.amount,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        idempotencyKey: input.idempotencyKey,
        availableAt: now,
        expiresAt,
        reason: input.reason ?? null,
        createdById: input.createdById ?? null,
        createdAt: now,
        ...this.display(input, type, input.sourceType, input.amount, input.reason),
      });
      let updated = await this.repo.updateAccount(db, account.id, {
        availableBalance,
        lifetimeEarned: account.lifetimeEarned + input.amount,
      });
      updated = await this.maybeLiftNewcomerLock(db, updated, entry, now);
      await this.publish(
        db,
        CLUB_EVENTS.credited,
        OUTBOX_AGGREGATES.pointsTransaction,
        entry.id,
        this.creditPayload(entry, updated.availableBalance),
        now,
      );
      return toLedgerEntry(entry);
    });
  }

  async hold(input: HoldPointsInput, tx?: Tx): Promise<LedgerEntry> {
    this.assertAmount(input.amount);
    this.assertKey(input.idempotencyKey);
    if (!(input.availableAt instanceof Date) || Number.isNaN(input.availableAt.getTime())) {
      throw new DomainError(CommonErrors.PC_COMMON_VALIDATION, 'availableAt must be a valid date');
    }
    return this.repo.inTx(tx, async (db) => {
      const now = this.clock.now();
      const rules = await this.rules(db);
      const account = await this.lockOrCreateAccount(db, input.userId, rules, now);
      const replay = await this.findReplay(db, input.idempotencyKey, account, 'positive');
      if (replay) {
        return replay;
      }
      const expiresAt =
        input.expiresAt ?? computeExpiresAt(input.availableAt, rules.pointsTtlMonths);
      this.assertFutureExpiry(expiresAt, input.availableAt);

      const type = input.type ?? 'earn';
      const entry = await this.insertEntry(db, {
        id: uuidv7(),
        accountId: account.id,
        userId: account.userId,
        type,
        state: 'pending',
        amount: input.amount,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        idempotencyKey: input.idempotencyKey,
        availableAt: input.availableAt,
        expiresAt,
        reason: input.reason ?? null,
        createdById: input.createdById ?? null,
        createdAt: now,
        ...this.display(input, type, input.sourceType, input.amount, input.reason),
      });
      let updated = await this.repo.updateAccount(db, account.id, {
        pendingBalance: account.pendingBalance + input.amount,
      });
      updated = await this.maybeLiftNewcomerLock(db, updated, entry, now);
      await this.publish(
        db,
        CLUB_EVENTS.held,
        OUTBOX_AGGREGATES.pointsTransaction,
        entry.id,
        this.creditPayload(entry, updated.availableBalance),
        now,
      );
      return toLedgerEntry(entry);
    });
  }

  async release(txId: string, tx?: Tx): Promise<LedgerEntry> {
    return this.repo.inTx(tx, async (db) => {
      const { account, entry } = await this.lockEntry(db, txId);
      if (entry.state !== 'pending') {
        if (entry.state === 'cancelled') {
          assertTransition(entry.state, 'available', entry.id);
        }
        // Already released (and maybe consumed since): idempotent replay.
        return toLedgerEntry(entry);
      }
      if (entry.amount <= 0) {
        throw new DomainError(
          ClubErrors.PC_POINTS_INVALID_TRANSITION,
          'Only a pending credit can be released',
          { details: { txId: entry.id, amount: entry.amount } },
        );
      }
      const now = this.clock.now();
      const expiresAt =
        entry.expiresAt ?? computeExpiresAt(now, (await this.rules(db)).pointsTtlMonths);
      const released = await this.repo.updateEntryState(db, entry.id, 'available');
      const { availableBalance, toBucket } = applyCredit(account.availableBalance, entry.amount);
      if (toBucket > 0) {
        await this.addToBucket(db, account.id, bucketDayKey(expiresAt), toBucket);
      }
      const updated = await this.repo.updateAccount(db, account.id, {
        availableBalance,
        pendingBalance: account.pendingBalance - entry.amount,
        lifetimeEarned: LIFETIME_TYPES.includes(entry.type)
          ? account.lifetimeEarned + entry.amount
          : account.lifetimeEarned,
      });
      await this.publish(
        db,
        CLUB_EVENTS.released,
        OUTBOX_AGGREGATES.pointsTransaction,
        entry.id,
        {
          userId: account.userId,
          accountId: account.id,
          txId: entry.id,
          amount: entry.amount,
          availableBalance: updated.availableBalance,
        },
        now,
      );
      return toLedgerEntry(released);
    });
  }

  async spend(input: SpendPointsInput, tx?: Tx): Promise<LedgerEntry> {
    this.assertAmount(input.amount);
    this.assertKey(input.idempotencyKey);
    return this.repo.inTx(tx, async (db) => {
      const now = this.clock.now();
      const account = await this.repo.lockAccountByUserId(db, input.userId);
      if (!account) {
        throw this.insufficient(0, input.amount);
      }
      const replay = await this.findReplay(db, input.idempotencyKey, account, 'negative');
      if (replay) {
        return replay;
      }
      // The newcomer lock protects against fresh accounts cashing out; a back-office deduction
      // (manual adjustment, four eyes in the admin module) is not a member spending points.
      const manual = input.sourceType === 'manual';
      const blocked = spendBlockReason(
        account.availableBalance,
        manual ? null : account.newcomerLockUntil,
        now,
      );
      if (blocked === 'negative_balance') {
        throw new DomainError(
          ClubErrors.PC_POINTS_ACCOUNT_NEGATIVE,
          'Spending is blocked until the balance is positive again',
          { details: { available: account.availableBalance } },
        );
      }
      if (blocked === 'newcomer_lock') {
        throw new DomainError(
          ClubErrors.PC_POINTS_NEWCOMER_LOCK,
          'Points of a new member can be spent after the newcomer period',
          { details: { newcomerLockUntil: isoOrNull(account.newcomerLockUntil) } },
        );
      }
      if (account.availableBalance < input.amount) {
        throw this.insufficient(account.availableBalance, input.amount);
      }

      const taken = await this.consumeFifo(db, account.id, input.amount);
      const type = manual ? 'adjust' : 'spend';
      const entry = await this.insertEntry(db, {
        id: uuidv7(),
        accountId: account.id,
        userId: account.userId,
        type,
        state: 'spent',
        amount: -input.amount,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        idempotencyKey: input.idempotencyKey,
        availableAt: null,
        expiresAt: null,
        reason: input.reason ?? null,
        createdById: input.createdById ?? null,
        createdAt: now,
        ...this.display(input, type, input.sourceType, -input.amount, input.reason),
      });
      // A refund of this row puts the points back into these buckets (original expiry).
      await this.repo.insertSpendAllocations(db, entry.id, taken);
      const updated = await this.repo.updateAccount(db, account.id, {
        availableBalance: account.availableBalance - input.amount,
      });
      await this.publish(
        db,
        CLUB_EVENTS.spent,
        OUTBOX_AGGREGATES.pointsTransaction,
        entry.id,
        {
          userId: account.userId,
          accountId: account.id,
          txId: entry.id,
          amount: input.amount,
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          availableBalance: updated.availableBalance,
        },
        now,
      );
      return toLedgerEntry(entry);
    });
  }

  async reverse(input: ReversePointsInput, tx?: Tx): Promise<LedgerEntry> {
    this.assertKey(input.idempotencyKey);
    return this.repo.inTx(tx, async (db) => {
      const { account, entry } = await this.lockEntry(db, input.txId);
      // One compensation per row, whatever key the caller sends (domain/ledger-keys.ts).
      const key = reversalKey(entry.id);
      const existing = await this.repo.findEntryByKey(key, db);
      if (existing) {
        return toLedgerEntry(existing);
      }
      const now = this.clock.now();
      const plan = planReversal(entry);
      switch (plan) {
        case 'noop':
          return toLedgerEntry(entry);
        case 'cancel':
          return this.cancelHold(db, account, entry, input, now);
        case 'reverse':
          return this.reverseCredit(db, account, entry, input, key, now);
        case 'refund':
          return this.refundDebit(db, account, entry, input, key, now);
        default: {
          const exhaustive: never = plan;
          throw new Error(`Unknown reversal plan ${String(exhaustive)}`);
        }
      }
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Expiry (daily job)
  // ---------------------------------------------------------------------------------------------

  /**
   * Expires every bucket whose Kyiv day ended before `asOf` (FIFO buckets, brief section 9).
   * Each bucket is processed in its own short transaction, so one failure does not stop the run
   * and a rerun continues where the previous one stopped (expired buckets are removed).
   */
  async expire(asOf?: Date): Promise<ExpireRunResult> {
    const now = asOf ?? this.clock.now();
    const cutoffDayKey = expiryCutoffDayKey(now);
    const result: ExpireRunResult = { cutoffDayKey, buckets: 0, points: 0, accounts: 0, failed: 0 };
    const accounts = new Set<string>();
    let after: BucketCursor | null = null;
    for (;;) {
      const batch = await this.repo.listExpiredBuckets(
        cutoffDayKey,
        after,
        LedgerService.EXPIRE_BATCH,
      );
      for (const bucket of batch) {
        after = { accountId: bucket.accountId, dayKey: bucket.dayKey };
        try {
          const outcome = await this.expireBucket(bucket.accountId, bucket.dayKey, now);
          if (outcome) {
            result.buckets += 1;
            result.points += outcome.points;
            accounts.add(outcome.accountId);
          }
        } catch (error) {
          result.failed += 1;
          this.logger.error(
            `Expiry of bucket ${bucket.accountId}/${bucket.dayKey} failed: ${errorMessage(error)}`,
          );
        }
      }
      if (batch.length < LedgerService.EXPIRE_BATCH) {
        break;
      }
    }
    result.accounts = accounts.size;
    return result;
  }

  /** Expires one bucket; null when it is already gone (rerun) or the account does not exist. */
  async expireBucket(
    accountId: string,
    dayKey: string,
    asOf?: Date,
  ): Promise<BucketExpiryOutcome | null> {
    const now = asOf ?? this.clock.now();
    return this.repo.inTx(undefined, async (db) => {
      const account = await this.repo.lockAccount(db, accountId);
      if (!account) {
        return null;
      }
      const bucket = await this.repo.findBucket(accountId, dayKey, db);
      if (!bucket || bucket.remaining <= 0) {
        return null;
      }
      const { start, end } = kyivDayBounds(dayKey);
      const credits = await this.repo.listAvailableCreditsExpiringBetween(
        db,
        accountId,
        start,
        end,
      );
      const split = splitExpiredCredits(credits, bucket.remaining);
      await this.repo.updateEntriesState(db, split.spent, 'spent');
      await this.repo.updateEntriesState(db, split.expired, 'expired');
      await this.repo.setBucket(db, accountId, dayKey, 0);

      const points = Math.min(bucket.remaining, Math.max(account.availableBalance, 0));
      if (points <= 0) {
        this.logger.warn(
          `Bucket ${accountId}/${dayKey} held ${bucket.remaining} points on a non-positive balance (${account.availableBalance}); removed without an expiry row`,
        );
        return { accountId, dayKey, points: 0, txId: null };
      }
      let key = expiryKey(accountId, dayKey);
      if (await this.repo.findEntryByKey(key, db)) {
        // The day was expired before and points landed in it later (a long hold released late).
        key = `${key}:${uuidv7()}`;
      }
      const entry = await this.insertEntry(db, {
        id: uuidv7(),
        accountId,
        userId: account.userId,
        type: 'expire',
        state: 'expired',
        amount: -points,
        sourceType: 'system',
        sourceId: null,
        idempotencyKey: key,
        availableAt: null,
        expiresAt: null,
        reason: EXPIRY_REASON,
        createdById: null,
        createdAt: now,
        ...resolvePointsDisplay(undefined, EXPIRE_TITLE),
      });
      const updated = await this.repo.updateAccount(db, accountId, {
        availableBalance: account.availableBalance - points,
      });
      await this.publish(
        db,
        CLUB_EVENTS.expired,
        OUTBOX_AGGREGATES.loyaltyAccount,
        accountId,
        {
          userId: account.userId,
          accountId,
          points,
          expiredOn: dayKey,
          availableBalance: updated.availableBalance,
        },
        now,
      );
      return { accountId, dayKey, points, txId: entry.id };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  private async rules(db: Tx): Promise<LoyaltyRules> {
    return (await this.ruleSets.getActiveRules(undefined, db)).rules;
  }

  private async createAccount(
    db: Tx,
    userId: string,
    registeredAt: Date,
    rules: LoyaltyRules,
    now: Date,
  ): Promise<boolean> {
    const id = uuidv7();
    const created = await this.repo.createAccountIfMissing(db, {
      id,
      userId,
      newcomerLockUntil: newcomerLockUntil(registeredAt, rules),
      now,
    });
    if (created) {
      await this.publish(
        db,
        CLUB_EVENTS.accountCreated,
        OUTBOX_AGGREGATES.loyaltyAccount,
        id,
        { userId, accountId: id },
        now,
      );
    }
    return created;
  }

  /** `credit`/`hold` create the account on first use (contract). */
  private async lockOrCreateAccount(
    db: Tx,
    userId: string,
    rules: LoyaltyRules,
    now: Date,
  ): Promise<AccountRecord> {
    const locked = await this.repo.lockAccountByUserId(db, userId);
    if (locked) {
      return locked;
    }
    await this.createAccount(db, userId, now, rules, now);
    const created = await this.repo.lockAccountByUserId(db, userId);
    if (!created) {
      throw new DomainError(
        ClubErrors.PC_POINTS_ACCOUNT_NOT_FOUND,
        `Loyalty account for user ${userId} could not be created`,
      );
    }
    return created;
  }

  /** Finds the row and locks its account; the row is re-read under the lock. */
  private async lockEntry(
    db: Tx,
    txId: string,
  ): Promise<{ account: AccountRecord; entry: EntryRecord }> {
    const found = await this.repo.findEntryById(txId, db);
    if (!found) {
      throw new DomainError(
        ClubErrors.PC_POINTS_TX_NOT_FOUND,
        `Points transaction ${txId} not found`,
      );
    }
    const account = await this.repo.lockAccount(db, found.accountId);
    const entry = await this.repo.findEntryById(txId, db);
    if (!account || !entry) {
      throw new DomainError(
        ClubErrors.PC_POINTS_TX_NOT_FOUND,
        `Points transaction ${txId} not found`,
      );
    }
    return { account, entry };
  }

  /**
   * Idempotent replay: the row with this key, if any. A key that belongs to another account or
   * to an operation of the other direction is a caller bug and answers 409.
   */
  private async findReplay(
    db: Tx,
    idempotencyKey: string,
    account: AccountRecord,
    direction: 'positive' | 'negative',
  ): Promise<LedgerEntry | null> {
    const existing = await this.repo.findEntryByKey(idempotencyKey, db);
    if (!existing) {
      return null;
    }
    const sameDirection = direction === 'positive' ? existing.amount > 0 : existing.amount < 0;
    if (existing.accountId !== account.id || !sameDirection) {
      throw new DomainError(
        CommonErrors.PC_COMMON_IDEMPOTENCY_MISMATCH,
        'This idempotency key was already used for a different points operation',
        { details: { idempotencyKey } },
      );
    }
    return toLedgerEntry(existing);
  }

  private async insertEntry(db: Tx, entry: EntryRecord): Promise<EntryRecord> {
    try {
      return await this.repo.insertEntry(db, entry);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainError(
          CommonErrors.PC_COMMON_IDEMPOTENCY_IN_PROGRESS,
          'A points operation with the same idempotency key is running concurrently; retry',
          { cause: error, details: { idempotencyKey: entry.idempotencyKey } },
        );
      }
      throw error;
    }
  }

  private async addToBucket(
    db: Tx,
    accountId: string,
    dayKey: string,
    points: number,
  ): Promise<void> {
    const bucket = await this.repo.findBucket(accountId, dayKey, db);
    await this.repo.setBucket(db, accountId, dayKey, (bucket?.remaining ?? 0) + points);
  }

  /**
   * FIFO by expiry day; a bucket emptied by the spend flips that day's credits to `spent`.
   * Returns the portions taken, which the caller records as the spend's allocations.
   */
  private async consumeFifo(db: Tx, accountId: string, amount: number): Promise<BucketDelta[]> {
    const buckets = await this.repo.listBuckets(accountId, db);
    const { taken, shortfall } = consumeFifo(buckets, amount);
    await this.applyTaken(db, accountId, buckets, taken);
    if (shortfall > 0) {
      this.logger.warn(
        `Account ${accountId}: buckets held ${amount - shortfall} of ${amount} spent points (bucket drift)`,
      );
    }
    return taken;
  }

  /** Display data of a new row: the caller's, else a title derived from the row type. */
  private display(
    input: PointsDisplayInput | undefined,
    type: PointsTxType,
    sourceType: PointsSourceType,
    amount: number,
    reason?: string | null,
  ): PointsDisplay {
    // Welcome bonuses carry their member-facing wording in `reason` ("Бонус за перший чек").
    const fallback =
      type === 'welcome' && reason ? reason : defaultPointsTitle(type, sourceType, amount);
    return resolvePointsDisplay(input, fallback);
  }

  private async applyTaken(
    db: Tx,
    accountId: string,
    buckets: readonly BucketRecord[],
    taken: ReadonlyArray<{ dayKey: string; amount: number }>,
  ): Promise<void> {
    for (const portion of taken) {
      const bucket = buckets.find((item) => item.dayKey === portion.dayKey);
      const remaining = (bucket?.remaining ?? 0) - portion.amount;
      await this.repo.setBucket(db, accountId, portion.dayKey, remaining);
      if (remaining <= 0) {
        const { start, end } = kyivDayBounds(portion.dayKey);
        const credits = await this.repo.listAvailableCreditsExpiringBetween(
          db,
          accountId,
          start,
          end,
        );
        await this.repo.updateEntriesState(
          db,
          credits.map((credit) => credit.id),
          'spent',
        );
      }
    }
  }

  private async maybeLiftNewcomerLock(
    db: Tx,
    account: AccountRecord,
    entry: EntryRecord,
    now: Date,
  ): Promise<AccountRecord> {
    if (entry.type !== 'earn' || entry.sourceType !== 'receipt') {
      return account;
    }
    if (!isNewcomerLockActive(account.newcomerLockUntil, now)) {
      return account;
    }
    const receipts = await this.repo.countReceiptCredits(account.id, db);
    if (!shouldLiftNewcomerLock(account.newcomerLockUntil, now, receipts)) {
      return account;
    }
    return this.repo.updateAccount(db, account.id, { newcomerLockUntil: now });
  }

  /** pending credit -> cancelled; only the pending balance moves. */
  private async cancelHold(
    db: Tx,
    account: AccountRecord,
    entry: EntryRecord,
    input: ReversePointsInput,
    now: Date,
  ): Promise<LedgerEntry> {
    const cancelled = await this.repo.updateEntryState(db, entry.id, 'cancelled');
    const updated = await this.repo.updateAccount(db, account.id, {
      pendingBalance: account.pendingBalance - entry.amount,
    });
    await this.publish(
      db,
      CLUB_EVENTS.reversed,
      OUTBOX_AGGREGATES.pointsTransaction,
      entry.id,
      {
        userId: account.userId,
        accountId: account.id,
        txId: entry.id,
        reversedTxId: entry.id,
        // Contract: signed effect on the available balance; a cancelled hold never reached it.
        amount: 0,
        // The held points that were withdrawn, so consumers need no getEntry() round trip.
        pendingAmount: entry.amount,
        reason: input.reason,
        availableBalance: updated.availableBalance,
      },
      now,
    );
    return toLedgerEntry(cancelled);
  }

  /**
   * Takes back an available or consumed credit with a negative `reverse` row. Points come out of
   * the credit's own bucket first, then the latest-expiring ones; whatever the buckets cannot
   * cover drives the balance negative (spending blocked until it is positive again).
   */
  private async reverseCredit(
    db: Tx,
    account: AccountRecord,
    entry: EntryRecord,
    input: ReversePointsInput,
    key: string,
    now: Date,
  ): Promise<LedgerEntry> {
    if (entry.state === 'available') {
      await this.repo.updateEntryState(db, entry.id, 'spent');
    }
    const buckets = await this.repo.listBuckets(account.id, db);
    const preferred = entry.expiresAt ? bucketDayKey(entry.expiresAt) : undefined;
    const { taken } = reduceBuckets(buckets, entry.amount, preferred);
    await this.applyTaken(db, account.id, buckets, taken);

    const row = await this.insertEntry(db, {
      id: uuidv7(),
      accountId: account.id,
      userId: account.userId,
      type: 'reverse',
      state: 'spent',
      amount: -entry.amount,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      idempotencyKey: key,
      availableAt: null,
      expiresAt: null,
      reason: input.reason,
      createdById: input.createdById ?? null,
      createdAt: now,
      ...this.display(input, 'reverse', entry.sourceType, -entry.amount),
    });
    // Same bookkeeping as a spend, so a later refund of this reversal restores these buckets.
    await this.repo.insertSpendAllocations(db, row.id, taken);
    const updated = await this.repo.updateAccount(db, account.id, {
      availableBalance: account.availableBalance - entry.amount,
      lifetimeEarned: LIFETIME_TYPES.includes(entry.type)
        ? Math.max(account.lifetimeEarned - entry.amount, 0)
        : account.lifetimeEarned,
    });
    await this.publish(
      db,
      CLUB_EVENTS.reversed,
      OUTBOX_AGGREGATES.pointsTransaction,
      row.id,
      {
        userId: account.userId,
        accountId: account.id,
        txId: row.id,
        reversedTxId: entry.id,
        amount: -entry.amount,
        pendingAmount: 0,
        reason: input.reason,
        availableBalance: updated.availableBalance,
      },
      now,
    );
    return toLedgerEntry(row);
  }

  /**
   * Returns the points of a negative row (spend, negative adjust, reversal, expiry) as a
   * `refund` credit. The points go back into the buckets the debit consumed, with their
   * original expiry (points_spend_allocations), so redeem-then-cancel never extends the 12-month
   * TTL; rows without allocations (expiry rows, debits posted before allocations existed) get
   * a fresh `now + pointsTtlMonths`. A negative balance is settled first (FIFO by day); the
   * portions whose day already ended are expired at once with a second, `expire` row, so the
   * member sees both "refund" and "expired" in the history.
   */
  private async refundDebit(
    db: Tx,
    account: AccountRecord,
    entry: EntryRecord,
    input: ReversePointsInput,
    key: string,
    now: Date,
  ): Promise<LedgerEntry> {
    const amount = -entry.amount;
    const allocations = await this.repo.listSpendAllocations(entry.id, db);
    const freshExpiresAt = computeExpiresAt(now, (await this.rules(db)).pointsTtlMonths);
    const plan = planRefund({
      amount,
      allocations,
      freshDayKey: bucketDayKey(freshExpiresAt),
      availableBalance: account.availableBalance,
      todayKey: expiryCutoffDayKey(now),
    });
    for (const portion of plan.toBuckets) {
      await this.addToBucket(db, account.id, portion.dayKey, portion.amount);
    }

    // The row's own expiresAt is informative (it may span several buckets): the soonest bucket
    // the points went back to, else the last expired day, else the fresh TTL.
    const shownDay = plan.toBuckets[0]?.dayKey ?? plan.expired[plan.expired.length - 1]?.dayKey;
    const expiresAt =
      allocations.length === 0 || shownDay === undefined ? freshExpiresAt : dayEndInstant(shownDay);
    const allExpired = plan.toBuckets.length === 0 && plan.expiredTotal > 0;
    let row = await this.insertEntry(db, {
      id: uuidv7(),
      accountId: account.id,
      userId: account.userId,
      type: 'refund',
      state: 'available',
      amount,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      idempotencyKey: key,
      availableAt: now,
      expiresAt,
      reason: input.reason,
      createdById: input.createdById ?? null,
      createdAt: now,
      ...this.display(input, 'refund', entry.sourceType, amount),
    });
    let availableBalance = account.availableBalance + amount;
    let updated = await this.repo.updateAccount(db, account.id, { availableBalance });
    await this.publish(
      db,
      CLUB_EVENTS.reversed,
      OUTBOX_AGGREGATES.pointsTransaction,
      row.id,
      {
        userId: account.userId,
        accountId: account.id,
        txId: row.id,
        reversedTxId: entry.id,
        amount,
        pendingAmount: 0,
        reason: input.reason,
        availableBalance: updated.availableBalance,
      },
      now,
    );

    if (plan.expiredTotal > 0) {
      if (allExpired) {
        row = await this.repo.updateEntryState(db, row.id, 'expired');
      }
      const lastExpiredDay =
        plan.expired[plan.expired.length - 1]?.dayKey ?? expiryCutoffDayKey(now);
      // Same createdAt as the refund; the later UUID v7 lists it right above the refund.
      await this.insertEntry(db, {
        id: uuidv7(),
        accountId: account.id,
        userId: account.userId,
        type: 'expire',
        state: 'expired',
        amount: -plan.expiredTotal,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        idempotencyKey: refundExpiryKey(entry.id),
        availableAt: null,
        expiresAt: null,
        reason: EXPIRY_REASON,
        createdById: null,
        createdAt: now,
        ...resolvePointsDisplay(undefined, EXPIRE_TITLE, REFUND_EXPIRED_SUBTITLE),
      });
      availableBalance -= plan.expiredTotal;
      updated = await this.repo.updateAccount(db, account.id, { availableBalance });
      await this.publish(
        db,
        CLUB_EVENTS.expired,
        OUTBOX_AGGREGATES.loyaltyAccount,
        account.id,
        {
          userId: account.userId,
          accountId: account.id,
          points: plan.expiredTotal,
          expiredOn: lastExpiredDay,
          availableBalance: updated.availableBalance,
        },
        now,
      );
    }
    return toLedgerEntry(row);
  }

  private creditPayload(entry: EntryRecord, availableBalance: number) {
    return {
      userId: entry.userId,
      accountId: entry.accountId,
      txId: entry.id,
      type: entry.type,
      state: entry.state,
      amount: entry.amount,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      availableAt: isoOrNull(entry.availableAt),
      expiresAt: isoOrNull(entry.expiresAt),
      availableBalance,
    };
  }

  private async publish<T extends OutboxEventType>(
    db: Tx,
    type: T,
    aggregateType: TypedOutboxEventInput<T>['aggregateType'],
    aggregateId: string,
    payload: TypedOutboxEventInput<T>['payload'],
    now: Date,
  ): Promise<void> {
    await this.outbox.publish(db, buildOutboxEvent(type, aggregateType, aggregateId, payload, now));
  }

  private assertAmount(amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new DomainError(
        ClubErrors.PC_POINTS_INVALID_AMOUNT,
        'Points amount must be a positive integer',
        { details: { amount } },
      );
    }
  }

  private assertKey(key: string): void {
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new DomainError(
        CommonErrors.PC_COMMON_VALIDATION,
        `idempotencyKey must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      );
    }
  }

  private assertFutureExpiry(expiresAt: Date, availableFrom: Date): void {
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= availableFrom.getTime()) {
      throw new DomainError(
        CommonErrors.PC_COMMON_VALIDATION,
        'expiresAt must be later than the moment the points become available',
        {
          details: {
            expiresAt: Number.isNaN(expiresAt.getTime()) ? null : expiresAt.toISOString(),
          },
        },
      );
    }
  }

  private insufficient(available: number, required: number): DomainError {
    return new DomainError(ClubErrors.PC_POINTS_INSUFFICIENT, 'Not enough points', {
      details: { available: Math.max(available, 0), required },
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
