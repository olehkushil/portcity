/**
 * Risk, auto-approval and points rules (brief section 7). Pure functions over plain objects;
 * the service layer gathers the inputs (whitelist lookup, counts, device checks).
 */
import { addMonths } from 'date-fns';
import type { LoyaltyRules } from '../../../common/contracts/club';
import type { FiscalNumberStatus } from '../../../common/contracts/content';
import type { ReceiptSource, RiskFlag } from '../../../common/contracts/receipts';
import { pointsFromKopecks } from '../../../common/money/money';
import { addKyivDays, toKyiv } from '../../../common/time/kyiv';
import { numericFiscalId } from './fiscal-ids';

/** A receipt dated more than this far ahead of the clock is rejected (clock skew allowance). */
export const FUTURE_TOLERANCE_MS = 10 * 60_000;
/** `fast_submit`: scanned less than two minutes after the cash register printed it. */
export const FAST_SUBMIT_MS = 2 * 60_000;
/** More than this many receipts from one cash register by one member within the window -> moderation. */
export const SAME_FN_BURST_LIMIT = 3;
export const SAME_FN_BURST_WINDOW_MS = 10 * 60_000;
/** `device_shared`: another member used the same device within this window. */
export const DEVICE_SHARED_WINDOW_MS = 24 * 3_600_000;
export const MAX_RISK_SCORE = 100;

export const RISK_FLAG_WEIGHTS: Readonly<Record<RiskFlag, number>> = Object.freeze({
  fn_unknown: 60,
  high_total: 40,
  device_shared: 30,
  fast_submit: 20,
});

export const MODERATION_REASONS = [
  'manual_submission',
  'fn_not_whitelisted',
  'fn_blocked',
  'total_above_threshold',
  'daily_limit_reached',
  'same_fn_burst',
  /** The member's QR points today plus this receipt exceed RECEIPTS_DAILY_POINTS_CAP. */
  'daily_points_cap',
  /** Another member submitted a receipt with the same total from the same fn within 24 h. */
  'same_total_other_user',
  /** A round total (whole hundreds of UAH) again from the same member within 30 days. */
  'round_total_repeat',
  /** A lower receipt number of the same fn was issued later than a higher one (or vice versa). */
  'fiscal_id_out_of_order',
  /** TaxReceiptVerifierPort answered "rejected". */
  'tax_check_failed',
] as const;
export type ModerationReason = (typeof MODERATION_REASONS)[number];

/** Weights of moderation reasons that are not already covered by a risk flag. */
export const MODERATION_REASON_WEIGHTS: Readonly<Partial<Record<ModerationReason, number>>> =
  Object.freeze({
    fn_blocked: 50,
    same_fn_burst: 30,
    daily_limit_reached: 20,
    daily_points_cap: 20,
    same_total_other_user: 40,
    round_total_repeat: 30,
    fiscal_id_out_of_order: 50,
    tax_check_failed: 60,
  });

/** Answers of TaxReceiptVerifierPort (the tax service has no public API: noop says unknown). */
export const TAX_CHECK_STATUSES = ['confirmed', 'rejected', 'unknown'] as const;
export type TaxCheckStatus = (typeof TAX_CHECK_STATUSES)[number];

/** `same_total_other_user`: look back this far for the same (fn, total) from another member. */
export const SAME_TOTAL_WINDOW_MS = 24 * 3_600_000;
/** A total is "round" when it is a positive multiple of 100 UAH. */
export const ROUND_TOTAL_STEP_KOPECKS = 10_000;
/** `round_total_repeat`: window and how many other round totals of the member trigger it. */
export const ROUND_TOTAL_WINDOW_MS = 30 * 86_400_000;
export const ROUND_TOTAL_REPEAT_MIN = 1;
/** `fiscal_id_out_of_order`: receipts closer in time than this are never compared. */
export const FISCAL_ID_ORDER_TOLERANCE_MS = 60_000;
/** How many receipts of the same fn on each side of `issuedAt` are compared. */
export const FISCAL_ID_ORDER_NEIGHBOURS = 20;

