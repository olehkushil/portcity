import type { ManualAdjustmentStatus } from '../../../common/contracts/admin';
import type { PointsDailyStats } from '../../../common/contracts/club';
import type { ParkingDailyStats } from '../../../common/contracts/parking';
import type { ReceiptDailyStats } from '../../../common/contracts/receipts';
import type { VoucherDailyStats } from '../../../common/contracts/rewards';
import type { DateRange, IsoDateTime, KyivDay } from '../../../common/contracts/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { addKyivDays, kyivDayKey, kyivLocalToUtc } from '../../../common/time/kyiv';
import { AdminErrors } from './errors';

/**
 * Daily report (brief sections 8 and 9): one row per Kyiv calendar day in `daily_stats`,
 * assembled from the statistics ports of receipts, club, rewards and parking plus the
 * module's own manual adjustments. Pure: no Nest, no Prisma.
 */

export const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Longest `from..to` range `GET /admin/reports/daily/range` serves (one quarter). */
export const MAX_REPORT_RANGE_DAYS = 92;
const MIN_REPORT_YEAR = 2000;
const MAX_REPORT_YEAR = 2100;

export const REPORT_SOURCES = ['nightly', 'manual'] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

export const REPORT_SECTIONS = ['receipts', 'points', 'vouchers', 'parking'] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export interface DayKeyParts {
  year: number;
  /** 1-12 */
  month: number;
  dayOfMonth: number;
}

/** Parses `yyyy-MM-dd`; null for garbage and impossible dates such as 2026-02-30. */
export function parseDayKey(day: string): DayKeyParts | null {
  const match = DAY_KEY_PATTERN.exec(day);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const dayOfMonth = Number(match[3]);
  if (year < MIN_REPORT_YEAR || year > MAX_REPORT_YEAR) {
    return null;
  }
  const probe = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== dayOfMonth
  ) {
    return null;
  }
  return { year, month, dayOfMonth };
}

export function isValidDayKey(day: unknown): day is KyivDay {
  return typeof day === 'string' && parseDayKey(day) !== null;
}

export function assertDayKey(day: unknown, field = 'day'): asserts day is KyivDay {
  if (!isValidDayKey(day)) {
    throw new DomainError(
      AdminErrors.PC_REPORT_DAY_INVALID,
      `${field} must be a calendar day in the format yyyy-MM-dd`,
      { details: { field, value: typeof day === 'string' ? day : String(day) } },
    );
  }
}

/** Half-open UTC interval covering the Kyiv calendar day (DST-safe: 23 or 25 hours on switch days). */
export function kyivDayRange(day: KyivDay): DateRange {
  const parts = parseDayKey(day);
  if (!parts) {
    assertDayKey(day);
    throw new Error('unreachable');
  }
  const from = kyivLocalToUtc({ year: parts.year, month: parts.month, day: parts.dayOfMonth });
  return { from, to: addKyivDays(from, 1) };
}

/** Kyiv calendar day before the one containing `now` (what the nightly job computes). */
export function previousKyivDay(now: Date): KyivDay {
  return kyivDayKey(addKyivDays(now, -1));
}

/** `day` shifted by `days` calendar days in Kyiv time. */
export function shiftDayKey(day: KyivDay, days: number): KyivDay {
  return kyivDayKey(addKyivDays(kyivDayRange(day).from, days));
}

/** Inclusive list of day keys from `from` to `to`; rejects reversed or oversized ranges. */
export function dayKeysBetween(from: KyivDay, to: KyivDay): KyivDay[] {
  assertDayKey(from, 'from');
  assertDayKey(to, 'to');
  if (from > to) {
    throw new DomainError(AdminErrors.PC_REPORT_DAY_INVALID, '"from" must not be after "to"', {
      details: { from, to },
    });
  }
  const days: KyivDay[] = [];
  let current = from;
  while (current <= to) {
    days.push(current);
    if (days.length > MAX_REPORT_RANGE_DAYS) {
      throw new DomainError(
        AdminErrors.PC_REPORT_DAY_INVALID,
        `A report range may cover at most ${MAX_REPORT_RANGE_DAYS} days`,
        { details: { from, to, maxDays: MAX_REPORT_RANGE_DAYS } },
      );
    }
    current = shiftDayKey(current, 1);
  }
  return days;
}

