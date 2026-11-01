import {
  EVENT_REGISTRATION_STATUSES,
  EVENT_STATUSES,
  type EventRegistrationStatus,
  type EventStatus,
} from '../../../common/contracts/promos';
import type { VoucherStatus } from '../../../common/contracts/rewards';
import {
  type TicketStatus,
  assertEventTransition,
  assertRegistrationTransition,
  canTransitionEvent,
  canTransitionRegistration,
  deriveTicketStatus,
  isEventFinal,
} from './event-state';

/** The error thrown by `fn` (fails the test when nothing is thrown). */
function thrownBy(fn: () => void): object {
  try {
    fn();
  } catch (error) {
    return error as object;
  }
  throw new Error('expected the call to throw');
}

describe('event state machine', () => {
  const eventTable: Array<[EventStatus, EventStatus, boolean]> = [
    ['draft', 'published', true],
    ['draft', 'cancelled', true],
    ['draft', 'finished', false],
    ['published', 'cancelled', true],
    ['published', 'finished', true],
    ['published', 'draft', false],
    ['cancelled', 'published', false],
    ['cancelled', 'finished', false],
    ['finished', 'cancelled', false],
    ['finished', 'published', false],
  ];

  it.each(eventTable)('event %s -> %s allowed: %s', (from, to, allowed) => {
    expect(canTransitionEvent(from, to)).toBe(allowed);
    if (allowed) {
      expect(() => assertEventTransition(from, to)).not.toThrow();
    } else {
      expect(thrownBy(() => assertEventTransition(from, to))).toMatchObject({
        code: 'PC_EVENT_INVALID_TRANSITION',
      });
    }
  });

  it('marks cancelled and finished as final', () => {
    expect(EVENT_STATUSES.filter((status) => isEventFinal(status))).toEqual([
      'cancelled',
      'finished',
    ]);
  });

  const registrationTable: Array<[EventRegistrationStatus, EventRegistrationStatus, boolean]> = [
    ['active', 'used', true],
    ['active', 'cancelled', true],
    ['active', 'active', false],
    ['used', 'cancelled', false],
    ['used', 'active', false],
    ['cancelled', 'active', false],
    ['cancelled', 'used', false],
  ];

  it.each(registrationTable)('registration %s -> %s allowed: %s', (from, to, allowed) => {
    expect(canTransitionRegistration(from, to)).toBe(allowed);
    if (allowed) {
      expect(() => assertRegistrationTransition(from, to)).not.toThrow();
    } else {
      expect(thrownBy(() => assertRegistrationTransition(from, to))).toMatchObject({
        code: 'PC_EVENT_REGISTRATION_FINAL',
        status: 409,
      });
    }
  });

  it('every registration status appears in the table', () => {
    const seen = new Set(registrationTable.map(([from]) => from));
    for (const status of EVENT_REGISTRATION_STATUSES) {
      expect(seen.has(status)).toBe(true);
    }
  });
});

describe('deriveTicketStatus', () => {
  const endsAt = new Date('2026-11-01T11:30:00.000Z');
  const before = new Date('2026-11-01T09:00:00.000Z');
  const after = new Date('2026-11-01T12:00:00.000Z');

  const table: Array<
    [EventRegistrationStatus, VoucherStatus | null, 'before' | 'after', TicketStatus]
  > = [
    ['active', 'issued', 'before', 'active'],
    ['active', 'active', 'before', 'active'],
    ['active', null, 'before', 'active'],
    ['active', 'issued', 'after', 'expired'],
    ['active', 'expired', 'before', 'expired'],
    ['active', 'redeemed', 'before', 'used'],
    ['active', 'cancelled', 'before', 'cancelled'],
    ['used', 'redeemed', 'after', 'used'],
    ['used', 'issued', 'before', 'used'],
    ['cancelled', 'cancelled', 'before', 'cancelled'],
    ['cancelled', 'issued', 'after', 'cancelled'],
  ];

  it.each(table)(
    'registration %s + voucher %s (%s event end) -> %s',
    (registrationStatus, voucherStatus, moment, expected) => {
      expect(
        deriveTicketStatus({
          registrationStatus,
          voucherStatus,
          endsAt,
          now: moment === 'before' ? before : after,
        }),
      ).toBe(expected);
    },
  );
});
