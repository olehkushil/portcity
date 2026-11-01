/**
 * Weekly opening hours of a tenant (Tenant.hours, JSON) and "open now" in Kyiv time.
 *
 * Stored shape (also the API shape):
 * {
 *   "mon": ["10:00-22:00"], "tue": ["10:00-14:00", "15:00-22:00"], ..., "sun": [],
 *   "exceptions": [{ "date": "2026-12-31", "ranges": ["10:00-18:00"], "note": "Передноворічний день" },
 *                  { "date": "2027-01-01", "closed": true }]
 * }
 * A missing day means the mall hours apply that day; an empty list means closed. An exception
 * replaces the weekly schedule of its date. Ranges are Kyiv wall-clock `HH:mm-HH:mm`; `24:00`
 * may end a range; a range ending before it starts runs past midnight (22:00-02:00).
 *
 * Pure module: no Nest, no Prisma. Never throws.
 */
import {
  addKyivDays,
  kyivDayKey,
  kyivMinutesOfDay,
  parseHHmm,
  toKyiv,
} from '../../../common/time/kyiv';
import { type HoursRange, formatHoursRange, parseHoursRange } from './mall-hours';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const MAX_RANGES_PER_DAY = 4;
export const MAX_HOURS_EXCEPTIONS = 60;
export const MAX_EXCEPTION_NOTE_LENGTH = 100;
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface TenantHoursException {
  /** Kyiv calendar date `yyyy-MM-dd`. */
  date: string;
  closed?: boolean;
  ranges?: string[];
  note?: string;
}

export type TenantHours = Partial<Record<Weekday, string[]>> & {
  exceptions?: TenantHoursException[];
};

export type TenantHoursParseResult =
  { ok: true; hours: TenantHours } | { ok: false; problem: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCalendarDate(key: string): boolean {
  const match = DATE_KEY_PATTERN.exec(key);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
  );
}

function parseRanges(value: unknown, where: string): string[] | string {
  if (!Array.isArray(value)) {
    return `${where} must be a list of "HH:mm-HH:mm" ranges`;
  }
  if (value.length > MAX_RANGES_PER_DAY) {
    return `${where} has more than ${MAX_RANGES_PER_DAY} ranges`;
  }
  const ranges: string[] = [];
  for (const item of value) {
    const range = typeof item === 'string' ? parseHoursRange(item) : null;
    if (!range) {
      return `${where} contains "${String(item)}", expected "HH:mm-HH:mm"`;
    }
    ranges.push(formatHoursRange(range));
  }
  return ranges;
}

/**
 * Validates and normalises an hours object from the admin API (zero-padded ranges, exceptions
 * sorted by date). Unknown keys, malformed ranges or dates and duplicate dates are refused.
 */
