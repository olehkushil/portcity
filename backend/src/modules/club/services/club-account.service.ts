import { Inject, Injectable } from '@nestjs/common';
import type {
  LedgerEntry,
  PointsBalance,
  PointsTxState,
  PointsTxType,
  SpendBlockReason,
} from '../../../common/contracts/club';
import { IDENTITY_PORT, type IdentityPort } from '../../../common/contracts/identity';
import { APP_CONFIG, type AppConfig } from '../../../common/config';
import { DomainError } from '../../../common/errors/domain-error';
import { CommonErrors } from '../../../common/errors/error-codes';
import { type Page, clampLimit, toPage } from '../../../common/pagination/cursor';
import type { Tx } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { kyivDayKey, kyivLocalToUtc } from '../../../common/time/kyiv';
import { CLUB_CONFIG, type ClubConfig } from '../club.config';
import { type ExpiringSoon, expiringSoon } from '../domain/balance';
import { decodeTransactionCursor } from '../domain/cursor';
import { ClubErrors } from '../domain/errors';
import { addDaysToDayKey } from '../domain/expiry';
import { buildMemberQrPayload } from '../domain/member-qr';
import { planProfileBonuses } from '../domain/profile-bonus';
import {
  type WelcomeKind,
  type WelcomeState,
  decideWelcome,
  welcomeIdempotencyKey,
  welcomeReason,
} from '../domain/welcome';
import { type AccountPeriodTotals, type BucketRecord, ClubRepository } from './club.repository';
import { LedgerService } from './ledger.service';
import { toLedgerEntry, toPointsBalance } from './mappers';
import {
  PendingModerationReader,
  type PendingModerationSummary,
} from './pending-moderation.reader';
import { RuleSetsService } from './rule-sets.service';

/** Window of the "expiring soon" block when the rule set has no reminder days. */
export const DEFAULT_EXPIRING_SOON_DAYS = 30;

export interface WelcomeGrantOutcome {
  kind: WelcomeKind;
  granted: boolean;
  amount: number;
  txId: string | null;
}

export interface ClubAccountView {
  /** Null while the account has not been created yet (registration event not consumed). */
  accountId: string | null;
  userId: string;
  balance: number;
  pending: number;
  lifetimeEarned: number;
  memberCode: string;
  qrPayload: string;
  newcomerLockUntil: Date | null;
  spendBlockedBy: SpendBlockReason | null;
  expiringSoon: ExpiringSoon;
  pointValueKopecks: number;
  /** Receipts waiting for a moderator (RECEIPTS_PORT; zeros when receipts cannot answer). */
  pendingModeration: PendingModerationSummary;
}

/** `GET /club/transactions/summary?month=YYYY-MM`: totals of one Kyiv calendar month. */
export interface TransactionsSummaryView extends AccountPeriodTotals {
  month: string;
  /** UTC bounds `[from, to)` of the Kyiv month. */
  from: Date;
  to: Date;
}

export interface ProfileBonusOutcome {
  field: string;
  status: 'handled' | 'ignored';
  granted: Array<{ kind: 'field' | 'complete'; amount: number; txId: string }>;
  skipped: Array<{ kind: 'field' | 'complete'; reason: 'already_granted' }>;
}

export const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface AdminClubAccountView {
  balance: PointsBalance;
  welcomeState: WelcomeState;
  buckets: BucketRecord[];
  createdAt: Date;
}

export interface TransactionsQuery {
  cursor?: string;
  limit?: number;
  type?: PointsTxType;
  state?: PointsTxState;
  /** Inclusive lower bound on createdAt. */
  from?: Date;
  /** Exclusive upper bound on createdAt. */
  to?: Date;
}

/** UTC bounds `[from, to)` of a Kyiv calendar month `YYYY-MM`. */
export function kyivMonthBounds(month: string): { from: Date; to: Date } {
  const match = MONTH_PATTERN.exec(month);
  if (!match) {
    throw new DomainError(CommonErrors.PC_COMMON_VALIDATION, 'month must be YYYY-MM', {
      details: [{ path: 'month', messages: ['month must be YYYY-MM'] }],
    });
  }
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const from = kyivLocalToUtc({ year, month: monthNumber, day: 1 });
  const to =
    monthNumber === 12
      ? kyivLocalToUtc({ year: year + 1, month: 1, day: 1 })
      : kyivLocalToUtc({ year, month: monthNumber + 1, day: 1 });
  return { from, to };
}

