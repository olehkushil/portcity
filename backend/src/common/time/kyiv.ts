import { TZDate } from '@date-fns/tz';
import { addDays, endOfDay, format, startOfDay } from 'date-fns';

/** Business time zone of the mall. All persistence is UTC; this is for day boundaries and wall-clock rules. */
export const KYIV_TZ = 'Europe/Kyiv';

export interface LocalDateTimeParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
}

/** Wraps an instant so that getters (`getHours()`, ...) return Kyiv wall-clock values. */
export function toKyiv(date: Date): TZDate {
  return new TZDate(date.getTime(), KYIV_TZ);
}

/** Converts Kyiv wall-clock parts (e.g. from a receipt QR) to a UTC instant. */
export function kyivLocalToUtc(parts: LocalDateTimeParts): Date {
  const local = new TZDate(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
    parts.millisecond ?? 0,
    KYIV_TZ,
  );
  return new Date(local.getTime());
}

/** `yyyy-MM-dd` of the Kyiv calendar day containing the instant. */
export function kyivDayKey(date: Date): string {
  return format(toKyiv(date), 'yyyy-MM-dd');
}

export function startOfKyivDay(date: Date): Date {
  return new Date(startOfDay(toKyiv(date)).getTime());
}

export function endOfKyivDay(date: Date): Date {
  return new Date(endOfDay(toKyiv(date)).getTime());
}

/** Calendar-day arithmetic in Kyiv time (DST-safe: keeps the wall-clock time). */
export function addKyivDays(date: Date, days: number): Date {
  return new Date(addDays(toKyiv(date), days).getTime());
}

/** Minutes since Kyiv midnight (0-1439). */
export function kyivMinutesOfDay(date: Date): number {
  const local = toKyiv(date);
  return local.getHours() * 60 + local.getMinutes();
}

/** Parses `HH:mm` (also accepts `24:00` as end-of-day). */
export function parseHHmm(value: string): { hours: number; minutes: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid time "${value}", expected HH:mm`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes !== 0)) {
    throw new Error(`Invalid time "${value}", expected HH:mm`);
  }
  return { hours, minutes };
}

/** The UTC instant of wall-clock `HH:mm` on the Kyiv day that contains `date`. */
export function kyivTimeAt(date: Date, hhmm: string): Date {
  const { hours, minutes } = parseHHmm(hhmm);
  const local = toKyiv(date);
  return kyivLocalToUtc({
    year: local.getFullYear(),
    month: local.getMonth() + 1,
    day: local.getDate(),
    hour: hours,
    minute: minutes,
  });
}

/**
 * True when the Kyiv wall-clock time of `date` lies in [from, to).
 * Overnight windows (`from` > `to`, e.g. 23:00-05:00) are supported.
 */
export function isWithinKyivWindow(date: Date, from: string, to: string): boolean {
  const start = parseHHmm(from);
  const end = parseHHmm(to);
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;
  const current = kyivMinutesOfDay(date);
  if (startMinutes === endMinutes) {
    return true;
  }
  if (startMinutes < endMinutes) {
    return current >= startMinutes && current < endMinutes;
  }
  return current >= startMinutes || current < endMinutes;
}

/** date-fns pattern formatting in Kyiv time; default `dd.MM.yyyy HH:mm`. */
export function formatKyiv(date: Date, pattern = 'dd.MM.yyyy HH:mm'): string {
  return format(toKyiv(date), pattern);
}

/** Offset of Kyiv time from UTC in minutes at the given instant (120 in winter, 180 in summer). */
export function kyivUtcOffsetMinutes(date: Date): number {
  return -toKyiv(date).getTimezoneOffset();
}
