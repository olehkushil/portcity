import {
  ADMIN_EVENTS,
  CLUB_EVENTS,
  IDENTITY_EVENTS,
  type OutboxEventPayloads,
  type OutboxEventType,
  PARKING_EVENTS,
  PAYMENT_EVENTS,
  PROMO_EVENTS,
  RECEIPT_EVENTS,
  REWARD_EVENTS,
  type SupportRequestCreatedPayload,
} from '../../../common/contracts/events';
import type { NotificationKind, NotifyInput } from '../../../common/contracts/notifications';
import { DEFAULT_PARKING_TARIFF } from '../../../common/contracts/parking';
import type { OutboxJobData } from '../../../common/outbox/outbox.types';
import {
  type ReminderPolicy,
  type ReminderRequest,
  planTicketReminder,
  planVoucherExpiringReminder,
  ticketReminderId,
  voucherExpiringReminderId,
} from './reminders';
import { type RenderedMessage, type TemplateParams, renderTemplate } from './templates';

/** What the notifications-events processor should do for one outbox event. */
export type EventAction =
  | { type: 'notify'; input: NotifyInput }
  | { type: 'schedule_reminder'; request: ReminderRequest }
  | { type: 'cancel_reminder'; reminderId: string }
  | {
      type: 'broadcast';
      kind: 'promo_published' | 'event_published';
      message: RenderedMessage;
      data: Record<string, unknown>;
      /** Same key for every recipient (`outbox:<eventId>`); unique per (userId, dedupeKey). */
      dedupeKey: string;
    }
  /** user.deleted: drop the member's inbox and preferences (personal data). */
  | { type: 'erase_user'; userId: string }
  /** support.request_created: e-mail to SUPPORT_EMAIL through MailPort. */
  | { type: 'support_mail'; request: SupportRequestCreatedPayload }
  | { type: 'ignore'; reason: string };

export interface EventMappingContext {
  now: Date;
  reminders: ReminderPolicy;
}

/**
 * Outbox event types the notifications module consumes. The module registers exactly these
 * routes to QUEUES.notificationsEvents; `mapOutboxEvent` handles every one of them.
 */
export const HANDLED_EVENT_TYPES: readonly OutboxEventType[] = Object.freeze([
  RECEIPT_EVENTS.needsModeration,
  RECEIPT_EVENTS.rejected,
  RECEIPT_EVENTS.credited,
  CLUB_EVENTS.released,
  CLUB_EVENTS.expiring,
  CLUB_EVENTS.expired,
  ADMIN_EVENTS.adjustmentApplied,
  REWARD_EVENTS.voucherIssued,
  REWARD_EVENTS.voucherRedeemed,
  REWARD_EVENTS.voucherCancelled,
  REWARD_EVENTS.voucherExpired,
  PROMO_EVENTS.eventRegistered,
  PROMO_EVENTS.eventRegistrationCancelled,
  PROMO_EVENTS.eventCancelled,
  PROMO_EVENTS.eventPublished,
  PROMO_EVENTS.published,
  PARKING_EVENTS.sessionOpened,
  PARKING_EVENTS.sessionFreeEnding,
  PARKING_EVENTS.sessionPayable,
  PARKING_EVENTS.sessionPaid,
  PARKING_EVENTS.sessionExitSoon,
  PARKING_EVENTS.sessionOverstay,
  PARKING_EVENTS.sessionStillInside,
  PARKING_EVENTS.sessionClosed,
  PARKING_EVENTS.sessionDisputed,
  PAYMENT_EVENTS.succeeded,
  PAYMENT_EVENTS.failed,
  PAYMENT_EVENTS.refunded,
  IDENTITY_EVENTS.deletionRequested,
  IDENTITY_EVENTS.deletionCancelled,
  IDENTITY_EVENTS.deleted,
  ADMIN_EVENTS.supportRequestCreated,
]);

export function isHandledEventType(type: string): type is OutboxEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(type);
}

/** Dedupe key of the notification produced by an outbox event (idempotency by eventId). */
export function eventDedupeKey(eventId: string, userId?: string): string {
  return userId ? `outbox:${eventId}:${userId}` : `outbox:${eventId}`;
}

function payloadOf<T extends OutboxEventType>(
  event: OutboxJobData,
  _type: T,
): OutboxEventPayloads[T] {
  // The dispatcher forwards the JSON payload the producer built with buildOutboxEvent().
  return event.payload as OutboxEventPayloads[T];
}

