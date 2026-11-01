import { addMonths } from 'date-fns';
import { addKyivDays, kyivDayKey, kyivLocalToUtc, toKyiv } from '../../../common/time/kyiv';

/**
 * Expiry arithmetic. Points expire `pointsTtlMonths` after they became available; the expiry
 * bucket of a credit is the Kyiv calendar day of its `expiresAt`. A bucket for day D is
 * expired by the daily job on the first run after D has ended in Kyiv time.
 */

export const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function computeExpiresAt(availableAt: Date, pointsTtlMonths: number): Date {
  if (!Number.isInteger(pointsTtlMonths) || pointsTtlMonths < 1) {
    throw new RangeError(`pointsTtlMonths must be a positive integer, got ${pointsTtlMonths}`);
  }
  // Month arithmetic in Kyiv wall-clock time, so the result does not depend on the machine TZ.
  return new Date(addMonths(toKyiv(availableAt), pointsTtlMonths).getTime());
}

/** Kyiv calendar day (`yyyy-MM-dd`) that holds the instant; used as the expiry bucket key. */
export function bucketDayKey(expiresAt: Date): string {
  return kyivDayKey(expiresAt);
}

/** `yyyy-MM-dd` -> the UTC-midnight Date that Prisma stores in a `@db.Date` column. */
export function dayKeyToDate(dayKey: string): Date {
  if (!DAY_KEY_PATTERN.test(dayKey)) {
    throw new RangeError(`Invalid day key "${dayKey}", expected yyyy-MM-dd`);
  }
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid day key "${dayKey}"`);
  }
  return date;
}

/** Inverse of `dayKeyToDate` for values read back from a `@db.Date` column. */
export function dateToDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** UTC bounds `[start, end)` of the Kyiv calendar day. */
export function kyivDayBounds(dayKey: string): { start: Date; end: Date } {
  const match = DAY_KEY_PATTERN.test(dayKey) ? dayKey.split('-').map(Number) : null;
  if (!match || match.length !== 3) {
    throw new RangeError(`Invalid day key "${dayKey}", expected yyyy-MM-dd`);
  }
  const [year, month, day] = match as [number, number, number];
  const start = kyivLocalToUtc({ year, month, day });
  return { start, end: addKyivDays(start, 1) };
}

/** Last millisecond of the Kyiv day: an `expiresAt` that lands in that day's bucket. */
export function dayEndInstant(dayKey: string): Date {
  return new Date(kyivDayBounds(dayKey).end.getTime() - 1);
}

/** Day key `days` calendar days after `dayKey` (DST-safe). */
export function addDaysToDayKey(dayKey: string, days: number): string {
  const { start } = kyivDayBounds(dayKey);
  return kyivDayKey(addKyivDays(start, days));
}

/** Whole calendar days from `fromKey` to `toKey` (negative when `toKey` is earlier). */
export function daysBetweenDayKeys(fromKey: string, toKey: string): number {
  const from = dayKeyToDate(fromKey).getTime();
  const to = dayKeyToDate(toKey).getTime();
  return Math.round((to - from) / 86_400_000);
}

/** Days on which reminders fire today: `today + d` for each configured `d`. */
export function reminderTargets(
  todayKey: string,
  reminderDays: readonly number[],
): Array<{ dayKey: string; daysLeft: number }> {
  const unique = [...new Set(reminderDays.filter((d) => Number.isInteger(d) && d >= 0))].sort(
    (a, b) => b - a,
  );
  return unique.map((daysLeft) => ({ dayKey: addDaysToDayKey(todayKey, daysLeft), daysLeft }));
}

/** Buckets strictly before this day key are due for expiry when the job runs at `now`. */
export function expiryCutoffDayKey(now: Date): string {
  return kyivDayKey(now);
}
