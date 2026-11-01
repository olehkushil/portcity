import { OUTBOX_EVENT_TYPE_PATTERN } from '../outbox/outbox.types';
import {
  ALL_OUTBOX_EVENT_TYPES,
  OUTBOX_AGGREGATES,
  RECEIPT_EVENTS,
  buildOutboxEvent,
  isOutboxEventType,
} from './events';

describe('outbox event catalogue', () => {
  it('names every event the way the dispatcher and router expect', () => {
    for (const type of ALL_OUTBOX_EVENT_TYPES) {
      expect(type).toMatch(OUTBOX_EVENT_TYPE_PATTERN);
    }
  });

  it('has no duplicate names', () => {
    expect(new Set(ALL_OUTBOX_EVENT_TYPES).size).toBe(ALL_OUTBOX_EVENT_TYPES.length);
  });

  it('recognises catalogue types and rejects unknown ones', () => {
    expect(isOutboxEventType('receipt.credited')).toBe(true);
    expect(isOutboxEventType('receipt.exploded')).toBe(false);
  });

  it('builds a publishable event input', () => {
    const occurredAt = new Date('2026-03-01T10:00:00.000Z');
    const event = buildOutboxEvent(
      RECEIPT_EVENTS.approved,
      OUTBOX_AGGREGATES.receipt,
      'receipt-1',
      { receiptId: 'receipt-1', userId: 'user-1', moderatorId: null },
      occurredAt,
    );
    expect(event).toEqual({
      aggregateType: 'receipt',
      aggregateId: 'receipt-1',
      type: 'receipt.approved',
      payload: { receiptId: 'receipt-1', userId: 'user-1', moderatorId: null },
      occurredAt,
    });
    expect(
      buildOutboxEvent(RECEIPT_EVENTS.approved, OUTBOX_AGGREGATES.receipt, 'receipt-1', {
        receiptId: 'receipt-1',
        userId: 'user-1',
        moderatorId: null,
      }),
    ).not.toHaveProperty('occurredAt');
  });
});
