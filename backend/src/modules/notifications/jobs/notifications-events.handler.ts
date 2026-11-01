import type { MarketingAudiencePage } from '../../../common/contracts/identity';
import type { NotificationSummary, NotifyInput } from '../../../common/contracts/notifications';
import type { EventSummary } from '../../../common/contracts/promos';
import type { OutboxJobData } from '../../../common/outbox/outbox.types';
import { type EventAction, mapOutboxEvent } from '../domain/event-mapper';
import { isPlainRecord } from '../domain/kinds';
import {
  REMINDER_JOBS,
  type ReminderPolicy,
  type ReminderRequest,
  type TicketReminderData,
  type VoucherExpiringReminderData,
} from '../domain/reminders';
import {
  type MailMessage,
  type SupportMailMember,
  parseMailRecipients,
  renderSupportRequestMail,
} from '../domain/support-mail';
import { renderTemplate } from '../domain/templates';

export interface NotificationsEventDeps {
  now(): Date;
  notify(input: NotifyInput): Promise<NotificationSummary | null>;
  scheduleReminder(request: ReminderRequest): Promise<boolean>;
  cancelReminder(reminderId: string): Promise<boolean>;
  getEvent(eventId: string): Promise<EventSummary | null>;
  /** One page of members with a granted `marketing` consent (IDENTITY_PORT.listMarketingAudience). */
  listMarketingAudience(cursor: string | null, limit: number): Promise<MarketingAudiencePage>;
  /** user.deleted: deletes the member's notifications (push deliveries cascade) and preferences. */
  eraseUser(userId: string): Promise<ErasedUserData>;
  reminders: ReminderPolicy;
  /** Page size for marketing broadcasts (default MARKETING_AUDIENCE_PAGE_SIZE). */
  audiencePageSize?: number;
  /** Hands one e-mail to MailPort; throws when it could not be sent (the job is retried). */
  sendMail?(message: MailMessage): Promise<void>;
  /** SUPPORT_EMAIL (several addresses separated by commas); unset means no support e-mail. */
  supportEmail?: string | null;
  /** Member contact for the support e-mail (IDENTITY_PORT.getUser). */
  getMemberContact?(userId: string): Promise<SupportMailMember | null>;
  log?: (message: string) => void;
}

export interface ErasedUserData {
  notifications: number;
  preferences: number;
}

/** Recipients fetched per IDENTITY_PORT.listMarketingAudience call. */
export const MARKETING_AUDIENCE_PAGE_SIZE = 500;

/** Safety stop for a broken cursor that never ends (500 x 2000 = one million recipients). */
const MAX_AUDIENCE_PAGES = 2000;

export interface NotificationsEventOutcome {
  job: string;
  /** Notifications stored. */
  notified: number;
  /** notify() returned null (preference, consent, inactive user, replay). */
  skipped: number;
  scheduled: number;
  cancelled: number;
  ignored: string[];
  /** Set for user.deleted: rows removed from the member's inbox and preferences. */
  erased?: ErasedUserData;
  /** Set when e-mails were sent (support.request_created). */
  mailed?: number;
}

export function isOutboxJobData(value: unknown): value is OutboxJobData {
  return (
    isPlainRecord(value) &&
    typeof value.eventId === 'string' &&
    typeof value.type === 'string' &&
    isPlainRecord(value.payload)
  );
}

export function isTicketReminderData(value: unknown): value is TicketReminderData {
  return (
    isPlainRecord(value) &&
    typeof value.userId === 'string' &&
    typeof value.eventId === 'string' &&
    typeof value.registrationId === 'string' &&
    typeof value.startsAt === 'string'
  );
}

export function isVoucherExpiringReminderData(
  value: unknown,
): value is VoucherExpiringReminderData {
  return (
    isPlainRecord(value) &&
    typeof value.userId === 'string' &&
    typeof value.voucherId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.expiresAt === 'string'
  );
}

function emptyOutcome(job: string): NotificationsEventOutcome {
  return { job, notified: 0, skipped: 0, scheduled: 0, cancelled: 0, ignored: [] };
}

async function record(
  outcome: NotificationsEventOutcome,
  deps: NotificationsEventDeps,
  input: NotifyInput,
): Promise<void> {
  const created = await deps.notify(input);
  if (created) {
    outcome.notified += 1;
  } else {
    outcome.skipped += 1;
  }
}

