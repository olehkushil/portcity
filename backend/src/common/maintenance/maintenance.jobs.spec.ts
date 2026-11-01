import { MAINTENANCE_JOBS, runMaintenanceJob } from './maintenance.jobs';

describe('maintenance jobs', () => {
  const now = new Date('2026-01-15T10:00:00Z');
  const deps = {
    now: () => now,
    purgeExpiredIdempotencyKeys: jest.fn().mockResolvedValue(4),
    purgePublishedOutboxEvents: jest.fn().mockResolvedValue(12),
  };

  it('purges expired idempotency keys as of now', async () => {
    await expect(runMaintenanceJob(MAINTENANCE_JOBS.idempotencyPurge, deps)).resolves.toEqual({
      job: 'idempotency-purge',
      removed: 4,
    });
    expect(deps.purgeExpiredIdempotencyKeys).toHaveBeenCalledWith(now);
  });

  it('purges outbox events older than the retention window', async () => {
    await expect(runMaintenanceJob(MAINTENANCE_JOBS.outboxPurge, deps)).resolves.toEqual({
      job: 'outbox-purge',
      removed: 12,
    });
    expect(deps.purgePublishedOutboxEvents).toHaveBeenCalledWith(new Date('2026-01-08T10:00:00Z'));
  });

  it('rejects unknown jobs', async () => {
    await expect(runMaintenanceJob('mystery', deps)).rejects.toThrow(/Unknown maintenance job/);
  });
});
