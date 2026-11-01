import { QUEUES } from '../../../common/queue/queue.constants';
import { type ClubJobsDeps, runClubJob } from './club-jobs.handler';
import { CLUB_JOBS, CLUB_SCHEDULES } from './job-names';

const NOW = new Date('2026-11-02T01:30:00.000Z');

function fakeDeps(overrides: Partial<ClubJobsDeps> = {}): ClubJobsDeps & {
  calls: string[];
  logs: string[];
  warnings: string[];
} {
  const calls: string[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  return {
    calls,
    logs,
    warnings,
    now: () => NOW,
    releaseDueHolds: async (asOf) => {
      calls.push(`release:${asOf.toISOString()}`);
      return { released: 2, failed: 0 };
    },
    expire: async (asOf) => {
      calls.push(`expire:${asOf.toISOString()}`);
      return { cutoffDayKey: '2026-11-02', buckets: 3, points: 120, accounts: 2, failed: 0 };
    },
    sendExpiryReminders: async (asOf) => {
      calls.push(`remind:${asOf.toISOString()}`);
      return { todayKey: '2026-11-02', sent: 4, skipped: 1, failed: 0, targets: [] };
    },
    checkBalanceDrift: async () => {
      calls.push('drift');
      return { checked: 10, drifted: 0, drifts: [] };
    },
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
    ...overrides,
  };
}

describe('runClubJob', () => {
  it('release-holds releases due holds at the job time', async () => {
    const deps = fakeDeps();
    const result = await runClubJob(CLUB_JOBS.releaseHolds, deps);
    expect(result).toEqual({ job: 'release-holds', release: { released: 2, failed: 0 } });
    expect(deps.calls).toEqual([`release:${NOW.toISOString()}`]);
  });

  it('expire runs the FIFO expiry first, then the reminders', async () => {
    const deps = fakeDeps();
    const result = await runClubJob(CLUB_JOBS.expire, deps);
    expect(result).toMatchObject({
      job: 'expire',
      expiry: { points: 120 },
      reminders: { sent: 4 },
    });
    expect(deps.calls).toEqual([`expire:${NOW.toISOString()}`, `remind:${NOW.toISOString()}`]);
    expect(deps.logs).toHaveLength(2);
  });

  it('drift-check warns only when something drifted', async () => {
    const clean = fakeDeps();
    await runClubJob(CLUB_JOBS.driftCheck, clean);
    expect(clean.warnings).toEqual([]);

    const drifted = fakeDeps({
      checkBalanceDrift: async () => ({ checked: 10, drifted: 1, drifts: [] }),
    });
    await runClubJob(CLUB_JOBS.driftCheck, drifted);
    expect(drifted.warnings).toEqual(['points balance drift check: 10 accounts, 1 drifted']);
  });

  it('rejects unknown job names', async () => {
    await expect(runClubJob('nope', fakeDeps())).rejects.toThrow('Unknown club job "nope"');
  });

  it('propagates failures so BullMQ retries the (idempotent) run', async () => {
    const deps = fakeDeps({
      expire: async () => {
        throw new Error('db down');
      },
    });
    await expect(runClubJob(CLUB_JOBS.expire, deps)).rejects.toThrow('db down');
  });
});

describe('CLUB_SCHEDULES', () => {
  it('matches brief section 9 (cron in Europe/Kyiv)', () => {
    expect(CLUB_SCHEDULES).toEqual([
      {
        id: 'points-release-holds-hourly',
        queue: QUEUES.pointsReleaseHolds,
        jobName: 'release-holds',
        pattern: '5 * * * *',
      },
      {
        id: 'points-expire-daily',
        queue: QUEUES.pointsExpire,
        jobName: 'expire',
        pattern: '30 3 * * *',
      },
      {
        id: 'points-balance-drift-nightly',
        queue: QUEUES.pointsExpire,
        jobName: 'drift-check',
        pattern: '15 4 * * *',
      },
    ]);
  });
});