export type ReceiptRejectionCode =
  | 'PC_RECEIPT_TOO_OLD'
  | 'PC_RECEIPT_FUTURE'
  | 'PC_RECEIPT_EXCLUDED_TENANT'
  | 'PC_RECEIPT_TOTAL_INVALID'
  /** Set by the backfill of canonical fiscal ids on later copies of the same receipt. */
  | 'PC_RECEIPT_DUPLICATE'
  /** The tax checker rejected a receipt during its verification hold. */
  | 'PC_RECEIPT_NOT_VERIFIED';

export interface RuleFiscalNumber {
  status: FiscalNumberStatus;
  tenantId: string | null;
}

export interface RuleTenant {
  id: string;
  name: string;
  participates: boolean;
  excludedFromProgram: boolean;
  ratePercentOverride: number | null;
}

export interface RuleTenantRule {
  /** Null means "use the tenant override or the base rate". */
  ratePercent: number | null;
  minTotalKopecks: number;
  /** Per member, per tenant, per Kyiv day. */
  dailyCapPoints: number | null;
}

export interface ReceiptRuleInput {
  source: ReceiptSource;
  fn: string;
  issuedAt: Date;
  totalKopecks: number;
  /** When the member submitted the receipt (fast_submit). */
  submittedAt: Date;
  /** Decision time (window checks). Equals submittedAt on the synchronous path. */
  now: Date;
  fiscalNumber: RuleFiscalNumber | null;
  tenant: RuleTenant | null;
  tenantRule: RuleTenantRule | null;
  /** Receipts the member already submitted today (Kyiv day), excluding this one. */
  receiptsToday: number;
  /** Receipts from the same fn by the same member within SAME_FN_BURST_WINDOW_MS, excluding this one. */
  sameFnRecent: number;
  deviceShared: boolean;
  rules: LoyaltyRules;
  /** Points already credited to the member today (Kyiv day) for QR receipts. */
  qrPointsToday?: number;
  /** RECEIPTS_DAILY_POINTS_CAP; null or undefined switches the cap off. */
  dailyQrPointsCap?: number | null;
  /** Fraud patterns found by the service (each one forces moderation). */
  patterns?: ReceiptPatterns;
  /** Answer of TaxReceiptVerifierPort; `rejected` forces moderation. */
  taxCheck?: TaxCheckStatus;
}

export interface ReceiptPatterns {
  sameTotalOtherUser: boolean;
  roundTotalRepeat: boolean;
  fiscalIdOutOfOrder: boolean;
}

export const NO_PATTERNS: Readonly<ReceiptPatterns> = Object.freeze({
  sameTotalOtherUser: false,
  roundTotalRepeat: false,
  fiscalIdOutOfOrder: false,
});

/** True for a positive multiple of ROUND_TOTAL_STEP_KOPECKS (100.00, 500.00, 1 200.00 UAH). */
export function isRoundTotal(totalKopecks: number): boolean {
  return (
    Number.isSafeInteger(totalKopecks) &&
    totalKopecks >= ROUND_TOTAL_STEP_KOPECKS &&
    totalKopecks % ROUND_TOTAL_STEP_KOPECKS === 0
  );
}

/** `round_total_repeat`: this total is round and the member sent other round totals recently. */
export function isRoundTotalRepeat(
  totalKopecks: number,
  otherRecentTotals: readonly number[],
): boolean {
  return (
    isRoundTotal(totalKopecks) &&
    otherRecentTotals.filter((total) => isRoundTotal(total)).length >= ROUND_TOTAL_REPEAT_MIN
  );
}

export interface FiscalIdPoint {
  /** Canonical receipt number. */
  fiscalId: string;
  issuedAt: Date;
}

/**
 * `fiscal_id_out_of_order`: receipt numbers of one cash register grow with time, so a lower
 * number printed later than a higher one (or a higher number printed earlier than a lower one)
 * cannot both be genuine. Only numeric ids are compared; receipts closer in time than
 * `toleranceMs` are ignored (clock drift of the register).
 */
export function isFiscalIdOutOfOrder(
  current: FiscalIdPoint,
  neighbours: readonly FiscalIdPoint[],
  toleranceMs: number = FISCAL_ID_ORDER_TOLERANCE_MS,
): boolean {
  const number = numericFiscalId(current.fiscalId);
  if (number === null) {
    return false;
  }
  for (const other of neighbours) {
    const otherNumber = numericFiscalId(other.fiscalId);
    if (otherNumber === null || otherNumber === number) {
      continue;
    }
    const laterBy = current.issuedAt.getTime() - other.issuedAt.getTime();
    if (number < otherNumber && laterBy > toleranceMs) {
      return true;
    }
    if (number > otherNumber && -laterBy > toleranceMs) {
      return true;
    }
  }
  return false;
}