export function parseTenantHours(value: unknown): TenantHoursParseResult {
  if (!isPlainObject(value)) {
    return { ok: false, problem: 'hours must be an object of weekdays' };
  }
  const allowed = new Set<string>([...WEEKDAYS, 'exceptions']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return { ok: false, problem: `unknown keys: ${unknown.join(', ')}` };
  }
  const hours: TenantHours = {};
  for (const day of WEEKDAYS) {
    if (value[day] === undefined) {
      continue;
    }
    const ranges = parseRanges(value[day], day);
    if (typeof ranges === 'string') {
      return { ok: false, problem: ranges };
    }
    hours[day] = ranges;
  }
  if (value.exceptions !== undefined) {
    if (!Array.isArray(value.exceptions)) {
      return { ok: false, problem: 'exceptions must be a list' };
    }
    if (value.exceptions.length > MAX_HOURS_EXCEPTIONS) {
      return { ok: false, problem: `more than ${MAX_HOURS_EXCEPTIONS} exceptions` };
    }
    const seen = new Set<string>();
    const exceptions: TenantHoursException[] = [];
    for (const raw of value.exceptions) {
      if (!isPlainObject(raw) || typeof raw.date !== 'string' || !isCalendarDate(raw.date)) {
        return { ok: false, problem: 'every exception needs a date "yyyy-MM-dd"' };
      }
      if (seen.has(raw.date)) {
        return { ok: false, problem: `duplicate exception date ${raw.date}` };
      }
      seen.add(raw.date);
      const extra = Object.keys(raw).filter(
        (key) => !['date', 'closed', 'ranges', 'note'].includes(key),
      );
      if (extra.length > 0) {
        return { ok: false, problem: `unknown exception keys: ${extra.join(', ')}` };
      }
      if (raw.closed !== undefined && typeof raw.closed !== 'boolean') {
        return { ok: false, problem: `exception ${raw.date}: closed must be true or false` };
      }
      if (
        raw.note !== undefined &&
        (typeof raw.note !== 'string' || raw.note.length > MAX_EXCEPTION_NOTE_LENGTH)
      ) {
        return { ok: false, problem: `exception ${raw.date}: note must be a short text` };
      }
      const exception: TenantHoursException = { date: raw.date };
      if (raw.closed === true) {
        if (Array.isArray(raw.ranges) && raw.ranges.length > 0) {
          return { ok: false, problem: `exception ${raw.date}: closed days take no ranges` };
        }
        exception.closed = true;
      } else {
        const ranges = parseRanges(raw.ranges, `exception ${raw.date}`);
        if (typeof ranges === 'string') {
          return { ok: false, problem: ranges };
        }
        if (ranges.length === 0) {
          return { ok: false, problem: `exception ${raw.date}: give ranges or closed: true` };
        }
        exception.ranges = ranges;
      }
      if (typeof raw.note === 'string' && raw.note.trim() !== '') {
        exception.note = raw.note.trim();
      }
      exceptions.push(exception);
    }
    if (exceptions.length > 0) {
      hours.exceptions = exceptions.sort((a, b) => a.date.localeCompare(b.date));
    }
  }
  return { ok: true, hours };
}

/** Tolerant read of the stored JSON column: anything malformed means "no own hours". */
export function readTenantHours(value: unknown): TenantHours | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = parseTenantHours(value);
  return parsed.ok ? parsed.hours : null;
}

/** Monday-based weekday of the Kyiv calendar day containing `at`. */
export function kyivWeekday(at: Date): Weekday {
  // getDay(): 0 = Sunday ... 6 = Saturday, in Kyiv time.
  const index = (toKyiv(at).getDay() + 6) % 7;
  return WEEKDAYS[index] ?? 'mon';
}

/** Ranges that apply on the Kyiv day of `at`; null when the mall hours apply. */
export function rangesForDay(hours: TenantHours | null, at: Date): HoursRange[] | null {
  if (!hours) {
    return null;
  }
  const key = kyivDayKey(at);
  const exception = hours.exceptions?.find((candidate) => candidate.date === key);
  const texts = exception
    ? exception.closed
      ? []
      : (exception.ranges ?? [])
    : hours[kyivWeekday(at)];
  if (texts === undefined) {
    return null;
  }
  return texts.map(parseHoursRange).filter((range): range is HoursRange => range !== null);
}

function minutesOf(hhmm: string): number {
  const { hours, minutes } = parseHHmm(hhmm);
  return hours * 60 + minutes;
}

/**
 * Open at `at` (Kyiv wall clock): today's ranges (tenant's own or the mall's), plus the part
 * after midnight of yesterday's overnight ranges.
 */
export function isTenantOpenAt(
  hours: TenantHours | null,
  mallHours: HoursRange,
  at: Date,
): boolean {
  const now = kyivMinutesOfDay(at);
  const today = rangesForDay(hours, at) ?? [mallHours];
  for (const range of today) {
    const start = minutesOf(range.from);
    const end = minutesOf(range.to);
    if (start === end) {
      return true;
    }
    if (start < end ? now >= start && now < end : now >= start) {
      return true;
    }
  }
  const yesterday = rangesForDay(hours, addKyivDays(at, -1)) ?? [mallHours];
  for (const range of yesterday) {
    const start = minutesOf(range.from);
    const end = minutesOf(range.to);
    if (start > end && now < end) {
      return true;
    }
  }
  return false;
}
