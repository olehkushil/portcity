/**
 * Club contract: the points ledger and the active program rules.
 * Implemented by `src/modules/club` (ledger.service.ts), provided under CLUB_LEDGER_PORT.
 * Consumers: receipts (credit/hold after approval), rewards (spend on redemption, reverse on
 * cancellation), admin (manual adjustments, reports).
 *
 * Semantics (brief sections 4, 6, 7):
 * - every method runs in the caller's `tx` when given, otherwise in its own transaction;
 * - cached balances on LoyaltyAccount move in the same transaction under SELECT ... FOR UPDATE;
 * - write methods are idempotent by `idempotencyKey`: a replay returns the existing entry;
 * - `credit`/`hold` create the loyalty account on first use.
 */
import type { DateRange, Points, Tx, Uuid } from './shared';

export const CLUB_LEDGER_PORT = Symbol('CLUB_LEDGER_PORT');

export const POINTS_TX_TYPES = [
  'earn',
  'welcome',
  'spend',
  'hold',
  'release',
  'expire',
  'adjust',
  'reverse',
  'refund',
] as const;
export type PointsTxType = (typeof POINTS_TX_TYPES)[number];

export const POINTS_TX_STATES = ['pending', 'available', 'spent', 'expired', 'cancelled'] as const;
export type PointsTxState = (typeof POINTS_TX_STATES)[number];

export const POINTS_SOURCE_TYPES = [
  'receipt',
  'redemption',
  'manual',
  'promo',
  'event',
  'parking',
  'system',
] as const;
export type PointsSourceType = (typeof POINTS_SOURCE_TYPES)[number];

export interface WelcomeBonuses {
  register: Points;
  profile: Points;
  firstReceipt: Points;
}

/** Shape of LoyaltyRuleSet.config (brief section 4, plan 12.2). */
export interface LoyaltyRules {
  baseRatePercent: number;
  maxPointsPerReceipt: Points;
  minReceiptTotalKopecks: number;
  dailyReceiptLimit: number;
  autoApproveThresholdKopecks: number;
  holdThresholdKopecks: number;
  holdDays: number;
  uploadWindowDays: number;
  pointsTtlMonths: number;
  newcomerLockHours: number;
  welcome: WelcomeBonuses;
  /** Value of one point in kopecks (100 = 1 UAH). */
  pointValueKopecks: number;
  /** Days before expiry at which `points.expiring` reminders are emitted. */
  expiryReminderDays: number[];
}

export const DEFAULT_LOYALTY_RULES: LoyaltyRules = Object.freeze({
  baseRatePercent: 3,
  maxPointsPerReceipt: 500,
  minReceiptTotalKopecks: 0,
  dailyReceiptLimit: 10,
  autoApproveThresholdKopecks: 100_000,
  holdThresholdKopecks: 300_000,
  holdDays: 7,
  uploadWindowDays: 7,
  pointsTtlMonths: 12,
  newcomerLockHours: 72,
  welcome: Object.freeze({ register: 50, profile: 30, firstReceipt: 20 }),
  pointValueKopecks: 100,
  expiryReminderDays: [30, 7],
});

export interface ActiveRuleSet {
  id: Uuid;
  version: number;
  activeFrom: Date;
  rules: LoyaltyRules;
}

/** Prefix of the club card QR payload `PC1:<memberCode>:<hmac8>`; hmac8 = first 8 hex chars of HMAC-SHA256(MEMBER_QR_SECRET, memberCode). */
export const MEMBER_QR_PREFIX = 'PC1';
export const MEMBER_QR_PATTERN = /^PC1:(\d{9}):([0-9a-f]{8})$/;

export type SpendBlockReason = 'negative_balance' | 'newcomer_lock';

export interface PointsBalance {
  accountId: Uuid;
  userId: Uuid;
  available: Points;
  pending: Points;
  lifetimeEarned: Points;
  newcomerLockUntil: Date | null;
  /** Null when spending is allowed right now. */
  spendBlockedBy: SpendBlockReason | null;
}

/**
 * Who or what is on the other side of a points row, as shown in the member's history
 * ("INTERTOP, чек на 6 000 ₴", "Кава з собою"). Free-form but typed; all fields optional.
 */
export interface PointsCounterparty {
  tenantId?: Uuid | null;
  tenantName?: string | null;
  receiptId?: Uuid | null;
  receiptTotalKopecks?: number | null;
  rewardId?: Uuid | null;
  rewardTitle?: string | null;
  voucherId?: Uuid | null;
}

/**
 * Optional display data of a ledger row, written once at posting time (the ledger is
 * append-only, so it can never be edited later). When a caller omits it the club writes a
 * generic title derived from the row type.
 */
export interface PointsDisplayInput {
  /** Main history line, e.g. "Нарахування за чек" (max 200 characters). */
  title?: string;
  /** Second line, e.g. "INTERTOP, 1 поверх" (max 300 characters). */
  subtitle?: string;
  counterparty?: PointsCounterparty;
}

