import {
  DEFAULT_MAX_PERSONS_PER_REGISTRATION,
  type EventAdmission,
  type EventStatus,
  MAX_PERSONS_PER_REGISTRATION_LIMIT,
  type PromosErrorCode,
} from '../../../common/contracts/promos';
import { kyivTimeAt } from '../../../common/time/kyiv';

/**
 * Prototype copy: "До 4 учасників на одну реєстрацію". Only the fallback now: the event's
 * `maxPersonsPerRegistration` wins, then the `events.registration` flag payload
 * (`maxPersonsPerRegistration`), then this value (see `effectiveMaxPersons`).
 */
export const MAX_PERSONS_PER_REGISTRATION = DEFAULT_MAX_PERSONS_PER_REGISTRATION;

/** Prototype copy: "скасувати можна до 11:00 у день події" (Kyiv wall clock). */
export const REGISTRATION_CANCEL_DEADLINE_KYIV = '11:00';

/** The event fields the registration rules look at (a Prisma Event row satisfies it). */
export interface EventRuleInput {
  id: string;
  status: EventStatus;
  startsAt: Date;
  endsAt: Date;
  /** Maximum persons (adults + children); null means unlimited. */
  capacity: number | null;
  /** Persons of active registrations. */
  registeredCount: number;
  registrationOpen: boolean;
  /** Missing means `registration` (rows written before the column existed). */
  admission?: EventAdmission;
  /** Per-event override of the persons limit; null or missing means the default. */
  maxPersonsPerRegistration?: number | null;
}

export interface PersonsInput {
  adults: number;
  children: number;
}

export interface RegistrationContext {
  now: Date;
  /** Feature flag `events.registration`. */
  registrationEnabled: boolean;
  /** `maxPersonsPerRegistration` of the flag payload; null or missing means 4. */
  defaultMaxPersons?: number | null;
}

export type RegistrationRejectionCode = Extract<
  PromosErrorCode,
  | 'PC_EVENT_NOT_FOUND'
  | 'PC_EVENT_REGISTRATION_CLOSED'
  | 'PC_EVENT_FULL'
  | 'PC_EVENT_PERSONS_INVALID'
>;

export type RegistrationDecision =
  | { allowed: true; persons: number }
  | { allowed: false; code: RegistrationRejectionCode; detail: string };

export type PersonsCheck = { ok: true; persons: number } | { ok: false; detail: string };

function isPersonsLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_PERSONS_PER_REGISTRATION_LIMIT
  );
}

/** Reads `maxPersonsPerRegistration` from the `events.registration` flag payload, if valid. */
export function maxPersonsFromFlagPayload(payload: Record<string, unknown> | null): number | null {
  const value = payload?.['maxPersonsPerRegistration'];
  return isPersonsLimit(value) ? value : null;
}

/** Event override, then the flag payload default, then 4. */
export function effectiveMaxPersons(
  event: Pick<EventRuleInput, 'maxPersonsPerRegistration'>,
  defaultMaxPersons?: number | null,
): number {
  if (isPersonsLimit(event.maxPersonsPerRegistration)) {
    return event.maxPersonsPerRegistration;
  }
  if (isPersonsLimit(defaultMaxPersons)) {
    return defaultMaxPersons;
  }
  return DEFAULT_MAX_PERSONS_PER_REGISTRATION;
}

export function isValidPersonsLimit(value: number | null): boolean {
  return value === null || isPersonsLimit(value);
}

/** Admission outside the app (cinema sessions, concerts): no in-app registration. */
export function isExternalAdmission(event: Pick<EventRuleInput, 'admission'>): boolean {
  return event.admission === 'external';
}

/** At least one adult (the member), no negative counts, at most `maxPersons` (default 4). */
export function validatePersons(
  input: PersonsInput,
  maxPersons: number = DEFAULT_MAX_PERSONS_PER_REGISTRATION,
): PersonsCheck {
  if (!Number.isInteger(input.adults) || !Number.isInteger(input.children)) {
    return { ok: false, detail: 'adults and children must be integers' };
  }
  if (input.adults < 1) {
    return { ok: false, detail: 'At least one adult (the member) must attend' };
  }
  if (input.children < 0) {
    return { ok: false, detail: 'children cannot be negative' };
  }
  const persons = input.adults + input.children;
  if (persons > maxPersons) {
    return {
      ok: false,
      detail: `At most ${maxPersons} persons per registration`,
    };
  }
  return { ok: true, persons };
}

/** Seats still free; null means unlimited. */
export function seatsLeft(
  event: Pick<EventRuleInput, 'capacity' | 'registeredCount'>,
): number | null {
  if (event.capacity === null) {
    return null;
  }
  return Math.max(event.capacity - event.registeredCount, 0);
}

export type EventWindowState = 'upcoming' | 'ongoing' | 'past';

