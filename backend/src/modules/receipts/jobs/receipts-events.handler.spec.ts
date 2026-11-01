import { DomainError } from '../../../common/errors/domain-error';
import {
  ERASED_APPEAL_MESSAGE_UK,
  RECEIPTS_OUTBOX_ROUTES,
  type ReceiptsEventsDeps,
  handleReceiptsEventJob,
} from './receipts-events.handler';

function deps(keys: string[], failing: Record<string, unknown> = {}) {
  const deleted: string[] = [];
  const erase = jest.fn(async () => ({ receipts: 2, appeals: 1 }));
  const value: ReceiptsEventsDeps = {
    listPhotoKeys: jest.fn(async () => [...keys]),
    deletePhoto: jest.fn(async (key: string) => {
      if (key in failing) {
        throw failing[key];
      }
      deleted.push(key);
    }),
    erase,
  };
  return { value, deleted, erase };
}

const event = (payload: unknown) => ({
  eventId: 'e-1',
  type: 'user.deleted',
  aggregateType: 'user',
  aggregateId: 'user-1',
  payload,
  occurredAt: '2026-11-01T10:00:00.000Z',
});

describe('handleReceiptsEventJob', () => {
  it('routes user.deleted to the receipts-events queue', () => {
    expect(RECEIPTS_OUTBOX_ROUTES).toEqual({ 'user.deleted': 'receipts-events' });
  });

  it('deletes the photos, then clears keys and appeal texts', async () => {
    const { value, deleted, erase } = deps(['receipts/user-1/a.jpg', 'receipts/user-1/b.jpg']);
    const outcome = await handleReceiptsEventJob(
      'user.deleted',
      event({ userId: 'user-1', requestId: 'r-1', deletedAt: '2026-11-01T10:00:00.000Z' }),
      value,
    );
    expect(deleted).toEqual(['receipts/user-1/a.jpg', 'receipts/user-1/b.jpg']);
    expect(erase).toHaveBeenCalledWith('user-1', ERASED_APPEAL_MESSAGE_UK);
    expect(outcome).toEqual({
      type: 'user.deleted',
      action: 'erased',
      photosDeleted: 2,
      receiptsUpdated: 2,
      appealsUpdated: 1,
    });
  });

  it('treats an already missing object as deleted', async () => {
    const missing = new DomainError('PC_STORAGE_OBJECT_NOT_FOUND', 'gone', { status: 404 });
    const { value, erase } = deps(['k1', 'k2'], { k1: missing });
    const outcome = await handleReceiptsEventJob('user.deleted', { userId: 'user-1' }, value);
    expect(outcome.photosDeleted).toBe(1);
    expect(erase).toHaveBeenCalledTimes(1);
  });

  it('fails (for a retry) without touching the rows when storage is down', async () => {
    const { value, erase } = deps(['k1'], { k1: new Error('S3 timeout') });
    await expect(
      handleReceiptsEventJob('user.deleted', { userId: 'user-1' }, value),
    ).rejects.toThrow('S3 timeout');
    expect(erase).not.toHaveBeenCalled();
  });

  it('ignores payloads without a user id and unexpected job names', async () => {
    const { value, erase } = deps(['k1']);
    expect(await handleReceiptsEventJob('user.deleted', event({}), value)).toMatchObject({
      action: 'ignored',
    });
    expect(
      await handleReceiptsEventJob('user.blocked', event({ userId: 'u' }), value),
    ).toMatchObject({ action: 'ignored' });
    expect(erase).not.toHaveBeenCalled();
  });
});
