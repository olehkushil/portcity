import { IDENTITY_EVENTS, type UserDeletedPayload } from '../../../common/contracts/events';
import type { OutboxJobData } from '../../../common/outbox/outbox.types';
import type { PaymentsErasureSummary } from '../services/payments-erasure.service';

/** Event types the payments module consumes from the outbox (queue `payments-events`). */
export const PAYMENTS_CONSUMED_EVENTS: readonly string[] = [IDENTITY_EVENTS.deleted];

export interface PaymentsEventsDeps {
  eraseUser(userId: string): Promise<PaymentsErasureSummary>;
}

export type PaymentsEventOutcome =
  ({ action: 'erased' } & PaymentsErasureSummary) | { action: 'ignored'; reason: string };

/**
 * Consumer of outbox events on `payments-events` (job name = event type):
 * `user.deleted` removes personal details from the erased member's payments (idempotent, see
 * PaymentsErasureService); anything else is ignored.
 */
export async function handlePaymentsEvent(
  event: OutboxJobData,
  deps: PaymentsEventsDeps,
): Promise<PaymentsEventOutcome> {
  if (event.type !== IDENTITY_EVENTS.deleted) {
    return { action: 'ignored', reason: `unhandled event type "${event.type}"` };
  }
  const payload = event.payload as Partial<UserDeletedPayload>;
  if (typeof payload.userId !== 'string' || payload.userId === '') {
    return { action: 'ignored', reason: 'user.deleted without userId' };
  }
  return { action: 'erased', ...(await deps.eraseUser(payload.userId)) };
}
