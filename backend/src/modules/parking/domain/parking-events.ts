import {
  OUTBOX_AGGREGATES,
  PARKING_EVENTS,
  PARKING_REMINDER_EVENT_TYPES,
  type ParkingPaymentOpsAlertPayload,
  type ParkingSessionPayload,
  type ParkingSessionReminderPayload,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import type { Kopecks, Uuid } from '../../../common/contracts/shared';
import type { ParkingTransitionKind } from './reconcile';
import type { ReminderKind, ReminderMoment } from './reminders';
import type { SessionRecord } from './session-view';

/**
 * Reminder events (design brief 4.1) from the outbox catalogue: free period ending (F2), exit
 * soon (F4) and "still inside?" (F7). The notifications module consumes them on
 * `notifications-events`; parking only publishes.
 */
export type ParkingReminderEventType = (typeof PARKING_REMINDER_EVENT_TYPES)[number];

export const REMINDER_EVENT_BY_KIND: Readonly<Record<ReminderKind, ParkingReminderEventType>> =
  Object.freeze({
    free_ending: PARKING_EVENTS.sessionFreeEnding,
    exit_soon: PARKING_EVENTS.sessionExitSoon,
    still_inside: PARKING_EVENTS.sessionStillInside,
  });

/** Shape accepted by OutboxService.publish (catalogue events built with buildOutboxEvent). */
export interface ParkingOutboxEvent {
  aggregateType: string;
  aggregateId: Uuid;
  type: string;
  payload: Record<string, unknown>;
  occurredAt?: Date;
}

export interface TransitionContext {
  /** Due at `now` (for payable / overstay). */
  amountDueKopecks: Kopecks;
  currentHourEndsAt: Date;
  /** Payment that caused a `paid` transition, if any. */
  paymentId: Uuid | null;
}

function basePayload(record: SessionRecord): ParkingSessionPayload {
  return {
    sessionId: record.id,
    userId: record.userId,
    vehicleId: record.vehicleId,
    plate: record.plate,
    zone: record.zone,
    status: record.status,
    enteredAt: record.enteredAt.toISOString(),
  };
}

/** Maps reconciliation transitions of the (already updated) record to catalogue events. */
export function transitionEvents(
  record: SessionRecord,
  kinds: readonly ParkingTransitionKind[],
  context: TransitionContext,
  occurredAt: Date,
): ParkingOutboxEvent[] {
  const aggregate = OUTBOX_AGGREGATES.parkingSession;
  const base = basePayload(record);
  return kinds.map((kind): ParkingOutboxEvent => {
    switch (kind) {
      case 'opened':
        return buildOutboxEvent(
          PARKING_EVENTS.sessionOpened,
          aggregate,
          record.id,
          base,
          occurredAt,
        );
      case 'payable':
        return buildOutboxEvent(
          PARKING_EVENTS.sessionPayable,
          aggregate,
          record.id,
          {
            ...base,
            amountDueKopecks: context.amountDueKopecks,
            currentHourEndsAt: context.currentHourEndsAt.toISOString(),
          },
          occurredAt,
        );
      case 'paid':
        return buildOutboxEvent(
          PARKING_EVENTS.sessionPaid,
          aggregate,
          record.id,
          {
            ...base,
            paymentId: context.paymentId,
            amountPaidKopecks: record.amountPaidKopecks,
            paidUntil: (record.paidUntil ?? occurredAt).toISOString(),
          },
          occurredAt,
        );
      case 'overstay':
        return buildOutboxEvent(
          PARKING_EVENTS.sessionOverstay,
          aggregate,
          record.id,
          {
            ...base,
            paidUntil: record.paidUntil ? record.paidUntil.toISOString() : null,
            amountDueKopecks: context.amountDueKopecks,
          },
          occurredAt,
        );
      case 'closed':
        return buildOutboxEvent(
          PARKING_EVENTS.sessionClosed,
          aggregate,
          record.id,
          {
            ...base,
            exitedAt: (record.exitedAt ?? occurredAt).toISOString(),
            closedReason: record.closedReason,
            amountPaidKopecks: record.amountPaidKopecks,
          },
          occurredAt,
        );
    }
  });
}

/** `parking.session.disputed` (F2 «Це не моє авто» and other disputes). */
export function disputedEvent(
  record: SessionRecord,
  dispute: { reason: string; comment: string | null; disputedAt: Date },
): ParkingOutboxEvent {
  return buildOutboxEvent(
    PARKING_EVENTS.sessionDisputed,
    OUTBOX_AGGREGATES.parkingSession,
    record.id,
    {
      ...basePayload(record),
      reason: dispute.reason,
      comment: dispute.comment,
      disputedAt: dispute.disputedAt.toISOString(),
    },
    dispute.disputedAt,
  );
}

/** `parking.payment.ops_alert`: an app payment the session cannot use, or one ops must review. */
export function paymentOpsAlertEvent(
  payload: ParkingPaymentOpsAlertPayload,
  occurredAt: Date,
): ParkingOutboxEvent {
  return payload.sessionId
    ? buildOutboxEvent(
        PARKING_EVENTS.paymentOpsAlert,
        OUTBOX_AGGREGATES.parkingSession,
        payload.sessionId,
        payload,
        occurredAt,
      )
    : buildOutboxEvent(
        PARKING_EVENTS.paymentOpsAlert,
        OUTBOX_AGGREGATES.payment,
        payload.paymentId,
        payload,
        occurredAt,
      );
}

export function reminderEvent(
  record: SessionRecord,
  moment: ReminderMoment,
  amountDueKopecks: Kopecks,
  now: Date,
): ParkingOutboxEvent {
  const payload: ParkingSessionReminderPayload = {
    ...basePayload(record),
    reminder: moment.kind,
    deadline: moment.deadline.toISOString(),
    minutesLeft: Math.max(0, Math.ceil((moment.deadline.getTime() - now.getTime()) / 60_000)),
    source: record.source,
    amountDueKopecks,
    paidUntil: record.paidUntil ? record.paidUntil.toISOString() : null,
  };
  return buildOutboxEvent(
    REMINDER_EVENT_BY_KIND[moment.kind],
    OUTBOX_AGGREGATES.parkingSession,
    record.id,
    payload,
    now,
  );
}
