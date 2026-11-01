import { IDENTITY_EVENTS, PAYMENT_EVENTS } from '../../../common/contracts/events';
import type { OutboxJobData } from '../../../common/outbox/outbox.types';
import { PARKING_CONSUMED_EVENTS, handleParkingEvent } from './parking-events.handler';

function job(type: string, payload: Record<string, unknown> = {}): OutboxJobData {
  return {
    eventId: 'evt-1',
    type,
    aggregateType: 'payment',
    aggregateId: 'p-1',
    payload,
    occurredAt: '2026-01-15T13:21:00.000Z',
  };
}

describe('handleParkingEvent', () => {
  const applyPaymentSucceeded = jest.fn(async () => ({
    action: 'applied' as const,
    sessionId: 's-1',
    status: 'paid',
    paidUntil: null,
  }));
  const eraseUser = jest.fn(async (userId: string) => ({
    userId,
    vehiclesErased: 1,
    closedSessionsScrubbed: 2,
    activeSessionsUnlinked: 0,
  }));
  const deps = { applyPaymentSucceeded, eraseUser };

  beforeEach(() => {
    applyPaymentSucceeded.mockClear();
    eraseUser.mockClear();
  });

  it('routes payment.succeeded to the payment application', async () => {
    const payload = { paymentId: 'p-1', purpose: 'parking', meta: { sessionId: 's-1' } };
    await expect(
      handleParkingEvent(job(PAYMENT_EVENTS.succeeded, payload), deps),
    ).resolves.toMatchObject({ action: 'applied', sessionId: 's-1' });
    expect(applyPaymentSucceeded).toHaveBeenCalledWith(payload);
  });

  it('erases the plates of a deleted account', async () => {
    const payload = { userId: 'u-1', requestId: 'r-1', deletedAt: '2026-01-15T13:00:00.000Z' };
    await expect(handleParkingEvent(job(IDENTITY_EVENTS.deleted, payload), deps)).resolves.toEqual({
      action: 'erased',
      userId: 'u-1',
      vehiclesErased: 1,
      closedSessionsScrubbed: 2,
      activeSessionsUnlinked: 0,
    });
    expect(eraseUser).toHaveBeenCalledWith('u-1');
  });

  it('ignores a user.deleted event without a user id', async () => {
    await expect(handleParkingEvent(job(IDENTITY_EVENTS.deleted, {}), deps)).resolves.toMatchObject(
      {
        action: 'ignored',
      },
    );
    expect(eraseUser).not.toHaveBeenCalled();
  });

  it('ignores anything else (the reminder events belong to notifications)', async () => {
    await expect(handleParkingEvent(job('payment.failed'), deps)).resolves.toMatchObject({
      action: 'ignored',
    });
    await expect(
      handleParkingEvent(job('parking.session.free_ending'), deps),
    ).resolves.toMatchObject({ action: 'ignored' });
    expect(applyPaymentSucceeded).not.toHaveBeenCalled();
  });

  it('lists the consumed types for the outbox routes', () => {
    expect(PARKING_CONSUMED_EVENTS).toEqual(['payment.succeeded', 'user.deleted']);
  });
});