async function applyAction(
  action: EventAction,
  deps: NotificationsEventDeps,
  outcome: NotificationsEventOutcome,
): Promise<void> {
  switch (action.type) {
    case 'notify':
      await record(outcome, deps, action.input);
      return;
    case 'schedule_reminder':
      if (await deps.scheduleReminder(action.request)) {
        outcome.scheduled += 1;
      } else {
        outcome.ignored.push(`reminder ${action.request.id} is already due`);
      }
      return;
    case 'cancel_reminder':
      if (await deps.cancelReminder(action.reminderId)) {
        outcome.cancelled += 1;
      }
      return;
    case 'broadcast': {
      const limit = deps.audiencePageSize ?? MARKETING_AUDIENCE_PAGE_SIZE;
      let cursor: string | null = null;
      let recipients = 0;
      for (let page = 0; page < MAX_AUDIENCE_PAGES; page += 1) {
        const batch: MarketingAudiencePage = await deps.listMarketingAudience(cursor, limit);
        for (const userId of batch.userIds) {
          recipients += 1;
          // A retried job replays the same dedupe key per member, so nobody gets it twice.
          await record(outcome, deps, {
            userId,
            kind: action.kind,
            title: action.message.title,
            body: action.message.body,
            data: action.data,
            dedupeKey: action.dedupeKey,
          });
        }
        if (!batch.nextCursor || batch.nextCursor === cursor) {
          break;
        }
        cursor = batch.nextCursor;
      }
      if (recipients === 0) {
        outcome.ignored.push('marketing broadcast has no audience (no marketing consents)');
      }
      return;
    }
    case 'erase_user':
      outcome.erased = await deps.eraseUser(action.userId);
      return;
    case 'support_mail': {
      const recipients = parseMailRecipients(deps.supportEmail);
      if (!deps.sendMail || recipients.length === 0) {
        outcome.ignored.push('SUPPORT_EMAIL is not set; support request e-mail skipped');
        return;
      }
      const member = deps.getMemberContact
        ? await deps.getMemberContact(action.request.userId)
        : null;
      // Sent after the member notification: a retried job dedupes the notification by its key
      // and only repeats the e-mail.
      await deps.sendMail(
        renderSupportRequestMail({ request: action.request, member, to: recipients }),
      );
      outcome.mailed = (outcome.mailed ?? 0) + 1;
      return;
    }
    case 'ignore':
      outcome.ignored.push(action.reason);
      return;
  }
}

async function handleTicketReminder(
  data: unknown,
  deps: NotificationsEventDeps,
): Promise<NotificationsEventOutcome> {
  const outcome = emptyOutcome(REMINDER_JOBS.ticket);
  if (!isTicketReminderData(data)) {
    throw new Error('reminder.ticket job carries malformed data');
  }
  const event = await deps.getEvent(data.eventId);
  if (!event) {
    outcome.ignored.push(`event ${data.eventId} no longer exists`);
    return outcome;
  }
  if (event.status === 'cancelled' || event.status === 'finished') {
    outcome.ignored.push(`event ${data.eventId} is ${event.status}`);
    return outcome;
  }
  if (event.startsAt.getTime() <= deps.now().getTime()) {
    outcome.ignored.push(`event ${data.eventId} already started`);
    return outcome;
  }
  const message = renderTemplate('ticket_reminder', {
    title: event.title,
    startsAt: event.startsAt,
    venue: event.venue,
  });
  await record(outcome, deps, {
    userId: data.userId,
    kind: 'ticket_reminder',
    title: message.title,
    body: message.body,
    data: { eventId: data.eventId, registrationId: data.registrationId, voucherId: data.voucherId },
    dedupeKey: `reminder:ticket:${data.registrationId}`,
  });
  return outcome;
}

async function handleVoucherExpiringReminder(
  data: unknown,
  deps: NotificationsEventDeps,
): Promise<NotificationsEventOutcome> {
  const outcome = emptyOutcome(REMINDER_JOBS.voucherExpiring);
  if (!isVoucherExpiringReminderData(data)) {
    throw new Error('reminder.voucher_expiring job carries malformed data');
  }
  const expiresAt = new Date(data.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= deps.now().getTime()) {
    outcome.ignored.push(`voucher ${data.voucherId} already expired`);
    return outcome;
  }
  const message = renderTemplate('voucher_expiring', { title: data.title, expiresAt });
  await record(outcome, deps, {
    userId: data.userId,
    kind: 'voucher_expiring',
    title: message.title,
    body: message.body,
    data: { voucherId: data.voucherId, voucherKind: data.voucherKind, expiresAt: data.expiresAt },
    dedupeKey: `reminder:voucher:${data.voucherId}`,
  });
  return outcome;
}

/**
 * Handler of every job on the notifications-events queue: outbox events (job name = event
 * type, data = OutboxJobData) and the module's own delayed reminders. Plain function,
 * unit-tested with fake deps; the processor only wires it (brief section 9).
 */
export async function handleNotificationsEventJob(
  name: string,
  data: unknown,
  deps: NotificationsEventDeps,
): Promise<NotificationsEventOutcome> {
  if (name === REMINDER_JOBS.ticket) {
    return handleTicketReminder(data, deps);
  }
  if (name === REMINDER_JOBS.voucherExpiring) {
    return handleVoucherExpiringReminder(data, deps);
  }
  if (!isOutboxJobData(data)) {
    throw new Error(`Job "${name}" does not carry outbox event data`);
  }
  const outcome = emptyOutcome(name);
  const actions = mapOutboxEvent(data, { now: deps.now(), reminders: deps.reminders });
  for (const action of actions) {
    await applyAction(action, deps, outcome);
  }
  deps.log?.(
    `${name} (${data.eventId}): notified ${outcome.notified}, skipped ${outcome.skipped}, scheduled ${outcome.scheduled}, cancelled ${outcome.cancelled}${
      outcome.mailed ? `, mailed ${outcome.mailed}` : ''
    }${outcome.ignored.length > 0 ? `, ignored: ${outcome.ignored.join('; ')}` : ''}`,
  );
  return outcome;
}
