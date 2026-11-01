import {
  IDENTITY_EVENTS,
  PAYMENT_EVENTS,
  type PaymentSucceededPayload,
  type UserDeletedPayload,
} from '../../../common/contracts/events';
import type { OutboxJobData } from '../../../common/outbox/outbox.types';
import type { PaymentApplication } from '../services/parking-payments.service';
import type { ParkingErasureSummary } from '../services/parking-erasure.service';

/** Event types the parking module consumes from the outbox (queue `parking-events`). */
export const PARKING_CONSUMED_EVENTS: readonly string[] = [
  PAYMENT_EVENTS.succeeded,
  IDENTITY_EVENTS.deleted,
];

export interface ParkingEventsDeps {
  applyPaymentSucceeded(payload: PaymentSucceededPayload): Promise<PaymentApplication>;
  eraseUser(userId: string): Promise<ParkingErasureSummary>;
}

export type ParkingEventOutcome =
  | PaymentApplication
  | ({ action: 'erased' } & ParkingErasureSummary)
  | { action: 'ignored'; reason: string; sessionId: null };

/**
 * Consumer of outbox events on `parking-events` (job name = event type):
 * - `payment.succeeded` for a parking payment marks the session paid (idempotent);
 * - `user.deleted` removes the plates of the erased account (vehicles, sessions; idempotent,
 *   see ParkingErasureService).
 * The reminder events parking publishes are consumed by the notifications module.
 */
export async function handleParkingEvent(
  event: OutboxJobData,
  deps: ParkingEventsDeps,
): Promise<ParkingEventOutcome> {
  if (event.type === PAYMENT_EVENTS.succeeded) {
    // The payload was built by the payments module with buildOutboxEvent(PAYMENT_EVENTS.succeeded).
    return deps.applyPaymentSucceeded(event.payload as PaymentSucceededPayload);
  }
  if (event.type === IDENTITY_EVENTS.deleted) {
    const payload = event.payload as Partial<UserDeletedPayload>;
    if (typeof payload.userId !== 'string' || payload.userId === '') {
      return { action: 'ignored', reason: 'user.deleted without userId', sessionId: null };
    }
    return { action: 'erased', ...(await deps.eraseUser(payload.userId)) };
  }
  return { action: 'ignored', reason: `unhandled event type "${event.type}"`, sessionId: null };
}
