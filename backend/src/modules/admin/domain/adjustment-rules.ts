import {
  FOUR_EYES_THRESHOLD_POINTS,
  type ManualAdjustmentStatus,
} from '../../../common/contracts/admin';
import { DomainError } from '../../../common/errors/domain-error';
import { AdminErrors } from './errors';

/**
 * Manual adjustment rules (brief sections 4 and 6, "four eyes"):
 *
 *   pending  -> approved (second admin) -> applied (ledger row written)
 *   pending  -> rejected
 *   approved -> rejected (application impossible or withdrawn)
 *
 * Amounts with |amount| <= thresholdPoints are decided by the requester alone and go
 * pending -> approved -> applied inside the request transaction. Above the threshold a
 * different admin must approve.
 */

/** Sanity bound for a single adjustment; not a business limit (those live in the rule set). */
export const MAX_ADJUSTMENT_POINTS = 1_000_000;

/** Frozen list typed with the status union (a bare Object.freeze([...]) widens to string[]). */
function statuses(...list: ManualAdjustmentStatus[]): readonly ManualAdjustmentStatus[] {
  return Object.freeze(list);
}

export const ADJUSTMENT_TRANSITIONS: Readonly<
  Record<ManualAdjustmentStatus, readonly ManualAdjustmentStatus[]>
> = Object.freeze({
  pending: statuses('approved', 'rejected'),
  approved: statuses('applied', 'rejected'),
  applied: statuses(),
  rejected: statuses(),
});

export const FINAL_ADJUSTMENT_STATUSES: readonly ManualAdjustmentStatus[] = Object.freeze([
  'applied',
  'rejected',
]);

export function canTransition(from: ManualAdjustmentStatus, to: ManualAdjustmentStatus): boolean {
  return ADJUSTMENT_TRANSITIONS[from].includes(to);
}

export function isFinalAdjustmentStatus(status: ManualAdjustmentStatus): boolean {
  return FINAL_ADJUSTMENT_STATUSES.includes(status);
}

export function assertTransition(
  from: ManualAdjustmentStatus,
  to: ManualAdjustmentStatus,
  adjustmentId?: string,
): void {
  if (!canTransition(from, to)) {
    const subject = adjustmentId ? `Manual adjustment ${adjustmentId}` : 'Manual adjustment';
    throw new DomainError(
      AdminErrors.PC_ADJUSTMENT_INVALID_TRANSITION,
      `${subject} cannot move from "${from}" to "${to}"`,
      {
        details: {
          adjustmentId: adjustmentId ?? null,
          from,
          to,
          allowed: ADJUSTMENT_TRANSITIONS[from],
        },
      },
    );
  }
}

export function isValidAdjustmentAmount(amount: unknown): amount is number {
  return (
    typeof amount === 'number' &&
    Number.isSafeInteger(amount) &&
    amount !== 0 &&
    Math.abs(amount) <= MAX_ADJUSTMENT_POINTS
  );
}

export function assertAdjustmentAmount(amount: unknown): asserts amount is number {
  if (!isValidAdjustmentAmount(amount)) {
    throw new DomainError(
      AdminErrors.PC_ADJUSTMENT_AMOUNT_INVALID,
      `Adjustment amount must be a non-zero integer between -${MAX_ADJUSTMENT_POINTS} and ${MAX_ADJUSTMENT_POINTS} points`,
      { details: { amount: typeof amount === 'number' ? amount : String(amount) } },
    );
  }
}

/** True when a second admin must approve (strictly above the threshold, by absolute value). */
export function needsSecondApproval(
  amount: number,
  thresholdPoints: number = FOUR_EYES_THRESHOLD_POINTS,
): boolean {
  return Math.abs(amount) > thresholdPoints;
}

/**
 * Why an adjustment waits for a second admin (stored in `manual_adjustments.second_approval_reason`):
 * - `amount`: |amount| alone is above the threshold;
 * - `requester_daily_total`: the requester's self-approved adjustments of the current Kyiv day
 *   plus this one would exceed the threshold (splitting 900 into 3 x 300 does not bypass four eyes);
 * - `account_24h_total`: self-approved adjustments of the target account over the last 24 hours
 *   (by any admin) plus this one would exceed the threshold.
 */
export const SECOND_APPROVAL_REASONS = [
  'amount',
  'requester_daily_total',
  'account_24h_total',
] as const;
export type SecondApprovalReason = (typeof SECOND_APPROVAL_REASONS)[number];

export function isSecondApprovalReason(value: unknown): value is SecondApprovalReason {
  return (
    typeof value === 'string' && (SECOND_APPROVAL_REASONS as readonly string[]).includes(value)
  );
}

/** Window of the per-account cumulative check. */
export const ACCOUNT_SELF_APPROVAL_WINDOW_MS = 24 * 3_600_000;

/**
 * Absolute points already decided by a single admin (self-approved: status approved or applied,
 * no second approval) that count against the threshold together with the new request.
 */