export function eventWindowState(
  event: Pick<EventRuleInput, 'startsAt' | 'endsAt'>,
  now: Date,
): EventWindowState {
  if (now.getTime() < event.startsAt.getTime()) {
    return 'upcoming';
  }
  if (now.getTime() < event.endsAt.getTime()) {
    return 'ongoing';
  }
  return 'past';
}

/** Published, in-app admission, flagged open, not started yet and with at least one seat. */
export function isRegistrationOpenAt(event: EventRuleInput, now: Date): boolean {
  if (event.status !== 'published' || !event.registrationOpen || isExternalAdmission(event)) {
    return false;
  }
  if (eventWindowState(event, now) !== 'upcoming') {
    return false;
  }
  const left = seatsLeft(event);
  return left === null || left > 0;
}

export function isValidEventWindow(startsAt: Date, endsAt: Date): boolean {
  return (
    Number.isFinite(startsAt.getTime()) &&
    Number.isFinite(endsAt.getTime()) &&
    startsAt.getTime() < endsAt.getTime()
  );
}

/**
 * Pure registration check: existence, feature flag, status/open flag/time, persons, capacity.
 * Drafts are reported as not found so members cannot probe unpublished events.
 */
export function decideRegistration(
  event: EventRuleInput | null,
  persons: PersonsInput,
  context: RegistrationContext,
): RegistrationDecision {
  if (!event || event.status === 'draft') {
    return { allowed: false, code: 'PC_EVENT_NOT_FOUND', detail: 'Event does not exist' };
  }
  if (!context.registrationEnabled) {
    return {
      allowed: false,
      code: 'PC_EVENT_REGISTRATION_CLOSED',
      detail: 'Event registration is temporarily disabled',
    };
  }
  if (event.status !== 'published') {
    return {
      allowed: false,
      code: 'PC_EVENT_REGISTRATION_CLOSED',
      detail: `Event is ${event.status}`,
    };
  }
  if (isExternalAdmission(event)) {
    return {
      allowed: false,
      code: 'PC_EVENT_REGISTRATION_CLOSED',
      detail: 'Admission to this event is external; follow externalUrl',
    };
  }
  if (!event.registrationOpen) {
    return {
      allowed: false,
      code: 'PC_EVENT_REGISTRATION_CLOSED',
      detail: 'Registration for this event is closed',
    };
  }
  if (eventWindowState(event, context.now) !== 'upcoming') {
    return {
      allowed: false,
      code: 'PC_EVENT_REGISTRATION_CLOSED',
      detail: 'Registration closes when the event starts',
    };
  }
  const check = validatePersons(persons, effectiveMaxPersons(event, context.defaultMaxPersons));
  if (!check.ok) {
    return { allowed: false, code: 'PC_EVENT_PERSONS_INVALID', detail: check.detail };
  }
  const left = seatsLeft(event);
  if (left !== null && check.persons > left) {
    return {
      allowed: false,
      code: 'PC_EVENT_FULL',
      detail: left === 0 ? 'No seats left' : `Only ${left} seat(s) left`,
    };
  }
  return { allowed: true, persons: check.persons };
}

/**
 * Members may cancel until REGISTRATION_CANCEL_DEADLINE_KYIV on the event day, or until the
 * event starts when it starts earlier than that.
 */
export function registrationCancelDeadline(startsAt: Date): Date {
  const deadline = kyivTimeAt(startsAt, REGISTRATION_CANCEL_DEADLINE_KYIV);
  return deadline.getTime() < startsAt.getTime() ? deadline : new Date(startsAt.getTime());
}

export function canCancelRegistration(startsAt: Date, now: Date): boolean {
  return now.getTime() < registrationCancelDeadline(startsAt).getTime();
}

/** Cancellation deadline shown on the event card; null when admission is external. */
export function eventCancelDeadline(
  event: Pick<EventRuleInput, 'startsAt' | 'admission'>,
): Date | null {
  return isExternalAdmission(event) ? null : registrationCancelDeadline(event.startsAt);
}

/** Both bounds optional, each 0-99, min not above max. */
export function isValidAgeRange(ageMin: number | null, ageMax: number | null): boolean {
  const inRange = (value: number | null): boolean =>
    value === null || (Number.isInteger(value) && value >= 0 && value <= 99);
  if (!inRange(ageMin) || !inRange(ageMax)) {
    return false;
  }
  return ageMin === null || ageMax === null || ageMin <= ageMax;
}

/** Published events whose end has passed are finished by the hourly job. */
export function shouldFinishEvent(
  event: Pick<EventRuleInput, 'status' | 'endsAt'>,
  now: Date,
): boolean {
  return event.status === 'published' && event.endsAt.getTime() <= now.getTime();
}

/** New capacity must still hold everyone already registered. */
export function isValidCapacityChange(capacity: number | null, registeredCount: number): boolean {
  if (capacity === null) {
    return true;
  }
  return Number.isInteger(capacity) && capacity >= 1 && capacity >= registeredCount;
}