/**
 * Member-facing side of the club: account creation on registration, welcome bonuses
 * (plan 12.2: 50 / 30 / 20, once per kind), the card view with the QR payload and the
 * transaction history. Money movements themselves go through LedgerService.
 */
@Injectable()
export class ClubAccountService {
  constructor(
    private readonly repo: ClubRepository,
    private readonly ledger: LedgerService,
    private readonly ruleSets: RuleSetsService,
    private readonly clock: Clock,
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLUB_CONFIG) private readonly clubConfig: ClubConfig,
    private readonly pendingModeration: PendingModerationReader,
  ) {}

  ensureAccount(userId: string, registeredAt?: Date, tx?: Tx): Promise<{ created: boolean }> {
    return this.ledger.ensureAccount(userId, registeredAt, tx).then(({ created }) => ({ created }));
  }

  /**
   * Grants the welcome bonus of `kind` once per member: the ledger key
   * `welcome:<kind>:<userId>` and the `welcomeState` flag are written in one transaction.
   * A bonus configured as 0 only sets the flag.
   */
  async grantWelcome(
    userId: string,
    kind: WelcomeKind,
    options: { sourceId?: string; registeredAt?: Date } = {},
    tx?: Tx,
  ): Promise<WelcomeGrantOutcome> {
    return this.repo.inTx(tx, async (db) => {
      await this.ledger.ensureAccount(userId, options.registeredAt, db);
      const account = await this.repo.lockAccountByUserId(db, userId);
      if (!account) {
        throw new DomainError(
          ClubErrors.PC_POINTS_ACCOUNT_NOT_FOUND,
          `Loyalty account for user ${userId} not found`,
        );
      }
      if (account.welcomeState[kind]) {
        return { kind, granted: false, amount: 0, txId: null };
      }
      const rules = (await this.ruleSets.getActiveRules(undefined, db)).rules;
      const decision = decideWelcome(account.welcomeState, kind, rules.welcome);
      let txId: string | null = null;
      if (decision.grant) {
        const entry = await this.ledger.credit(
          {
            userId,
            amount: decision.amount,
            type: 'welcome',
            sourceType: kind === 'firstReceipt' ? 'receipt' : 'system',
            ...(options.sourceId ? { sourceId: options.sourceId } : {}),
            idempotencyKey: welcomeIdempotencyKey(kind, userId),
            reason: welcomeReason(kind),
          },
          db,
        );
        txId = entry.id;
      }
      await this.repo.updateAccount(db, account.id, { welcomeState: decision.state });
      return { kind, granted: decision.grant, amount: decision.amount, txId };
    });
  }

  /**
   * Profile bonuses from `user.profile_field_completed` (domain/profile-bonus.ts): one bonus
   * per member and field plus one when the profile is complete. Idempotent by ledger key; the
   * account is created on first use like any credit.
   */
  async grantProfileFieldBonus(
    userId: string,
    field: string,
    completedAll: boolean,
    tx?: Tx,
  ): Promise<ProfileBonusOutcome> {
    const plan = planProfileBonuses(userId, field, completedAll, {
      perField: this.clubConfig.PROFILE_BONUS_PER_FIELD,
      complete: this.clubConfig.PROFILE_BONUS_COMPLETE,
    });
    const outcome: ProfileBonusOutcome = { field, status: 'handled', granted: [], skipped: [] };
    if (!plan.ok) {
      return { ...outcome, status: 'ignored' };
    }
    return this.repo.inTx(tx, async (db) => {
      for (const bonus of plan.bonuses) {
        if (await this.repo.findEntryByKey(bonus.idempotencyKey, db)) {
          outcome.skipped.push({ kind: bonus.kind, reason: 'already_granted' });
          continue;
        }
        const entry = await this.ledger.credit(
          {
            userId,
            amount: bonus.amount,
            type: 'welcome',
            sourceType: 'system',
            idempotencyKey: bonus.idempotencyKey,
            reason: bonus.title,
            title: bonus.title,
            subtitle: bonus.subtitle,
          },
          db,
        );
        outcome.granted.push({ kind: bonus.kind, amount: bonus.amount, txId: entry.id });
      }
      return outcome;
    });
  }

  /** `GET /club/account`: balances, card QR, newcomer lock and points expiring soon. */
  async getAccountView(userId: string): Promise<ClubAccountView> {
    const [user, account, active, pendingModeration] = await Promise.all([
      this.identity.getUser(userId),
      this.repo.findAccountByUserId(userId),
      this.ruleSets.getActiveRules(),
      this.pendingModeration.getPendingSummary(userId),
    ]);
    if (!user || user.status === 'deleted') {
      throw new DomainError(ClubErrors.PC_POINTS_ACCOUNT_NOT_FOUND, 'Member not found');
    }
    const now = this.clock.now();
    const buckets = account ? await this.repo.listBuckets(account.id) : [];
    const withinDays = active.rules.expiryReminderDays[0] ?? DEFAULT_EXPIRING_SOON_DAYS;
    const todayKey = kyivDayKey(now);
    const balance = account ? toPointsBalance(account, now) : null;
    return {
      accountId: account?.id ?? null,
      userId,
      balance: balance?.available ?? 0,
      pending: balance?.pending ?? 0,
      lifetimeEarned: balance?.lifetimeEarned ?? 0,
      memberCode: user.memberCode,
      qrPayload: buildMemberQrPayload(this.config.MEMBER_QR_SECRET, user.memberCode),
      newcomerLockUntil: balance?.newcomerLockUntil ?? null,
      spendBlockedBy: balance?.spendBlockedBy ?? null,
      expiringSoon: expiringSoon(
        buckets,
        todayKey,
        addDaysToDayKey(todayKey, withinDays),
        withinDays,
      ),
      pointValueKopecks: active.rules.pointValueKopecks,
      pendingModeration,
    };
  }

  /** `GET /club/transactions`: newest first, cursor pagination, optional `[from, to)` window. */
  async listTransactions(userId: string, query: TransactionsQuery): Promise<Page<LedgerEntry>> {
    if (query.from && query.to && query.from.getTime() >= query.to.getTime()) {
      throw new DomainError(CommonErrors.PC_COMMON_VALIDATION, 'from must be earlier than to', {
        details: [{ path: 'to', messages: ['to must be later than from'] }],
      });
    }
    const account = await this.repo.findAccountByUserId(userId);
    const limit = clampLimit(query.limit);
    const cursor = decodeTransactionCursor(query.cursor);
    if (!account) {
      return { items: [], nextCursor: null };
    }
    const rows = await this.repo.listEntries({
      accountId: account.id,
      limit: limit + 1,
      ...(cursor ? { cursor } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
    });
    const page = toPage(rows, limit, (last) => ({ c: last.createdAt.toISOString(), i: last.id }));
    return { items: page.items.map(toLedgerEntry), nextCursor: page.nextCursor };
  }

  /**
   * `GET /club/transactions/summary?month=YYYY-MM` (default: the current Kyiv month): earned,
   * spent, expired, refunded and reversed points of the month, all positive numbers.
   */
  async getTransactionsSummary(userId: string, month?: string): Promise<TransactionsSummaryView> {
    const key = month ?? kyivDayKey(this.clock.now()).slice(0, 7);
    const { from, to } = kyivMonthBounds(key);
    const account = await this.repo.findAccountByUserId(userId);
    const totals: AccountPeriodTotals = account
      ? await this.repo.sumAccountPeriod(account.id, from, to)
      : { earned: 0, spent: 0, expired: 0, refunded: 0, reversed: 0 };
    return { month: key, from, to, ...totals };
  }

  /** `GET /admin/club/accounts/:userId`. */
  async getAdminAccountView(userId: string): Promise<AdminClubAccountView> {
    const account = await this.repo.findAccountByUserId(userId);
    if (!account) {
      throw new DomainError(
        ClubErrors.PC_POINTS_ACCOUNT_NOT_FOUND,
        `User ${userId} has no loyalty account`,
      );
    }
    const buckets = await this.repo.listBuckets(account.id);
    return {
      balance: toPointsBalance(account, this.clock.now()),
      welcomeState: account.welcomeState,
      buckets,
      createdAt: account.createdAt,
    };
  }
}
