import {
  type DailyReport,
  type ReportSection,
  assertDayKey,
  previousKyivDay,
  shiftDayKey,
} from '../domain/daily-report';

export const REPORTS_NIGHTLY_JOBS = {
  /** Computes one Kyiv day (default: yesterday) and catches up missing recent days. */
  computeDay: 'compute-day',
} as const;

export const REPORTS_NIGHTLY_SCHEDULE_ID = 'reports-nightly-daily';

/**
 * 00:20 Kyiv: the previous day is closed, and it runs before the club's 03:30 expiry job so
 * the day's ledger numbers are not mixed with the next day's expirations.
 */
export const REPORTS_NIGHTLY_CRON = '20 0 * * *';

/** How many earlier days the scheduled run backfills when their row is missing. */
export const DEFAULT_CATCH_UP_DAYS = 3;
export const MAX_CATCH_UP_DAYS = 31;

export interface ReportsNightlyJobData {
  /** `yyyy-MM-dd` Kyiv day; defaults to yesterday. */
  day?: string;
  /** Earlier days to compute when no report is stored for them (0-31, default 0). */
  catchUpDays?: number;
}

export interface ReportsNightlyDeps {
  now: () => Date;
  hasReport: (day: string) => Promise<boolean>;
  computeAndStore: (day: string) => Promise<DailyReport>;
}

export interface ComputedDaySummary {
  day: string;
  complete: boolean;
  errors: Partial<Record<ReportSection, string>>;
}

export interface ReportsNightlyOutcome {
  job: string;
  computed: ComputedDaySummary[];
  /** Catch-up days that already had a report. */
  skipped: string[];
}

function clampCatchUp(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(Math.trunc(value), 0), MAX_CATCH_UP_DAYS);
}

function summarise(report: DailyReport): ComputedDaySummary {
  return { day: report.day, complete: report.complete, errors: report.errors };
}

/** Plain handler logic (brief section 9: the processor only wires it). */
export async function runReportsNightly(
  name: string,
  data: ReportsNightlyJobData | undefined,
  deps: ReportsNightlyDeps,
): Promise<ReportsNightlyOutcome> {
  if (name !== REPORTS_NIGHTLY_JOBS.computeDay) {
    throw new Error(`Unknown reports-nightly job "${name}"`);
  }
  const target = data?.day ?? previousKyivDay(deps.now());
  assertDayKey(target);

  const computed: ComputedDaySummary[] = [summarise(await deps.computeAndStore(target))];
  const skipped: string[] = [];
  const catchUp = clampCatchUp(data?.catchUpDays);
  for (let offset = 1; offset <= catchUp; offset += 1) {
    const day = shiftDayKey(target, -offset);
    if (await deps.hasReport(day)) {
      skipped.push(day);
      continue;
    }
    computed.push(summarise(await deps.computeAndStore(day)));
  }
  return { job: name, computed, skipped };
}
