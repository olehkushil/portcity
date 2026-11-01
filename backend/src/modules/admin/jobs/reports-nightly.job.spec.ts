import type { DailyReport } from '../domain/daily-report';
import {
  MAX_CATCH_UP_DAYS,
  REPORTS_NIGHTLY_JOBS,
  type ReportsNightlyDeps,
  runReportsNightly,
} from './reports-nightly.job';

function report(day: string, complete = true): DailyReport {
  return {
    day,
    range: { from: '', to: '' },
    receipts: null,
    points: null,
    vouchers: null,
    parking: null,
    adjustments: { requested: 0, approved: 0, applied: 0, rejected: 0, appliedPoints: 0 },
    errors: complete ? {} : { parking: 'PC_COMMON_NOT_IMPLEMENTED' },
    complete,
    dayClosed: true,
    source: 'nightly',
    computedAt: '2026-01-15T00:20:00.000Z',
  };
}

function deps(stored: string[] = []): ReportsNightlyDeps & { computed: string[] } {
  const computed: string[] = [];
  return {
    computed,
    // 00:20 Kyiv on 2026-01-15 (UTC+2 in winter).
    now: () => new Date('2026-01-14T22:20:00.000Z'),
    hasReport: async (day) => stored.includes(day),
    computeAndStore: async (day) => {
      computed.push(day);
      return report(day, day !== '2026-01-12');
    },
  };
}

describe('runReportsNightly', () => {
  it('computes yesterday in Kyiv time by default', async () => {
    const d = deps();
    const outcome = await runReportsNightly(REPORTS_NIGHTLY_JOBS.computeDay, undefined, d);
    expect(d.computed).toEqual(['2026-01-14']);
    expect(outcome).toEqual({
      job: 'compute-day',
      computed: [{ day: '2026-01-14', complete: true, errors: {} }],
      skipped: [],
    });
  });

  it('backfills missing earlier days and skips stored ones', async () => {
    const d = deps(['2026-01-13']);
    const outcome = await runReportsNightly(REPORTS_NIGHTLY_JOBS.computeDay, { catchUpDays: 3 }, d);
    expect(d.computed).toEqual(['2026-01-14', '2026-01-12', '2026-01-11']);
    expect(outcome.skipped).toEqual(['2026-01-13']);
    expect(outcome.computed[1]).toEqual({
      day: '2026-01-12',
      complete: false,
      errors: { parking: 'PC_COMMON_NOT_IMPLEMENTED' },
    });
  });

  it('honours an explicit day', async () => {
    const d = deps();
    await runReportsNightly(REPORTS_NIGHTLY_JOBS.computeDay, { day: '2025-12-31' }, d);
    expect(d.computed).toEqual(['2025-12-31']);
  });

  it.each([
    [-5, 0],
    [Number.NaN, 0],
    [2.7, 2],
    [500, MAX_CATCH_UP_DAYS],
  ])('clamps catchUpDays %p to %p', async (catchUpDays, expected) => {
    const d = deps();
    await runReportsNightly(REPORTS_NIGHTLY_JOBS.computeDay, { catchUpDays }, d);
    expect(d.computed).toHaveLength(1 + expected);
  });

  it('rejects an invalid day and unknown job names', async () => {
    await expect(
      runReportsNightly(REPORTS_NIGHTLY_JOBS.computeDay, { day: '15.01.2026' }, deps()),
    ).rejects.toMatchObject({ code: 'PC_REPORT_DAY_INVALID' });
    await expect(runReportsNightly('other', undefined, deps())).rejects.toThrow(
      'Unknown reports-nightly job "other"',
    );
  });
});
