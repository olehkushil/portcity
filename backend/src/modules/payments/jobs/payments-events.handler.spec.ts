import { IDENTITY_EVENTS } from '../../../common/contracts/events';
import type { OutboxJobData } from '../../../common/outbox/outbox.types';
import { PAYMENTS_CONSUMED_EVENTS, handlePaymentsEvent } from './payments-events.handler';

function job(type: string, payload: Record<string, unknown> = {}): OutboxJobData {
  return {
    eventId: 'evt-1',
    type,
    aggregateType: 'user',
    aggregateId: 'u-1',
    payload,
    occurredAt: '2026-11-01T10:00:00.000Z',
  };
}

describe('handlePaymentsEvent', () => {
  const eraseUser = jest.fn(async (userId: string) => ({ userId, checked: 3, scrubbed: 2 }));

  beforeEach(() => eraseUser.mockClear());

  it('erases personal data of a deleted account', async () => {
    const payload = { userId: 'u-1', requestId: 'r-1', deletedAt: '2026-11-01T09:00:00.000Z' };
    await expect(
      handlePaymentsEvent(job(IDENTITY_EVENTS.deleted, payload), { eraseUser }),
    ).resolves.toEqual({ action: 'erased', userId: 'u-1', checked: 3, scrubbed: 2 });
    expect(eraseUser).toHaveBeenCalledWith('u-1');
  });

  it('ignores user.deleted without a user id and any other event', async () => {
    await expect(
      handlePaymentsEvent(job(IDENTITY_EVENTS.deleted, {}), { eraseUser }),
    ).resolves.toMatchObject({ action: 'ignored' });
    await expect(handlePaymentsEvent(job('user.blocked'), { eraseUser })).resolves.toMatchObject({
      action: 'ignored',
    });
    expect(eraseUser).not.toHaveBeenCalled();
  });

  it('lists the consumed types for the outbox routes', () => {
    expect(PAYMENTS_CONSUMED_EVENTS).toEqual(['user.deleted']);
  });
});