export interface SelfApprovedTotals {
  /** Requester's self-approved total since the start of the current Kyiv day. */
  requesterKyivDay: number;
  /** Self-approved total of the target account over the last 24 hours, any requester. */
  account24h: number;
}

export interface AdjustmentRequestInput {
  amount: number;
  requestedById: string;
  /** Defaults to FOUR_EYES_THRESHOLD_POINTS; stored on the row so later changes do not rewrite history. */
  thresholdPoints?: number;
  /** Cumulative self-approved amounts; omitted means none (the single-amount rule only). */
  selfApproved?: SelfApprovedTotals;
}

export interface AdjustmentRequestPlan {
  needsSecondApproval: boolean;
  /** Null when the requester may decide alone. */
  secondApprovalReason: SecondApprovalReason | null;
  /** `approved` when the requester may decide alone; the service then applies it right away. */
  initialStatus: Extract<ManualAdjustmentStatus, 'pending' | 'approved'>;
  approvedById: string | null;
  thresholdPoints: number;
  /** Totals the decision was based on, including this request (audit trail). */
  totals: { requesterKyivDay: number; account24h: number };
}

/** First rule that requires a second admin, or null. Pure; amounts compare by absolute value. */
export function secondApprovalReasonFor(
  amount: number,
  thresholdPoints: number,
  selfApproved: SelfApprovedTotals = { requesterKyivDay: 0, account24h: 0 },
): SecondApprovalReason | null {
  const absolute = Math.abs(amount);
  if (needsSecondApproval(amount, thresholdPoints)) {
    return 'amount';
  }
  if (Math.abs(selfApproved.requesterKyivDay) + absolute > thresholdPoints) {
    return 'requester_daily_total';
  }
  if (Math.abs(selfApproved.account24h) + absolute > thresholdPoints) {
    return 'account_24h_total';
  }
  return null;
}

export function planAdjustmentRequest(input: AdjustmentRequestInput): AdjustmentRequestPlan {
  assertAdjustmentAmount(input.amount);
  const thresholdPoints = input.thresholdPoints ?? FOUR_EYES_THRESHOLD_POINTS;
  const selfApproved = input.selfApproved ?? { requesterKyivDay: 0, account24h: 0 };
  const reason = secondApprovalReasonFor(input.amount, thresholdPoints, selfApproved);
  const second = reason !== null;
  const absolute = Math.abs(input.amount);
  return {
    needsSecondApproval: second,
    secondApprovalReason: reason,
    initialStatus: second ? 'pending' : 'approved',
    approvedById: second ? null : input.requestedById,
    thresholdPoints,
    totals: {
      requesterKyivDay: Math.abs(selfApproved.requesterKyivDay) + absolute,
      account24h: Math.abs(selfApproved.account24h) + absolute,
    },
  };
}

/** Sums absolute amounts of self-approved adjustment rows. */
export function sumAbsolutePoints(rows: ReadonlyArray<{ amount: number }>): number {
  return rows.reduce((total, row) => total + Math.abs(row.amount), 0);
}

export interface ApprovalCheck {
  adjustmentId: string;
  status: ManualAdjustmentStatus;
  requestedById: string;
  approverId: string;
}

/** pending -> approved by somebody other than the requester. */
export function assertCanApprove(check: ApprovalCheck): void {
  assertTransition(check.status, 'approved', check.adjustmentId);
  if (check.requestedById === check.approverId) {
    throw new DomainError(
      AdminErrors.PC_ADJUSTMENT_SELF_APPROVAL,
      `Manual adjustment ${check.adjustmentId} was requested by ${check.requestedById} and needs a different approver`,
      { details: { adjustmentId: check.adjustmentId, requestedById: check.requestedById } },
    );
  }
}

/** approved -> applied; a pending row must be approved first. */
export function assertCanApply(adjustmentId: string, status: ManualAdjustmentStatus): void {
  if (status === 'pending') {
    throw new DomainError(
      AdminErrors.PC_ADJUSTMENT_APPROVAL_REQUIRED,
      `Manual adjustment ${adjustmentId} is pending and must be approved before it is applied`,
      { details: { adjustmentId, status } },
    );
  }
  assertTransition(status, 'applied', adjustmentId);
}

/** pending|approved -> rejected. */
export function assertCanReject(adjustmentId: string, status: ManualAdjustmentStatus): void {
  assertTransition(status, 'rejected', adjustmentId);
}

export type LedgerOperationKind = 'credit' | 'spend';

/** What the club ledger must do for a signed amount; `amount` is always positive here. */
export interface LedgerOperation {
  kind: LedgerOperationKind;
  amount: number;
}

export function ledgerOperationFor(amount: number): LedgerOperation {
  assertAdjustmentAmount(amount);
  return amount > 0 ? { kind: 'credit', amount } : { kind: 'spend', amount: -amount };
}

/** Ledger idempotency key of an adjustment: one ledger row per adjustment, ever. */
export function adjustmentIdempotencyKey(adjustmentId: string): string {
  return `adjustment:${adjustmentId}`;
}
