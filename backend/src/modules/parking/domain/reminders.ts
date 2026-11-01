import type { ParkingSessionStatus } from '../../../common/contracts/parking';
import { HOUR_MS, MINUTE_MS } from './tariff';

/**
 * Time-based reminders published through the outbox (design brief 4.1):
 * - `free_ending`: N minutes before the free period ends (F2, «Безкоштовні 30 хв закінчуються о 14:30»);
 * - `exit_soon`: N minutes before the paid period ends (F4, «Виїзд до 16:00 — залишилось 10 хв»);
 * - `still_inside`: payable for 5 h since the entry, or overstaying for 2 h (F7, «Ви ще на паркінгу?»).
 */
export const REMINDER_KINDS = ['free_ending', 'exit_soon', 'still_inside'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export interface ReminderSettings {
  freeEndingMinutes: number;
  exitSoonMinutes: number;
  /** F7 threshold for an unpaid session, counted from the entry. */
  stillInsidePayableHours: number;
  /** F7 threshold for an overstay, counted from the end of the paid period. */
  stillInsideOverstayHours: number;
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = Object.freeze({
  freeEndingMinutes: 5,
  exitSoonMinutes: 10,
  stillInsidePayableHours: 5,
  stillInsideOverstayHours: 2,
});

export interface ReminderFacts {
  /** Status derived at `now`. */
  status: ParkingSessionStatus;
  enteredAt: Date;
  freeUntil: Date;
  paidUntil: Date | null;
  /** Last «Так, я тут» (F7): the still_inside reminder counts from it when it is later. */
  presenceConfirmedAt?: Date | null;
}

function laterOf(base: Date, other?: Date | null): Date {
  return other && other.getTime() > base.getTime() ? other : base;
}

export interface ReminderMoment {
  kind: ReminderKind;
  /** When the reminder becomes due. */
  at: Date;
  /** The deadline the reminder talks about (free end, paid end, or the F7 threshold itself). */
  deadline: Date;
}

/** The reminder that applies to the current status, if any, with its trigger moment. */
export function reminderMoment(
  facts: ReminderFacts,
  settings: ReminderSettings = DEFAULT_REMINDER_SETTINGS,
): ReminderMoment | null {
  switch (facts.status) {
    case 'open':
      return {
        kind: 'free_ending',
        at: new Date(facts.freeUntil.getTime() - settings.freeEndingMinutes * MINUTE_MS),
        deadline: facts.freeUntil,
      };
    case 'paid':
      return facts.paidUntil
        ? {
            kind: 'exit_soon',
            at: new Date(facts.paidUntil.getTime() - settings.exitSoonMinutes * MINUTE_MS),
            deadline: facts.paidUntil,
          }
        : null;
    case 'payable': {
      const since = laterOf(facts.enteredAt, facts.presenceConfirmedAt);
      const at = new Date(since.getTime() + settings.stillInsidePayableHours * HOUR_MS);
      return { kind: 'still_inside', at, deadline: at };
    }
    case 'overstay': {
      if (!facts.paidUntil) {
        return null;
      }
      const since = laterOf(facts.paidUntil, facts.presenceConfirmedAt);
      const at = new Date(since.getTime() + settings.stillInsideOverstayHours * HOUR_MS);
      return { kind: 'still_inside', at, deadline: at };
    }
    default:
      return null;
  }
}

/**
 * Reminders due between the previous evaluation and `now`. Stateless and idempotent: a reminder
 * fires in the one evaluation whose interval (previousCheckAt, now] contains its trigger moment,
 * so the 60-second sync job publishes each reminder once without a "sent" column. A session seen
 * for the first time (`previousCheckAt` null) gets the reminder when it is already inside the
 * reminder window but the deadline has not passed yet.
 */
export function dueReminders(
  facts: ReminderFacts,
  previousCheckAt: Date | null,
  now: Date,
  settings: ReminderSettings = DEFAULT_REMINDER_SETTINGS,
): ReminderMoment[] {
  const moment = reminderMoment(facts, settings);
  if (!moment) {
    return [];
  }
  const at = moment.at.getTime();
  const nowMs = now.getTime();
  if (at > nowMs) {
    return [];
  }
  if (moment.kind !== 'still_inside' && nowMs >= moment.deadline.getTime()) {
    return [];
  }
  if (previousCheckAt && previousCheckAt.getTime() >= at) {
    return [];
  }
  return [moment];
}