/** Daily QR cap: true when crediting `points` would take the member above `cap` today. */
export function exceedsDailyQrCap(
  pointsToday: number,
  points: number,
  cap: number | null | undefined,
): boolean {
  return cap !== null && cap !== undefined && points > 0 && pointsToday + points > cap;
}

export interface RiskAssessment {
  flags: RiskFlag[];
  score: number;
}

export type ReceiptDecision =
  | {
      kind: 'rejected';
      code: ReceiptRejectionCode;
      /** Member-facing reason (Ukrainian), stored in Receipt.decisionReason. */
      reason: string;
      /** Technical detail for the event trail. */
      detail: string;
      risk: RiskAssessment;
    }
  | { kind: 'needs_moderation'; reasons: ModerationReason[]; risk: RiskAssessment }
  | { kind: 'auto_approved'; risk: RiskAssessment };

export const REJECTION_REASONS_UK: Readonly<Record<ReceiptRejectionCode, string>> = Object.freeze({
  PC_RECEIPT_TOO_OLD: 'Чек подано пізніше за дозволене вікно завантаження',
  PC_RECEIPT_FUTURE: 'Дата і час чека ще не настали',
  PC_RECEIPT_EXCLUDED_TENANT: 'Магазин не бере участі в програмі лояльності',
  PC_RECEIPT_TOTAL_INVALID: 'Сума чека не дає балів за правилами програми',
  PC_RECEIPT_DUPLICATE: 'Цей чек уже зареєстровано в програмі',
  PC_RECEIPT_NOT_VERIFIED: 'Податкова служба не підтвердила цей чек',
});

function isFnWhitelisted(fiscalNumber: RuleFiscalNumber | null): boolean {
  return fiscalNumber !== null && fiscalNumber.status === 'active';
}

export function assessRisk(
  input: Pick<
    ReceiptRuleInput,
    'issuedAt' | 'submittedAt' | 'totalKopecks' | 'fiscalNumber' | 'deviceShared' | 'rules'
  >,
  extraReasons: readonly ModerationReason[] = [],
): RiskAssessment {
  const flags: RiskFlag[] = [];
  const sinceIssue = input.submittedAt.getTime() - input.issuedAt.getTime();
  if (sinceIssue >= 0 && sinceIssue < FAST_SUBMIT_MS) {
    flags.push('fast_submit');
  }
  if (!isFnWhitelisted(input.fiscalNumber)) {
    flags.push('fn_unknown');
  }
  if (input.totalKopecks > input.rules.autoApproveThresholdKopecks) {
    flags.push('high_total');
  }
  if (input.deviceShared) {
    flags.push('device_shared');
  }
  let score = flags.reduce((sum, flag) => sum + RISK_FLAG_WEIGHTS[flag], 0);
  for (const reason of extraReasons) {
    score += MODERATION_REASON_WEIGHTS[reason] ?? 0;
  }
  return { flags, score: Math.min(MAX_RISK_SCORE, score) };
}

/** Minimum total that still earns points: program-wide floor and the tenant rule floor. */
export function minimumTotalKopecks(
  rules: LoyaltyRules,
  tenantRule: RuleTenantRule | null,
): number {
  return Math.max(rules.minReceiptTotalKopecks, tenantRule?.minTotalKopecks ?? 0, 1);
}

