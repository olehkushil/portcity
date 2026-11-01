/**
 * Receipts contract: read access to receipts and the shape of a submission result.
 * Implemented by `src/modules/receipts`, provided under RECEIPTS_PORT.
 * Consumers: admin (reports). Submission, moderation and appeals are HTTP endpoints hosted by
 * the receipts module itself; points are credited through CLUB_LEDGER_PORT.
 */
import type { DateRange, Kopecks, Points, Uuid } from './shared';

export const RECEIPTS_PORT = Symbol('RECEIPTS_PORT');

export const RECEIPT_STATUSES = [
  'uploaded',
  'parsed',
  'auto_approved',
  'needs_moderation',
  'approved',
  'rejected',
  'credited',
  'appealed',
] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export const RECEIPT_SOURCES = ['qr', 'manual'] as const;
export type ReceiptSource = (typeof RECEIPT_SOURCES)[number];

/** Non-blocking risk flags stored in Receipt.riskFlags (brief section 7). */
export const RISK_FLAGS = ['fast_submit', 'fn_unknown', 'high_total', 'device_shared'] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];

/** Tax-service receipt URL accepted by the QR parser (http or https, with or without www). */
export const TAX_QR_HOST = 'cabinet.tax.gov.ua';
export const TAX_QR_PATH = '/cashregs/check';

export interface ReceiptSummary {
  id: Uuid;
  userId: Uuid;
  deviceId: Uuid | null;
  /** Canonical cash register number; null for a manual receipt the moderator has not completed. */
  fn: string | null;
  /** Canonical receipt number (upper case, no separators, numeric ids without leading zeros). */
  fiscalId: string;
  issuedAt: Date;
  totalKopecks: Kopecks;
  source: ReceiptSource;
  tenantId: Uuid | null;
  status: ReceiptStatus;
  riskFlags: RiskFlag[];
  riskScore: number;
  pointsAwarded: Points | null;
  pointsTxId: Uuid | null;
  moderatorId: Uuid | null;
  decisionReason: string | null;
  decidedAt: Date | null;
  submittedAt: Date;
}

export type ReceiptSubmissionOutcome =
  /** Auto-approved and credited; points available now. */
  | 'credited'
  /** Auto-approved; points pending until `pointsAvailableAt` (total above holdThresholdKopecks). */
  | 'held'
  /** Waiting for a moderator. */
  | 'needs_moderation'
  /** Rejected by a rule; `rejectionCode` says why. */
  | 'rejected'
  /** Auto-approved or approved; points are being credited by the receipts-process job. */
  | 'processing';

/** Result screens of the prototype: scan-result, scan-pending, scan-rejected. */
export const SUBMISSION_SCREENS = ['credited', 'pending', 'rejected'] as const;
export type SubmissionScreen = (typeof SUBMISSION_SCREENS)[number];

/**
 * Service-level result of POST /receipts/qr and POST /receipts/manual. The HTTP response
 * (ReceiptSubmissionResultDto in the receipts module) carries the same fields but exposes a
 * member-safe projection of `receipt` (no riskFlags, riskScore, userId or moderatorId).
 */
export interface ReceiptSubmissionResult {
  receipt: ReceiptSummary;
  outcome: ReceiptSubmissionOutcome;
  /** `credited` for credited/held, `pending` for needs_moderation/processing, `rejected`. */
  screen: SubmissionScreen;
  /** Screen title in Ukrainian, e.g. "Чек зараховано". */
  title: string;
  /** One or two sentences in Ukrainian under the title. */
  message: string;
  pointsAwarded: Points | null;
  pointsAvailableAt: Date | null;
  rejectionCode: ReceiptErrorCode | null;
  /** "Причина перевірки" lines (Ukrainian) for the pending screen; empty otherwise. */
  moderationReasons: string[];
}

export interface ReceiptDailyStats {
  submitted: number;
  byStatus: Partial<Record<ReceiptStatus, number>>;
  pointsAwarded: Points;
}

/**
 * Receipts of a member that are not settled yet: waiting for a moderator (`needs_moderation`,
 * `appealed`) or still being processed (`uploaded`, `parsed`, `auto_approved`, `approved`).
 * `expectedPoints` uses the same points formula as the credit (tenant rule, override or base
 * rate, `maxPointsPerReceipt`), without the tenant daily cap; it is an estimate for the
 * "на перевірці" line of the club card, never a promise.
 */
export interface ReceiptPendingSummary {
  count: number;
  expectedPoints: Points;
}

/** Statuses counted by `ReceiptsPort.getPendingSummary`. */
export const RECEIPT_PENDING_STATUSES = [
  'uploaded',
  'parsed',
  'auto_approved',
  'needs_moderation',
  'approved',
  'appealed',
] as const satisfies readonly ReceiptStatus[];

export interface ReceiptsPort {
  getReceipt(receiptId: Uuid): Promise<ReceiptSummary | null>;
  /** Number of receipts a user submitted in the range (daily limit checks, reports). */
  countForUser(userId: Uuid, range: DateRange): Promise<number>;
  getDailyStats(range: DateRange): Promise<ReceiptDailyStats>;
  /** Unsettled receipts of the member and the points they would earn (club card "pending"). */
  getPendingSummary(userId: Uuid): Promise<ReceiptPendingSummary>;
}

export const RECEIPT_ERROR_CODES = [
  'PC_RECEIPT_QR_INVALID',
  'PC_RECEIPT_DUPLICATE',
  'PC_RECEIPT_TOO_OLD',
  'PC_RECEIPT_FUTURE',
  'PC_RECEIPT_EXCLUDED_TENANT',
  'PC_RECEIPT_TOTAL_INVALID',
  'PC_RECEIPT_NOT_FOUND',
  'PC_RECEIPT_INVALID_TRANSITION',
  'PC_RECEIPT_APPEAL_NOT_ALLOWED',
  'PC_RECEIPT_PHOTO_REQUIRED',
  'PC_RECEIPT_PHOTO_INVALID',
  /** 403: feature flag receipts.manual_submission is off. */
  'PC_RECEIPT_MANUAL_DISABLED',
  /** Rule code: the tax checker rejected the receipt during its verification hold. */
  'PC_RECEIPT_NOT_VERIFIED',
] as const;
export type ReceiptErrorCode = (typeof RECEIPT_ERROR_CODES)[number];
