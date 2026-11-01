import type {
  ParkingQuote,
  ParkingSessionStatus,
  ParkingTariffConfig,
} from '../../../common/contracts/parking';
import { DomainError } from '../../../common/errors/domain-error';
import { ParkingErrors } from './errors';
import { quote } from './tariff';

/**
 * Parking session state machine (brief section 6):
 *
 *   open (free 30 min) -> payable -> paid (exit by paidUntil) -> closed
 *                                 \-> overstay -> paid ; closed_unpaid (paymat) ; closed_free (air raid, privilege)
 */
export const FINAL_SESSION_STATUSES = [
  'closed',
  'closed_unpaid',
  'closed_free',
] as const satisfies readonly ParkingSessionStatus[];

/** Statuses of a car that is (as far as we know) still inside. */
export const ACTIVE_SESSION_STATUSES: ParkingSessionStatus[] = [
  'open',
  'payable',
  'paid',
  'overstay',
];

export const PAYABLE_SESSION_STATUSES = [
  'payable',
  'overstay',
] as const satisfies readonly ParkingSessionStatus[];

export const SESSION_TRANSITIONS: Readonly<
  Record<ParkingSessionStatus, readonly ParkingSessionStatus[]>
> = Object.freeze({
  open: ['payable', 'paid', 'closed', 'closed_unpaid', 'closed_free'],
  payable: ['paid', 'closed', 'closed_unpaid', 'closed_free'],
  paid: ['overstay', 'closed', 'closed_free'],
  overstay: ['paid', 'closed', 'closed_unpaid', 'closed_free'],
  closed: [],
  closed_unpaid: [],
  closed_free: [],
});

/** Values stored in `ParkingSession.closedReason`. */
export const CLOSE_REASONS = {
  /** The provider reported the exit. */
  exit: 'exit',
  /** The member pressed "I already left" (provider session, nothing due). */
  userLeft: 'user_left',
  /** The member closed an info-mode timer. */
  userExit: 'user_exit',
  /** Housekeeping: the session was not seen for too long. */
  timeout: 'timeout',
  airRaid: 'air_raid',
  privilege: 'privilege',
  adminClosed: 'admin_closed',
} as const;
export type CloseReason = (typeof CLOSE_REASONS)[keyof typeof CLOSE_REASONS];

/** Close reasons that make the session `closed_free` regardless of the amount due. */
export const FREE_CLOSE_REASONS: readonly string[] = [
  CLOSE_REASONS.airRaid,
  CLOSE_REASONS.privilege,
  'free',
];

export function isFinalStatus(status: ParkingSessionStatus): boolean {
  return (FINAL_SESSION_STATUSES as readonly ParkingSessionStatus[]).includes(status);
}

export function isPayableStatus(status: ParkingSessionStatus): boolean {
  return (PAYABLE_SESSION_STATUSES as readonly ParkingSessionStatus[]).includes(status);
}

/** Same-state "transitions" are allowed (refresh, paid-period extension). */
export function canTransition(from: ParkingSessionStatus, to: ParkingSessionStatus): boolean {
  return from === to || SESSION_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ParkingSessionStatus, to: ParkingSessionStatus): void {
  if (!canTransition(from, to)) {
    throw new DomainError(
      ParkingErrors.PC_PARKING_INVALID_TRANSITION,
      `Parking session cannot go from "${from}" to "${to}"`,
      { details: { from, to } },
    );
  }
}

/** Facts about a session as the provider (or the info-mode user) reports them. */
export interface SessionFacts {
  enteredAt: Date;
  exitedAt: Date | null;
  paidUntil: Date | null;
  closedReason: string | null;
}

export interface DerivedSessionState {
  status: ParkingSessionStatus;
  quote: ParkingQuote;
}

/**
 * Derives the status from facts and time: the state machine is a function of
 * (enteredAt, paidUntil, exitedAt, now) and the tariff, which keeps sync and webhooks idempotent.
 */
export function deriveSessionState(
  facts: SessionFacts,
  now: Date,
  tariff: ParkingTariffConfig,
): DerivedSessionState {
  const paidUntil =
    facts.paidUntil && facts.paidUntil.getTime() >= facts.enteredAt.getTime()
      ? facts.paidUntil
      : null;

  if (facts.exitedAt) {
    const atExit = quote(facts.enteredAt, facts.exitedAt, tariff, paidUntil);
    if (facts.closedReason && FREE_CLOSE_REASONS.includes(facts.closedReason)) {
      return { status: 'closed_free', quote: atExit };
    }
    return { status: atExit.amountDueKopecks > 0 ? 'closed_unpaid' : 'closed', quote: atExit };
  }

  const current = quote(facts.enteredAt, now, tariff, paidUntil);
  if (paidUntil) {
    return { status: current.amountDueKopecks > 0 ? 'overstay' : 'paid', quote: current };
  }
  return { status: current.amountDueKopecks > 0 ? 'payable' : 'open', quote: current };
}
