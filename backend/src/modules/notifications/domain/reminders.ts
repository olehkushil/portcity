import type {
  EventRegisteredPayload,
  VoucherIssuedPayload,
} from '../../../common/contracts/events';
import type { VoucherKind } from '../../../common/contracts/rewards';
import type { IsoDateTime, Uuid } from '../../../common/contracts/shared';

/**
 * Time-based notifications (ticket reminder, voucher about to expire) are delayed BullMQ jobs
 * on the notifications-events queue. Job ids are stable so a duplicate outbox delivery adds
 * nothing and a cancellation event can remove the pending job.
 */
export const REMINDER_JOBS = {
  ticket: 'reminder.ticket',
  voucherExpiring: 'reminder.voucher_expiring',
} as const;
export type ReminderJobName = (typeof REMINDER_JOBS)[keyof typeof REMINDER_JOBS];

export interface TicketReminderData {
  userId: Uuid;
  eventId: Uuid;
  registrationId: Uuid;
  voucherId: Uuid | null;
  startsAt: IsoDateTime;
}

export interface VoucherExpiringReminderData {
  userId: Uuid;
  voucherId: Uuid;
  voucherKind: VoucherKind;
  title: string;
  expiresAt: IsoDateTime;
}

export type ReminderRequest =
  | { id: string; jobName: typeof REMINDER_JOBS.ticket; runAt: Date; data: TicketReminderData }
  | {
      id: string;
      jobName: typeof REMINDER_JOBS.voucherExpiring;
      runAt: Date;
      data: VoucherExpiringReminderData;
    };

export interface ReminderPolicy {
  /** How long before the event / expiry the reminder fires. */
  ticketReminderHours: number;
  voucherExpiringHours: number;
  /** A reminder closer than this to `now` is not worth scheduling (default 15 minutes). */
  minLeadMs?: number;
}

export const DEFAULT_MIN_LEAD_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;

export function ticketReminderId(registrationId: Uuid): string {
  return `ticket-reminder-${registrationId}`;
}

export function voucherExpiringReminderId(voucherId: Uuid): string {
  return `voucher-expiring-${voucherId}`;
}

function parseIso(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Reminder before an event starts; null when the event is too close or in the past. */
export function planTicketReminder(
  payload: EventRegisteredPayload,
  now: Date,
  policy: ReminderPolicy,
): ReminderRequest | null {
  const startsAt = parseIso(payload.startsAt);
  if (!startsAt) {
    return null;
  }
  const runAt = new Date(startsAt.getTime() - policy.ticketReminderHours * HOUR_MS);
  if (runAt.getTime() - now.getTime() < (policy.minLeadMs ?? DEFAULT_MIN_LEAD_MS)) {
    return null;
  }
  return {
    id: ticketReminderId(payload.registrationId),
    jobName: REMINDER_JOBS.ticket,
    runAt,
    data: {
      userId: payload.userId,
      eventId: payload.eventId,
      registrationId: payload.registrationId,
      voucherId: payload.voucherId,
      startsAt: payload.startsAt,
    },
  };
}

/**
 * Reminder before a voucher expires; null without a hard expiry, for tickets (the event
 * reminder covers them) or when the expiry is too close.
 */
export function planVoucherExpiringReminder(
  payload: VoucherIssuedPayload,
  now: Date,
  policy: ReminderPolicy,
): ReminderRequest | null {
  if (!payload.expiresAt || payload.kind === 'ticket') {
    return null;
  }
  const expiresAt = parseIso(payload.expiresAt);
  if (!expiresAt) {
    return null;
  }
  const runAt = new Date(expiresAt.getTime() - policy.voucherExpiringHours * HOUR_MS);
  if (runAt.getTime() - now.getTime() < (policy.minLeadMs ?? DEFAULT_MIN_LEAD_MS)) {
    return null;
  }
  return {
    id: voucherExpiringReminderId(payload.voucherId),
    jobName: REMINDER_JOBS.voucherExpiring,
    runAt,
    data: {
      userId: payload.userId,
      voucherId: payload.voucherId,
      voucherKind: payload.kind,
      title: payload.title,
      expiresAt: payload.expiresAt,
    },
  };
}

export function isReminderJobName(name: string): name is ReminderJobName {
  return name === REMINDER_JOBS.ticket || name === REMINDER_JOBS.voucherExpiring;
}