export function evaluateReceipt(input: ReceiptRuleInput): ReceiptDecision {
  const nowMs = input.now.getTime();
  const issuedMs = input.issuedAt.getTime();
  const uploadWindowMs = input.rules.uploadWindowDays * 86_400_000;
  const reject = (
    code: ReceiptRejectionCode,
    detail: string,
    extraReasons: readonly ModerationReason[] = [],
  ): ReceiptDecision => ({
    kind: 'rejected',
    code,
    reason: REJECTION_REASONS_UK[code],
    detail,
    risk: assessRisk(input, extraReasons),
  });

  if (issuedMs - nowMs > FUTURE_TOLERANCE_MS) {
    return reject(
      'PC_RECEIPT_FUTURE',
      `issuedAt ${input.issuedAt.toISOString()} is more than 10 minutes after ${input.now.toISOString()}`,
    );
  }
  if (nowMs - issuedMs > uploadWindowMs) {
    return reject(
      'PC_RECEIPT_TOO_OLD',
      `issuedAt ${input.issuedAt.toISOString()} is older than ${input.rules.uploadWindowDays} days`,
    );
  }
  if (input.tenant && (input.tenant.excludedFromProgram || !input.tenant.participates)) {
    return reject(
      'PC_RECEIPT_EXCLUDED_TENANT',
      input.tenant.excludedFromProgram
        ? `tenant ${input.tenant.id} is excluded from the program`
        : `tenant ${input.tenant.id} does not participate`,
    );
  }
  const minimum = minimumTotalKopecks(input.rules, input.tenantRule);
  if (input.totalKopecks < minimum) {
    return reject(
      'PC_RECEIPT_TOTAL_INVALID',
      `total ${input.totalKopecks} is below the minimum ${minimum} kopecks`,
    );
  }
  if (
    computePoints({
      totalKopecks: input.totalKopecks,
      rules: input.rules,
      tenant: input.tenant,
      tenantRule: input.tenantRule,
    }) <= 0
  ) {
    return reject(
      'PC_RECEIPT_TOTAL_INVALID',
      `total ${input.totalKopecks} kopecks earns 0 points at ${effectiveRatePercent(input)}%`,
    );
  }

  const reasons: ModerationReason[] = [];
  if (input.source === 'manual') {
    reasons.push('manual_submission');
  }
  if (input.fiscalNumber?.status === 'blocked') {
    reasons.push('fn_blocked');
  } else if (!isFnWhitelisted(input.fiscalNumber)) {
    reasons.push('fn_not_whitelisted');
  }
  if (input.totalKopecks > input.rules.autoApproveThresholdKopecks) {
    reasons.push('total_above_threshold');
  }
  if (input.receiptsToday >= input.rules.dailyReceiptLimit) {
    reasons.push('daily_limit_reached');
  }
  if (input.sameFnRecent >= SAME_FN_BURST_LIMIT) {
    reasons.push('same_fn_burst');
  }
  const patterns = input.patterns ?? NO_PATTERNS;
  if (patterns.sameTotalOtherUser) {
    reasons.push('same_total_other_user');
  }
  if (patterns.roundTotalRepeat) {
    reasons.push('round_total_repeat');
  }
  if (patterns.fiscalIdOutOfOrder) {
    reasons.push('fiscal_id_out_of_order');
  }
  if (input.taxCheck === 'rejected') {
    reasons.push('tax_check_failed');
  }
  // The daily QR points cap limits what is credited without a human: it only matters for a
  // receipt that would otherwise be auto-approved (a moderator's approval is never capped).
  if (
    reasons.length === 0 &&
    input.source === 'qr' &&
    exceedsDailyQrCap(
      input.qrPointsToday ?? 0,
      computePoints({
        totalKopecks: input.totalKopecks,
        rules: input.rules,
        tenant: input.tenant,
        tenantRule: input.tenantRule,
      }),
      input.dailyQrPointsCap,
    )
  ) {
    reasons.push('daily_points_cap');
  }

  const risk = assessRisk(input, reasons);
  if (reasons.length > 0) {
    return { kind: 'needs_moderation', reasons, risk };
  }
  return { kind: 'auto_approved', risk };
}

export interface PointsInput {
  totalKopecks: number;
  rules: LoyaltyRules;
  tenant: RuleTenant | null;
  tenantRule: RuleTenantRule | null;
  /** Points already awarded to the member for this tenant today (tenant daily cap). */
  tenantPointsToday?: number;
}

/** Tenant rule rate wins over the tenant override, which wins over the base rate. */
export function effectiveRatePercent(
  input: Pick<PointsInput, 'rules' | 'tenant' | 'tenantRule'>,
): number {
  return (
    input.tenantRule?.ratePercent ??
    input.tenant?.ratePercentOverride ??
    input.rules.baseRatePercent
  );
}

