import type {
  ParkingQuote,
  ParkingSessionStatus,
  ParkingTariffConfig,
} from '../../../common/contracts/parking';
import {
  CLOSE_REASONS,
  deriveSessionState,
  isFinalStatus,
  type SessionFacts,
} from './session-state';

/** Outbox event to publish after a reconciliation step (mapped to PARKING_EVENTS by the service). */
export type ParkingTransitionKind = 'opened' | 'payable' | 'paid' | 'overstay' | 'closed';

/** What the database currently says about a session. */
export interface SessionStateView {
  status: ParkingSessionStatus;
  paidUntil: Date | null;
  exitedAt: Date | null;
  amountDueKopecks: number;
  amountPaidKopecks: number;
  closedReason: string | null;
}

/** Facts from the provider or the info-mode user plus the money already paid. */
export interface SessionFactsInput extends SessionFacts {
  amountPaidKopecks: number;
}

export interface SessionPlan {
  status: ParkingSessionStatus;
  quote: ParkingQuote;
  exitedAt: Date | null;
  paidUntil: Date | null;
  closedReason: string | null;
  amountDueKopecks: number;
  amountPaidKopecks: number;
  events: ParkingTransitionKind[];
  /** False when nothing in the stored row needs to change (idempotent sync). */
  changed: boolean;
}

function eventFor(status: ParkingSessionStatus): ParkingTransitionKind | null {
  switch (status) {
    case 'open':
      return null;
    case 'payable':
      return 'payable';
    case 'paid':
      return 'paid';
    case 'overstay':
      return 'overstay';
    case 'closed':
    case 'closed_unpaid':
    case 'closed_free':
      return 'closed';
  }
}

const time = (value: Date | null | undefined): number | null => (value ? value.getTime() : null);

/**
 * Pure reconciliation step: given the stored state (or null for a new session), the latest
 * facts, the current time and the tariff, computes the next stored state and the events that
 * describe the transition. Applying the same facts twice yields `changed: false` and no events.
 */
export function planSession(
  previous: SessionStateView | null,
  facts: SessionFactsInput,
  now: Date,
  tariff: ParkingTariffConfig,
): SessionPlan {
  const derived = deriveSessionState(facts, now, tariff);
  const status = derived.status;
  const paidUntil =
    facts.paidUntil && facts.paidUntil.getTime() >= facts.enteredAt.getTime()
      ? facts.paidUntil
      : null;
  const exitedAt = facts.exitedAt;
  const closedReason = exitedAt
    ? (facts.closedReason ?? previous?.closedReason ?? CLOSE_REASONS.exit)
    : null;
  const amountDueKopecks =
    isFinalStatus(status) && status !== 'closed_unpaid' ? 0 : derived.quote.amountDueKopecks;

  const events: ParkingTransitionKind[] = [];
  if (!previous) {
    events.push('opened');
    const kind = eventFor(status);
    if (kind) {
      events.push(kind);
    }
  } else if (previous.status !== status) {
    const kind = eventFor(status);
    if (kind) {
      events.push(kind);
    }
  } else if (status === 'paid' && time(previous.paidUntil) !== time(paidUntil)) {
    // The paid period was extended by another payment.
    events.push('paid');
  }

  const changed =
    !previous ||
    previous.status !== status ||
    previous.amountDueKopecks !== amountDueKopecks ||
    previous.amountPaidKopecks !== facts.amountPaidKopecks ||
    time(previous.paidUntil) !== time(paidUntil) ||
    time(previous.exitedAt) !== time(exitedAt) ||
    previous.closedReason !== closedReason;

  return {
    status,
    quote: derived.quote,
    exitedAt,
    paidUntil,
    closedReason,
    amountDueKopecks,
    amountPaidKopecks: facts.amountPaidKopecks,
    events,
    changed,
  };
}