export interface LedgerEntry {
  id: Uuid;
  accountId: Uuid;
  userId: Uuid;
  type: PointsTxType;
  state: PointsTxState;
  /** Signed: positive for credits, negative for spend/reverse/expire rows. */
  amount: Points;
  sourceType: PointsSourceType;
  sourceId: Uuid | null;
  idempotencyKey: string | null;
  availableAt: Date | null;
  expiresAt: Date | null;
  reason: string | null;
  createdById: Uuid | null;
  createdAt: Date;
  /** Display data (null on rows posted before it existed); optional for fakes of the port. */
  title?: string | null;
  subtitle?: string | null;
  counterparty?: PointsCounterparty | null;
}

export interface CreditPointsInput extends PointsDisplayInput {
  userId: Uuid;
  /** Positive integer. */
  amount: Points;
  /** Defaults to `earn`. */
  type?: Extract<PointsTxType, 'earn' | 'welcome' | 'adjust'>;
  sourceType: PointsSourceType;
  sourceId?: Uuid;
  /** Unique per logical operation, e.g. `receipt:<receiptId>`, `welcome:register:<userId>`. */
  idempotencyKey: string;
  /** Overrides the default expiry (`availableAt + pointsTtlMonths`). */
  expiresAt?: Date;
  reason?: string;
  /** AdminUser id for manual rows. */
  createdById?: Uuid;
}

/** A credit that stays `pending` until `availableAt` (receipts above holdThresholdKopecks). */
export interface HoldPointsInput extends CreditPointsInput {
  availableAt: Date;
}

export interface SpendPointsInput extends PointsDisplayInput {
  userId: Uuid;
  /** Positive integer; the ledger row is written with a negative amount. */
  amount: Points;
  sourceType: PointsSourceType;
  sourceId?: Uuid;
  /** Unique per logical operation, e.g. `redemption:<redemptionId>`. */
  idempotencyKey: string;
  reason?: string;
  createdById?: Uuid;
}

export interface ReversePointsInput extends PointsDisplayInput {
  /**
   * The ledger row to reverse: a credit (points are taken back) or a spend (points are
   * returned into the expiry buckets the spend consumed, with their original expiry; portions
   * whose expiry already passed are expired at once, shown as refund + expire in the history).
   */
  txId: Uuid;
  /** Unique per logical operation, e.g. `voucher-cancel:<voucherId>`. */
  idempotencyKey: string;
  reason: string;
  createdById?: Uuid;
}

export interface PointsDailyStats {
  earned: Points;
  spent: Points;
  expired: Points;
  reversed: Points;
}

export interface ClubLedgerPort {
  /** Null when the user has no loyalty account yet. */
  getBalance(userId: Uuid, tx?: Tx): Promise<PointsBalance | null>;
  getEntry(txId: Uuid, tx?: Tx): Promise<LedgerEntry | null>;
  /** Rule set active at `at` (default now); falls back to DEFAULT_LOYALTY_RULES when none is stored. */
  getActiveRules(at?: Date): Promise<ActiveRuleSet>;
  /** Immediately available points. */
  credit(input: CreditPointsInput, tx?: Tx): Promise<LedgerEntry>;
  /** Pending points, released by `release()` or the hourly points-release-holds job. */
  hold(input: HoldPointsInput, tx?: Tx): Promise<LedgerEntry>;
  /** pending -> available; idempotent (a released entry is returned as is). */
  release(txId: Uuid, tx?: Tx): Promise<LedgerEntry>;
  /**
   * FIFO by expiry. Throws PC_POINTS_INSUFFICIENT, PC_POINTS_ACCOUNT_NEGATIVE or
   * PC_POINTS_NEWCOMER_LOCK (all 422) when spending is not allowed.
   * `sourceType: 'manual'` (back-office deduction) is written as a negative `adjust` row and is
   * not subject to the newcomer lock; balance checks still apply. Other sources write `spend`.
   */
  spend(input: SpendPointsInput, tx?: Tx): Promise<LedgerEntry>;
  /**
   * Pending credit -> cancelled (returns the cancelled entry). Available/spent rows get a
   * compensating row (`reverse` for credits, `refund` for spends); a reversed credit may drive
   * the balance negative, which blocks spending until it is positive again.
   */
  reverse(input: ReversePointsInput, tx?: Tx): Promise<LedgerEntry>;
  getDailyStats(range: DateRange): Promise<PointsDailyStats>;
}

export const CLUB_ERROR_CODES = [
  'PC_POINTS_INSUFFICIENT',
  'PC_POINTS_ACCOUNT_NEGATIVE',
  'PC_POINTS_NEWCOMER_LOCK',
  'PC_POINTS_ACCOUNT_NOT_FOUND',
  'PC_POINTS_TX_NOT_FOUND',
  'PC_POINTS_INVALID_TRANSITION',
  'PC_POINTS_INVALID_AMOUNT',
  'PC_RULESET_NOT_FOUND',
  'PC_RULESET_VERSION_TAKEN',
] as const;
export type ClubErrorCode = (typeof CLUB_ERROR_CODES)[number];
