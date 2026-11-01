/** JSON-serialisable event payload. Keep it small: ids and the facts consumers need. */
export type OutboxPayload = Record<string, unknown>;

export interface OutboxEventInput {
  /** Aggregate kind, e.g. `receipt`, `voucher`, `parking_session`. */
  aggregateType: string;
  aggregateId: string;
  /** Dotted event type, e.g. `receipt.credited`, `parking.session.payable`. */
  type: string;
  payload: OutboxPayload;
  /** Defaults to the clock's now. */
  occurredAt?: Date;
}

/** Shape of the BullMQ job data consumers receive (`Job<OutboxJobData>`). */
export interface OutboxJobData {
  eventId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: OutboxPayload;
  /** ISO 8601 UTC. */
  occurredAt: string;
}

export const OUTBOX_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;

export function assertOutboxEventType(type: string): void {
  if (!OUTBOX_EVENT_TYPE_PATTERN.test(type)) {
    throw new Error(
      `Invalid outbox event type "${type}": expected dotted lowercase segments like "receipt.credited"`,
    );
  }
}

/** Unrouted events are retried this many dispatcher ticks (about 5 minutes) before being dropped. */
export const UNROUTED_GIVE_UP_ATTEMPTS = 60;

export interface OutboxDispatchResult {
  fetched: number;
  published: number;
  /** Audit-only events (no consumer by design) marked published without a job. */
  ignored: number;
  unrouted: number;
  dropped: number;
  failed: number;
}