/** floor(total UAH * rate%), capped by maxPointsPerReceipt and the tenant daily cap. */
export function computePoints(input: PointsInput): number {
  if (!Number.isSafeInteger(input.totalKopecks) || input.totalKopecks <= 0) {
    return 0;
  }
  const rate = effectiveRatePercent(input);
  if (!Number.isFinite(rate) || rate <= 0) {
    return 0;
  }
  let points = Math.min(
    pointsFromKopecks(input.totalKopecks, rate),
    input.rules.maxPointsPerReceipt,
  );
  const cap = input.tenantRule?.dailyCapPoints;
  if (cap !== null && cap !== undefined) {
    const remaining = Math.max(0, cap - (input.tenantPointsToday ?? 0));
    points = Math.min(points, remaining);
  }
  return Math.max(0, points);
}

export interface CreditPlan {
  points: number;
  ratePercent: number;
  /** `pending` when the total is above holdThresholdKopecks or a verification hold applies. */
  state: 'pending' | 'available';
  availableAt: Date;
  expiresAt: Date;
  /** True when the verification hold (not only the high-total hold) keeps the points pending. */
  verificationHold: boolean;
}

/** Points, hold and expiry for a receipt approved at `now`. */
export function buildCreditPlan(
  input: PointsInput & { now: Date; verificationHoldUntil?: Date | null },
): CreditPlan {
  const points = computePoints(input);
  const highTotalHold = input.totalKopecks > input.rules.holdThresholdKopecks;
  let availableAt = highTotalHold ? addKyivDays(input.now, input.rules.holdDays) : input.now;
  const verifyUntil = input.verificationHoldUntil ?? null;
  const verificationHold = verifyUntil !== null && verifyUntil.getTime() > input.now.getTime();
  if (verificationHold && verifyUntil.getTime() > availableAt.getTime()) {
    availableAt = verifyUntil;
  }
  const expiresAt = new Date(addMonths(toKyiv(availableAt), input.rules.pointsTtlMonths).getTime());
  return {
    points,
    ratePercent: effectiveRatePercent(input),
    state: highTotalHold || verificationHold ? 'pending' : 'available',
    availableAt,
    expiresAt,
    verificationHold,
  };
}

/** RECEIPTS_* settings of the verification hold (receipts.config.ts). */
export interface VerificationHoldSettings {
  verifyHoldHours: number;
  newAccountDays: number;
  fastTrackMaxKopecks: number;
}

export interface VerificationHoldInput {
  source: ReceiptSource;
  /** True on the auto-approval path; moderator approvals are never held for verification. */
  autoApproved: boolean;
  totalKopecks: number;
  /** When the member registered; null when unknown (treated as a new account). */
  accountCreatedAt: Date | null;
  /** Answer of the tax checker during the decision; `confirmed` skips the hold. */
  taxCheck: TaxCheckStatus | null;
  now: Date;
  settings: VerificationHoldSettings;
}

/**
 * Forged QR receipts cannot be told from real ones (the tax service has no public API and the
 * MAC is not checkable), so auto-approved QR receipts of new accounts and receipts above the
 * fast-track total are credited as pending until `now + verifyHoldHours`; during the hold the
 * verifier job may still reject them. Returns null when the points may be available at once.
 */
export function verificationHoldUntil(input: VerificationHoldInput): Date | null {
  if (input.source !== 'qr' || !input.autoApproved || input.taxCheck === 'confirmed') {
    return null;
  }
  if (input.settings.verifyHoldHours <= 0) {
    return null;
  }
  const accountAgeMs =
    input.accountCreatedAt === null ? 0 : input.now.getTime() - input.accountCreatedAt.getTime();
  const newAccount = accountAgeMs < input.settings.newAccountDays * 86_400_000;
  const largeTotal = input.totalKopecks > input.settings.fastTrackMaxKopecks;
  if (!newAccount && !largeTotal) {
    return null;
  }
  return new Date(input.now.getTime() + input.settings.verifyHoldHours * 3_600_000);
}

/** Human-readable note for the receipt event trail. */
export function describeDecision(decision: ReceiptDecision): string {
  switch (decision.kind) {
    case 'rejected':
      return `${decision.code}: ${decision.detail}`;
    case 'needs_moderation':
      return `moderation: ${decision.reasons.join(', ')}`;
    case 'auto_approved':
      return 'rules passed: fn whitelisted, total within limits';
  }
}
