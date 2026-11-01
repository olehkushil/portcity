import type { EventRegistrationStatus, EventStatus } from '../../../common/contracts/promos';
import type { VoucherStatus } from '../../../common/contracts/rewards';
import { DomainError } from '../../../common/errors/domain-error';
import { PromosErrors } from './errors';

/**
 * Event lifecycle: draft -> published -> cancelled | finished. A draft may be cancelled
 * (withdrawn) without ever being published. Cancelled and finished are final.
 */
export const EVENT_TRANSITIONS: Readonly<Record<EventStatus, readonly EventStatus[]>> = {
  draft: ['published', 'cancelled'],
  published: ['cancelled', 'finished'],
  cancelled: [],
  finished: [],
};

/** Registration lifecycle: active -> used (check-in) | cancelled. */
export const REGISTRATION_TRANSITIONS: Readonly<
  Record<EventRegistrationStatus, readonly EventRegistrationStatus[]>
> = {
  active: ['used', 'cancelled'],
  used: [],
  cancelled: [],
};

/** Ticket statuses shown to the member (brief section 6): active -> used | cancelled | expired. */
export const TICKET_STATUSES = ['active', 'used', 'cancelled', 'expired'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export function canTransitionEvent(from: EventStatus, to: EventStatus): boolean {
  return EVENT_TRANSITIONS[from].includes(to);
}

export function isEventFinal(status: EventStatus): boolean {
  return EVENT_TRANSITIONS[status].length === 0;
}

export function assertEventTransition(from: EventStatus, to: EventStatus): void {
  if (!canTransitionEvent(from, to)) {
    throw new DomainError(
      PromosErrors.PC_EVENT_INVALID_TRANSITION,
      `Event cannot move from "${from}" to "${to}"`,
      { details: { from, to, allowed: EVENT_TRANSITIONS[from] } },
    );
  }
}

export function canTransitionRegistration(
  from: EventRegistrationStatus,
  to: EventRegistrationStatus,
): boolean {
  return REGISTRATION_TRANSITIONS[from].includes(to);
}

export function assertRegistrationTransition(
  from: EventRegistrationStatus,
  to: EventRegistrationStatus,
): void {
  if (!canTransitionRegistration(from, to)) {
    throw new DomainError(
      PromosErrors.PC_EVENT_REGISTRATION_FINAL,
      `Registration cannot move from "${from}" to "${to}"`,
      { details: { from, to } },
    );
  }
}

export interface TicketStatusInput {
  registrationStatus: EventRegistrationStatus;
  /** Status of the ticket voucher; null when the voucher is unknown (not issued yet). */
  voucherStatus: VoucherStatus | null;
  /** End of the event; a live ticket is expired once the event is over. */
  endsAt: Date;
  now: Date;
}

/**
 * The ticket status is derived: the registration row says whether the member checked in or
 * cancelled; the voucher adds expiry and admin cancellation; time closes the rest.
 */
export function deriveTicketStatus(input: TicketStatusInput): TicketStatus {
  if (input.registrationStatus === 'used') {
    return 'used';
  }
  if (input.registrationStatus === 'cancelled') {
    return 'cancelled';
  }
  switch (input.voucherStatus) {
    case 'redeemed':
      return 'used';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    default:
      return input.now.getTime() >= input.endsAt.getTime() ? 'expired' : 'active';
  }
}