function dateOf(value: string | null | undefined, fallback: Date): Date {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function notify<K extends NotificationKind>(
  event: OutboxJobData,
  userId: string,
  kind: K,
  params: TemplateParams[K],
  data: Record<string, unknown>,
  dedupeKey: string = eventDedupeKey(event.eventId),
): EventAction {
  const message = renderTemplate(kind, params);
  return {
    type: 'notify',
    input: { userId, kind, title: message.title, body: message.body, data, dedupeKey },
  };
}

const ignore = (reason: string): EventAction[] => [{ type: 'ignore', reason }];

/**
 * Pure mapping of a consumed outbox event to notification actions (brief sections 3 and 9).
 * Decisions worth knowing:
 * - `receipt.approved` is not consumed: `receipt.credited` follows it with the points amount;
 * - `payment.succeeded` for parking is covered by `parking.session.paid`, so only non-parking
 *   payments produce `payment_succeeded`;
 * - `payment.refunded` produces `payment_refunded` for parking payments only: parking refunds a
 *   payment it cannot use automatically (late payment for a closed session, hour already paid),
 *   with nobody from the back office to tell the member; other purposes stay silent;
 * - `voucher.expired` has no notification kind; it only cancels the pending expiry reminder;
 * - `promo.published` and `event.published` are marketing broadcasts to
 *   IDENTITY_PORT.listMarketingAudience();
 * - `event.registered` confirms the registration (`event_registered`) and plans the reminder;
 * - `support.request_created` confirms the request in-app ("Звернення № N прийнято") and
 *   e-mails the support desk;
 * - parking reminders (free_ending, exit_soon, still_inside) carry the canonical design texts;
 * - `user.deleted` erases the inbox and preferences of the anonymised member.
 */
export function mapOutboxEvent(event: OutboxJobData, context: EventMappingContext): EventAction[] {
  const occurredAt = dateOf(event.occurredAt, context.now);
  switch (event.type) {
    case RECEIPT_EVENTS.needsModeration: {
      const p = payloadOf(event, RECEIPT_EVENTS.needsModeration);
      return [
        notify(
          event,
          p.userId,
          'receipt_needs_moderation',
          { totalKopecks: p.totalKopecks },
          { receiptId: p.receiptId },
        ),
      ];
    }
    case RECEIPT_EVENTS.rejected: {
      const p = payloadOf(event, RECEIPT_EVENTS.rejected);
      return [
        notify(
          event,
          p.userId,
          'receipt_rejected',
          { reason: p.reason },
          { receiptId: p.receiptId, code: p.code },
        ),
      ];
    }
    case RECEIPT_EVENTS.credited: {
      const p = payloadOf(event, RECEIPT_EVENTS.credited);
      const data = { receiptId: p.receiptId, pointsTxId: p.pointsTxId, points: p.pointsAwarded };
      if (p.pointsState === 'pending' && p.availableAt) {
        return [
          notify(
            event,
            p.userId,
            'receipt_held',
            {
              totalKopecks: p.totalKopecks,
              points: p.pointsAwarded,
              availableAt: dateOf(p.availableAt, occurredAt),
            },
            data,
          ),
        ];
      }
      return [
        notify(
          event,
          p.userId,
          'receipt_credited',
          { totalKopecks: p.totalKopecks, points: p.pointsAwarded },
          data,
        ),
      ];
    }
    case CLUB_EVENTS.released: {
      const p = payloadOf(event, CLUB_EVENTS.released);
      return [
        notify(
          event,
          p.userId,
          'points_released',
          { points: p.amount, availableBalance: p.availableBalance },
          { txId: p.txId, accountId: p.accountId },
        ),
      ];
    }
    case CLUB_EVENTS.expiring: {
      const p = payloadOf(event, CLUB_EVENTS.expiring);
      return [
        notify(
          event,
          p.userId,
          'points_expiring',
          { points: p.points, expiresOn: p.expiresOn, daysLeft: p.daysLeft },
          { accountId: p.accountId, expiresOn: p.expiresOn, daysLeft: p.daysLeft },
        ),
      ];
    }
    case CLUB_EVENTS.expired: {
      const p = payloadOf(event, CLUB_EVENTS.expired);
      return [
        notify(
          event,
          p.userId,
          'points_expired',
          { points: p.points, expiredOn: p.expiredOn, availableBalance: p.availableBalance },
          { accountId: p.accountId, expiredOn: p.expiredOn },
        ),
      ];
    }
    case ADMIN_EVENTS.adjustmentApplied: {
      const p = payloadOf(event, ADMIN_EVENTS.adjustmentApplied);
      return [
        notify(
          event,
          p.userId,
          'points_adjusted',
          { amount: p.amount, reason: p.reason },
          { adjustmentId: p.adjustmentId, pointsTxId: p.pointsTxId },
        ),
      ];
    }
    case REWARD_EVENTS.voucherIssued: {
      const p = payloadOf(event, REWARD_EVENTS.voucherIssued);
      const actions: EventAction[] = [
        notify(
          event,
          p.userId,
          'voucher_issued',
          {
            voucherKind: p.kind,
            title: p.title,
            expiresAt: p.expiresAt ? dateOf(p.expiresAt, occurredAt) : null,
          },
          { voucherId: p.voucherId, voucherKind: p.kind, tenantId: p.tenantId },
        ),
      ];
      const reminder = planVoucherExpiringReminder(p, context.now, context.reminders);
      if (reminder) {
        actions.push({ type: 'schedule_reminder', request: reminder });
      }
      return actions;
    }
    case REWARD_EVENTS.voucherRedeemed: {
      const p = payloadOf(event, REWARD_EVENTS.voucherRedeemed);
      return [
        notify(
          event,
          p.userId,
          'voucher_redeemed',
          { title: p.title, redeemedAt: dateOf(p.redeemedAt, occurredAt) },
          { voucherId: p.voucherId, tenantId: p.redeemedByTenantId },
        ),
        { type: 'cancel_reminder', reminderId: voucherExpiringReminderId(p.voucherId) },
      ];
    }
    case REWARD_EVENTS.voucherCancelled: {
      const p = payloadOf(event, REWARD_EVENTS.voucherCancelled);
      return [
        notify(
          event,
          p.userId,
          'voucher_cancelled',
          { title: p.title, reason: p.reason, pointsRefunded: p.pointsRefunded },
          { voucherId: p.voucherId, pointsRefunded: p.pointsRefunded },
        ),
        { type: 'cancel_reminder', reminderId: voucherExpiringReminderId(p.voucherId) },
      ];
    }
    case REWARD_EVENTS.voucherExpired: {
      const p = payloadOf(event, REWARD_EVENTS.voucherExpired);
      return [
        { type: 'cancel_reminder', reminderId: voucherExpiringReminderId(p.voucherId) },
        { type: 'ignore', reason: 'voucher.expired has no notification kind' },
      ];
    }
    case PROMO_EVENTS.eventRegistered: {
      const p = payloadOf(event, PROMO_EVENTS.eventRegistered);
      const actions: EventAction[] = [
        notify(
          event,
          p.userId,
          'event_registered',
          {
            title: p.title ?? null,
            startsAt: dateOf(p.startsAt, occurredAt),
            venue: p.venue ?? null,
            persons: p.adults + p.children,
          },
          {
            eventId: p.eventId,
            registrationId: p.registrationId,
            voucherId: p.voucherId,
            startsAt: p.startsAt,
          },
        ),
      ];
      const reminder = planTicketReminder(p, context.now, context.reminders);
      actions.push(
        reminder
          ? { type: 'schedule_reminder', request: reminder }
          : { type: 'ignore', reason: 'event starts too soon for a reminder' },
      );
      return actions;
    }
    case PROMO_EVENTS.eventRegistrationCancelled: {
      const p = payloadOf(event, PROMO_EVENTS.eventRegistrationCancelled);
      return [{ type: 'cancel_reminder', reminderId: ticketReminderId(p.registrationId) }];
    }
    case PROMO_EVENTS.eventCancelled: {
      const p = payloadOf(event, PROMO_EVENTS.eventCancelled);
      if (p.registeredUserIds.length === 0) {
        return ignore('event.cancelled without registered users');
      }
      return p.registeredUserIds.map((userId) =>
        notify(
          event,
          userId,
          'system',
          {
            title: 'Подію скасовано',
            body: `«${p.title}» скасовано. Квитки на цю подію анульовано.`,
          },
          { eventId: p.eventId },
          eventDedupeKey(event.eventId, userId),
        ),
      );
    }
    case PROMO_EVENTS.eventPublished: {
      const p = payloadOf(event, PROMO_EVENTS.eventPublished);
      return [
        {
          type: 'broadcast',
          kind: 'event_published',
          message: renderTemplate('event_published', {
            title: p.title,
            startsAt: dateOf(p.startsAt, occurredAt),
            venue: p.venue,
            admission: p.admission,
          }),
          data: {
            eventId: p.eventId,
            tenantId: p.tenantId,
            category: p.category,
            admission: p.admission,
            startsAt: p.startsAt,
          },
          dedupeKey: eventDedupeKey(event.eventId),
        },
      ];
    }
    case PROMO_EVENTS.published: {
      const p = payloadOf(event, PROMO_EVENTS.published);
      return [
        {
          type: 'broadcast',
          kind: 'promo_published',
          message: renderTemplate('promo_published', {
            title: p.title,
            validTo: dateOf(p.validTo, occurredAt),
          }),
          data: { promoId: p.promoId, tenantId: p.tenantId, promoKind: p.kind },
          dedupeKey: eventDedupeKey(event.eventId),
        },
      ];
    }
    case PARKING_EVENTS.sessionOpened: {
      const p = payloadOf(event, PARKING_EVENTS.sessionOpened);
      if (!p.userId) {
        return ignore('parking session without a member');
      }
      const enteredAt = dateOf(p.enteredAt, occurredAt);
      return [
        notify(
          event,
          p.userId,
          'parking_opened',
          {
            enteredAt,
            freeUntil: new Date(enteredAt.getTime() + DEFAULT_PARKING_TARIFF.freeMinutes * 60_000),
            plate: p.plate,
          },
          { sessionId: p.sessionId, plate: p.plate, zone: p.zone },
        ),
      ];
    }
    case PARKING_EVENTS.sessionFreeEnding: {
      const p = payloadOf(event, PARKING_EVENTS.sessionFreeEnding);
      if (!p.userId) {
        return ignore('parking session without a member');
      }
      const freeUntil = dateOf(p.deadline, occurredAt);
      const enteredAt = dateOf(p.enteredAt, occurredAt);
      const freeMinutes = Math.round((freeUntil.getTime() - enteredAt.getTime()) / 60_000);
      return [
        notify(
          event,
          p.userId,
          'parking_free_ending',
          {
            freeUntil,
            freeMinutes: freeMinutes > 0 ? freeMinutes : DEFAULT_PARKING_TARIFF.freeMinutes,
          },
          { sessionId: p.sessionId, reminder: p.reminder, deadline: p.deadline },
        ),
      ];
    }
    case PARKING_EVENTS.sessionExitSoon: {
      const p = payloadOf(event, PARKING_EVENTS.sessionExitSoon);
      if (!p.userId) {
        return ignore('parking session without a member');
      }
      return [
        notify(
          event,
          p.userId,
          'parking_exit_soon',
          {
            paidUntil: dateOf(p.paidUntil ?? p.deadline, occurredAt),
            minutesLeft: Math.max(0, p.minutesLeft),
          },
          { sessionId: p.sessionId, reminder: p.reminder, paidUntil: p.paidUntil ?? p.deadline },
        ),
      ];
    }
    case PARKING_EVENTS.sessionStillInside: {
      const p = payloadOf(event, PARKING_EVENTS.sessionStillInside);
      if (!p.userId) {
        return ignore('parking session without a member');
      }
      return [
        notify(
          event,
          p.userId,
          'parking_still_inside',
          { amountDueKopecks: p.amountDueKopecks },
          {
            sessionId: p.sessionId,
            reminder: p.reminder,
            status: p.status,
            amountDueKopecks: p.amountDueKopecks,
          },
        ),
      ];
    }
    case PARKING_EVENTS.sessionPayable: {
      const p = payloadOf(event, PARKING_EVENTS.sessionPayable);
      if (!p.userId) {
        return ignore('parking session without a member');
      }
      return [
        notify(
          event,
          p.userId,
          'parking_payable',
          {
            amountDueKopecks: p.amountDueKopecks,
            currentHourEndsAt: dateOf(p.currentHourEndsAt, occurredAt),
          },
          { sessionId: p.sessionId, amountDueKopecks: p.amountDueKopecks, plate: p.plate },
        ),
      ];
    }
    case PARKING_EVENTS.sessionPaid: {
      const p = payloadOf(event, PARKING_EVENTS.sessionPaid);
      if (!p.userId) {
        return ignore('parking session without a member');
      }
      return [
        notify(
          event,
          p.userId,
          'parking_paid',
          { amountPaidKopecks: p.amountPaidKopecks, paidUntil: dateOf(p.paidUntil, occurredAt) },
          { sessionId: p.sessionId, paymentId: p.paymentId, paidUntil: p.paidUntil },
        ),
      ];
    }
    case PARKING_EVENTS.sessionOverstay: {
      const p = payloadOf(event, PARKING_EVENTS.sessionOverstay);
      if (!p.userId) {
        return ignore('parking session without a member');
      }
      return [
        notify(
          event,
          p.userId,
          'parking_overstay',
          {
            amountDueKopecks: p.amountDueKopecks,
            paidUntil: p.paidUntil ? dateOf(p.paidUntil, occurredAt) : null,
          },
          { sessionId: p.sessionId, amountDueKopecks: p.amountDueKopecks },
        ),
      ];
    }
    case PARKING_EVENTS.sessionClosed: {
      const p = payloadOf(event, PARKING_EVENTS.sessionClosed);
      if (!p.userId) {
        return ignore('parking session without a member');
      }
      return [
        notify(
          event,
          p.userId,
          'parking_closed',
          {
            sessionId: p.sessionId,
            exitedAt: dateOf(p.exitedAt, occurredAt),
            amountPaidKopecks: p.amountPaidKopecks,
            status: p.status,
            closedReason: p.closedReason,
          },
          { sessionId: p.sessionId, status: p.status, closedReason: p.closedReason },
        ),
      ];
    }
    case PARKING_EVENTS.sessionDisputed: {
      const p = payloadOf(event, PARKING_EVENTS.sessionDisputed);
      if (!p.userId) {
        return ignore('parking session without a member');
      }
      return [
        notify(
          event,
          p.userId,
          'parking_disputed',
          { sessionId: p.sessionId, plate: p.plate, reason: p.reason },
          { sessionId: p.sessionId, reason: p.reason, disputedAt: p.disputedAt },
        ),
      ];
    }
    case PAYMENT_EVENTS.succeeded: {
      const p = payloadOf(event, PAYMENT_EVENTS.succeeded);
      if (p.purpose === 'parking') {
        return ignore('parking payments are announced by parking.session.paid');
      }
      return [
        notify(
          event,
          p.userId,
          'payment_succeeded',
          { amountKopecks: p.amountKopecks, purpose: p.purpose },
          { paymentId: p.paymentId, purpose: p.purpose },
        ),
      ];
    }
    case PAYMENT_EVENTS.failed: {
      const p = payloadOf(event, PAYMENT_EVENTS.failed);
      const sessionId = typeof p.meta.sessionId === 'string' ? p.meta.sessionId : null;
      return [
        notify(
          event,
          p.userId,
          'payment_failed',
          { amountKopecks: p.amountKopecks, failureCode: p.failureCode },
          { paymentId: p.paymentId, purpose: p.purpose, failureCode: p.failureCode, sessionId },
        ),
      ];
    }
    case PAYMENT_EVENTS.refunded: {
      const p = payloadOf(event, PAYMENT_EVENTS.refunded);
      if (p.purpose !== 'parking') {
        return ignore('only parking refunds are announced to the member');
      }
      const sessionId = typeof p.meta.sessionId === 'string' ? p.meta.sessionId : null;
      const plate = typeof p.meta.plate === 'string' ? p.meta.plate : null;
      return [
        notify(
          event,
          p.userId,
          'payment_refunded',
          {
            refundedKopecks: p.refundedKopecks,
            amountKopecks: p.amountKopecks,
            partial: p.partial,
            plate,
          },
          {
            paymentId: p.paymentId,
            purpose: p.purpose,
            sessionId,
            refundedKopecks: p.refundedKopecks,
            partial: p.partial,
          },
        ),
      ];
    }
    case IDENTITY_EVENTS.deletionRequested: {
      const p = payloadOf(event, IDENTITY_EVENTS.deletionRequested);
      return [
        notify(
          event,
          p.userId,
          'account_deletion_scheduled',
          { executeAfter: dateOf(p.executeAfter, occurredAt) },
          { requestId: p.requestId, executeAfter: p.executeAfter },
        ),
      ];
    }
    case IDENTITY_EVENTS.deletionCancelled: {
      const p = payloadOf(event, IDENTITY_EVENTS.deletionCancelled);
      return [
        notify(
          event,
          p.userId,
          'account_deletion_cancelled',
          { cancelledAt: dateOf(p.cancelledAt, occurredAt) },
          { requestId: p.requestId },
        ),
      ];
    }
    case IDENTITY_EVENTS.deleted: {
      const p = payloadOf(event, IDENTITY_EVENTS.deleted);
      return [{ type: 'erase_user', userId: p.userId }];
    }
    case ADMIN_EVENTS.supportRequestCreated: {
      const p = payloadOf(event, ADMIN_EVENTS.supportRequestCreated);
      return [
        notify(
          event,
          p.userId,
          'support_request_received',
          { number: p.number },
          { requestId: p.requestId, number: p.number, topic: p.topic },
        ),
        { type: 'support_mail', request: p },
      ];
    }
    default:
      return ignore(`unhandled event type "${event.type}"`);
  }
}
