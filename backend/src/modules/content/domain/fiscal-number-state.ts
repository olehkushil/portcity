import { type FiscalNumberStatus } from '../../../common/contracts/content';
import { DomainError } from '../../../common/errors/domain-error';
import { ContentErrors } from './errors';

/**
 * Fiscal number (cash register) whitelist machine, pure:
 *
 *   pending -> active   (moderator confirms the mapping to a tenant)
 *   pending -> blocked  (fraudulent or foreign cash register)
 *   active  -> blocked
 *   blocked -> active | pending
 *
 * `active -> pending` is not allowed: an active number is blocked instead, so receipts that
 * were auto-approved under it keep a clear history. Invariant: an active number is mapped to
 * a tenant (`tenantId` not null).
 */
export const FISCAL_NUMBER_TRANSITIONS: Readonly<
  Record<FiscalNumberStatus, readonly FiscalNumberStatus[]>
> = Object.freeze({
  pending: ['active', 'blocked'],
  active: ['blocked'],
  blocked: ['active', 'pending'],
});

export function canTransitionFiscalNumber(
  from: FiscalNumberStatus,
  to: FiscalNumberStatus,
): boolean {
  return from === to || FISCAL_NUMBER_TRANSITIONS[from].includes(to);
}

export interface FiscalNumberState {
  status: FiscalNumberStatus;
  tenantId: string | null;
}

export interface FiscalNumberTarget {
  /** Omit to keep the current status. */
  status?: FiscalNumberStatus;
  /** Omit to keep the current mapping; `null` unmaps. */
  tenantId?: string | null;
}

export type FiscalNumberDecision =
  | { ok: true; next: FiscalNumberState; changed: boolean }
  | { ok: false; reason: 'invalid_transition' | 'tenant_required'; next: FiscalNumberState };

/** Combines a status change and a mapping change and validates the invariant. */
export function decideFiscalNumberTransition(
  current: FiscalNumberState,
  target: FiscalNumberTarget,
): FiscalNumberDecision {
  const next: FiscalNumberState = {
    status: target.status ?? current.status,
    tenantId: target.tenantId === undefined ? current.tenantId : target.tenantId,
  };
  if (!canTransitionFiscalNumber(current.status, next.status)) {
    return { ok: false, reason: 'invalid_transition', next };
  }
  if (next.status === 'active' && next.tenantId === null) {
    return { ok: false, reason: 'tenant_required', next };
  }
  const changed = next.status !== current.status || next.tenantId !== current.tenantId;
  return { ok: true, next, changed };
}

export function assertFiscalNumberDecision(
  decision: FiscalNumberDecision,
  current: FiscalNumberState,
): asserts decision is Extract<FiscalNumberDecision, { ok: true }> {
  if (decision.ok) {
    return;
  }
  if (decision.reason === 'tenant_required') {
    throw new DomainError(
      ContentErrors.PC_FISCAL_NUMBER_TENANT_REQUIRED,
      'A fiscal number can be active only when it is mapped to a tenant',
      { details: { status: decision.next.status } },
    );
  }
  throw new DomainError(
    ContentErrors.PC_FISCAL_NUMBER_INVALID_TRANSITION,
    `Fiscal number status cannot change from "${current.status}" to "${decision.next.status}"`,
    {
      details: {
        from: current.status,
        to: decision.next.status,
        allowed: FISCAL_NUMBER_TRANSITIONS[current.status],
      },
    },
  );
}

/** Receipts are auto-approved only against active (confirmed) numbers. */
export function isFiscalNumberWhitelisted(status: FiscalNumberStatus): boolean {
  return status === 'active';
}
