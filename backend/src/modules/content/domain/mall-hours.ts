import { isWithinKyivWindow, parseHHmm } from '../../../common/time/kyiv';

/** `HH:mm-HH:mm` as written in MALL_HOURS and the parking tariff (`24:00` allowed as the end). */
export const HOURS_RANGE_PATTERN = /^\s*(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})\s*$/;

export interface HoursRange {
  /** `HH:mm`, zero-padded. */
  from: string;
  to: string;
}

function pad(parts: { hours: number; minutes: number }): string {
  return `${String(parts.hours).padStart(2, '0')}:${String(parts.minutes).padStart(2, '0')}`;
}

/** Parses "10:00-22:00" (also en/em dash and spaces); null when malformed. Never throws. */
export function parseHoursRange(value: string | undefined | null): HoursRange | null {
  if (!value) {
    return null;
  }
  const match = HOURS_RANGE_PATTERN.exec(value);
  if (!match || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  try {
    return { from: pad(parseHHmm(match[1])), to: pad(parseHHmm(match[2])) };
  } catch {
    return null;
  }
}

export function isValidHoursRange(value: string): boolean {
  return parseHoursRange(value) !== null;
}

/** True when the Kyiv wall-clock time of `at` falls inside the range (overnight ranges supported). */
export function isOpenAt(range: HoursRange, at: Date): boolean {
  return isWithinKyivWindow(at, range.from, range.to);
}

export function formatHoursRange(range: HoursRange): string {
  return `${range.from}-${range.to}`;
}