/** Storage form of a day key for the `daily_stats.day` DATE column (UTC midnight). */
export function dayKeyToDate(day: KyivDay): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Inverse of dayKeyToDate for values Prisma returns from a DATE column. */
export function dateToDayKey(date: Date): KyivDay {
  return date.toISOString().slice(0, 10);
}

export interface AdjustmentDailyStats {
  /** Adjustments created during the day. */
  requested: number;
  /** Decisions taken during the day that approved (incl. single-admin approvals). */
  approved: number;
  /** Ledger writes during the day. */
  applied: number;
  rejected: number;
  /** Signed sum of applied amounts. */
  appliedPoints: number;
}

export interface AdjustmentRowForStats {
  status: ManualAdjustmentStatus;
  amount: number;
  createdAt: Date;
  decidedAt: Date | null;
  appliedAt: Date | null;
}

export function emptyAdjustmentStats(): AdjustmentDailyStats {
  return { requested: 0, approved: 0, applied: 0, rejected: 0, appliedPoints: 0 };
}

function inRange(date: Date | null, range: DateRange): boolean {
  return (
    date !== null && date.getTime() >= range.from.getTime() && date.getTime() < range.to.getTime()
  );
}

export function summariseAdjustments(
  rows: readonly AdjustmentRowForStats[],
  range: DateRange,
): AdjustmentDailyStats {
  const stats = emptyAdjustmentStats();
  for (const row of rows) {
    if (inRange(row.createdAt, range)) {
      stats.requested += 1;
    }
    if (inRange(row.decidedAt, range)) {
      if (row.status === 'rejected') {
        stats.rejected += 1;
      } else if (row.status === 'approved' || row.status === 'applied') {
        stats.approved += 1;
      }
    }
    if (row.status === 'applied' && inRange(row.appliedAt, range)) {
      stats.applied += 1;
      stats.appliedPoints += row.amount;
    }
  }
  return stats;
}

export interface DailyReportSections {
  receipts: ReceiptDailyStats | null;
  points: PointsDailyStats | null;
  vouchers: VoucherDailyStats | null;
  parking: ParkingDailyStats | null;
}

/** What is stored in `daily_stats.stats` and returned by GET /admin/reports/daily. */
export interface DailyReport extends DailyReportSections {
  day: KyivDay;
  range: { from: IsoDateTime; to: IsoDateTime };
  adjustments: AdjustmentDailyStats;
  /** Sections whose source failed, keyed by section with the error code; empty when `complete`. */
  errors: Partial<Record<ReportSection, string>>;
  /** True when every section was computed. */
  complete: boolean;
  /** False when the report was computed before the Kyiv day ended (numbers are partial). */
  dayClosed: boolean;
  source: ReportSource;
  computedAt: IsoDateTime;
}

export interface BuildDailyReportInput {
  day: KyivDay;
  range: DateRange;
  sections: DailyReportSections;
  adjustments: AdjustmentDailyStats;
  errors: Partial<Record<ReportSection, string>>;
  source: ReportSource;
  computedAt: Date;
}

export function buildDailyReport(input: BuildDailyReportInput): DailyReport {
  const errors: Partial<Record<ReportSection, string>> = {};
  for (const section of REPORT_SECTIONS) {
    const code = input.errors[section];
    if (code !== undefined) {
      errors[section] = code;
    }
  }
  return {
    day: input.day,
    range: { from: input.range.from.toISOString(), to: input.range.to.toISOString() },
    receipts: input.sections.receipts,
    points: input.sections.points,
    vouchers: input.sections.vouchers,
    parking: input.sections.parking,
    adjustments: input.adjustments,
    errors,
    complete: Object.keys(errors).length === 0,
    dayClosed: input.computedAt.getTime() >= input.range.to.getTime(),
    source: input.source,
    computedAt: input.computedAt.toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural check for JSON read back from `daily_stats.stats`. */
export function isDailyReport(value: unknown): value is DailyReport {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isValidDayKey(value['day']) &&
    isRecord(value['range']) &&
    isRecord(value['adjustments']) &&
    isRecord(value['errors']) &&
    typeof value['complete'] === 'boolean' &&
    typeof value['computedAt'] === 'string' &&
    (REPORT_SOURCES as readonly unknown[]).includes(value['source'])
  );
}
