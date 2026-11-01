import { DomainError } from '../../../common/errors/domain-error';
import {
  ADMIN_OUTBOX_ROUTES,
  type AdminEventsDeps,
  ERASED_SUPPORT_MESSAGE_UK,
  handleAdminEventJob,
} from './admin-events.handler';

function deps(keys: string[], failing: Record<string, unknown> = {}) {
  const deleted: string[] = [];
  const erase = jest.fn(async () => 3);
  const value: AdminEventsDeps = {
    listSupportPhotoKeys: jest.fn(async () => [...keys]),
    deletePhoto: jest.fn(async (key: string) => {
      if (key in failing) {
        throw failing[key];
      }
      deleted.push(key);
    }),
    eraseSupportRequests: erase,
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

describe('handleAdminEventJob', () => {
  it('routes user.deleted to the admin-events queue', () => {
    expect(ADMIN_OUTBOX_ROUTES).toEqual({ 'user.deleted': 'admin-events' });
  });

  it('deletes the support photos, then replaces texts and clears the keys', async () => {
    const { value, deleted, erase } = deps(['support/user-1/a.jpg', 'support/user-1/b.png']);
    const outcome = await handleAdminEventJob(
      'user.deleted',
      event({ userId: 'user-1', requestId: 'r-1', deletedAt: '2026-11-01T10:00:00.000Z' }),
      value,
    );
    expect(deleted).toEqual(['support/user-1/a.jpg', 'support/user-1/b.png']);
    expect(erase).toHaveBeenCalledWith('user-1', ERASED_SUPPORT_MESSAGE_UK);
    expect(outcome).toEqual({
      type: 'user.deleted',
      action: 'erased',
      photosDeleted: 2,
      requestsUpdated: 3,
    });
  });

  it('treats an already missing object as deleted', async () => {
    const missing = new DomainError('PC_STORAGE_OBJECT_NOT_FOUND', 'gone', { status: 404 });
    const { value, erase } = deps(['k1', 'k2'], { k1: missing });
    const outcome = await handleAdminEventJob('user.deleted', { userId: 'user-1' }, value);
    expect(outcome.photosDeleted).toBe(1);
    expect(erase).toHaveBeenCalledTimes(1);
  });

  it('fails (and is retried) before touching the table when storage is down', async () => {
    const { value, erase } = deps(['k1'], { k1: new Error('S3 unavailable') });
    await expect(handleAdminEventJob('user.deleted', { userId: 'user-1' }, value)).rejects.toThrow(
      'S3 unavailable',
    );
    expect(erase).not.toHaveBeenCalled();
  });

  it('ignores other jobs and payloads without a user id', async () => {
    const { value, erase } = deps([]);
    expect((await handleAdminEventJob('voucher.redeemed', {}, value)).action).toBe('ignored');
    expect((await handleAdminEventJob('user.deleted', event({}), value)).action).toBe('ignored');
    expect(erase).not.toHaveBeenCalled();
  });

  it('keeps the placeholder inside the support_requests message CHECK (1-2000 chars)', () => {
    expect(ERASED_SUPPORT_MESSAGE_UK.length).toBeGreaterThan(0);
    expect(ERASED_SUPPORT_MESSAGE_UK.length).toBeLessThanOrEqual(2000);
  });
});
