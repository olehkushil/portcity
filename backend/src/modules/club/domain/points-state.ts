import type { PointsTxState, PointsTxType } from '../../../common/contracts/club';
import { DomainError } from '../../../common/errors/domain-error';
import { ClubErrors } from './errors';

/**
 * Points state machine (brief section 6):
 *   pending -> available -> spent | expired ; pending -> cancelled
 * The same table is enforced by the `points_transactions_append_only` trigger in the database.
 */
export const POINTS_TRANSITIONS: Readonly<Record<PointsTxState, readonly PointsTxState[]>> =
  Object.freeze({
    pending: ['available', 'cancelled'],
    available: ['spent', 'expired'],
    spent: [],
    expired: [],
    cancelled: [],
  });

export const FINAL_POINTS_STATES: readonly PointsTxState[] = ['spent', 'expired', 'cancelled'];

/** States whose rows count towards the cached available balance (seed convention). */
export const AVAILABLE_SUM_STATES: readonly PointsTxState[] = ['available', 'spent', 'expired'];

export function canTransition(from: PointsTxState, to: PointsTxState): boolean {
  return POINTS_TRANSITIONS[from].includes(to);
}

export function isFinalState(state: PointsTxState): boolean {
  return FINAL_POINTS_STATES.includes(state);
}

export function assertTransition(from: PointsTxState, to: PointsTxState, txId?: string): void {
  if (!canTransition(from, to)) {
    throw new DomainError(
      ClubErrors.PC_POINTS_INVALID_TRANSITION,
      `Points transaction cannot move from "${from}" to "${to}"`,
      { details: { txId: txId ?? null, from, to } },
    );
  }
}

/** Row types that add points to an account. */
export const CREDIT_TYPES: readonly PointsTxType[] = ['earn', 'welcome', 'adjust', 'refund'];

export interface ReversibleEntry {
  id: string;
  type: PointsTxType;
  state: PointsTxState;
  amount: number;
}

/**
 * What `reverse()` must do with a row:
 * - `cancel`: a pending credit is cancelled in place (pending -> cancelled);
 * - `reverse`: an available or consumed credit gets a compensating negative row (`reverse`),
 *   which may drive the available balance negative;
 * - `refund`: a negative row (spend, expire, reverse, negative adjust) gets a compensating
 *   positive row (`refund`) with a fresh expiry;
 * - `noop`: the row is already cancelled (idempotent replay of a cancellation).
 */
export type ReversalPlan = 'cancel' | 'reverse' | 'refund' | 'noop';

export function planReversal(entry: ReversibleEntry): ReversalPlan {
  if (entry.amount < 0) {
    return 'refund';
  }
  switch (entry.state) {
    case 'pending':
      return 'cancel';
    case 'available':
    case 'spent':
      return 'reverse';
    case 'cancelled':
      return 'noop';
    case 'expired':
      throw new DomainError(
        ClubErrors.PC_POINTS_INVALID_TRANSITION,
        'An expired credit cannot be reversed',
        { details: { txId: entry.id, state: entry.state } },
      );
    default: {
      const exhaustive: never = entry.state;
      throw new Error(`Unknown points state ${String(exhaustive)}`);
    }
  }
}
