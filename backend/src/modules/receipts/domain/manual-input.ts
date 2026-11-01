/**
 * Normalisation of the manual submission form (POST /receipts/manual). Pure module.
 */
import { kyivLocalToUtc } from '../../../common/time/kyiv';

const ZONED_PATTERN = /(?:[zZ]|[+-]\d{2}(?::?\d{2})?)$/;
const LOCAL_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?$/;

/**
 * Reads `issuedAt` of a manual receipt. An ISO 8601 string with a zone designator is taken
 * as is; without one it is the Kyiv wall-clock time printed on the receipt. Returns null when
 * the text is not a valid date-time.
 */
export function parseManualIssuedAt(text: string): Date | null {
  const value = text.trim();
  if (ZONED_PATTERN.test(value) && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const match = LOCAL_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map((part) => (part === undefined ? 0 : Number(part)));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    (hour ?? 0) > 23 ||
    (minute ?? 0) > 59 ||
    (second ?? 0) > 59
  ) {
    return null;
  }
  const msText = match[7];
  return kyivLocalToUtc({
    year,
    month,
    day,
    hour: hour ?? 0,
    minute: minute ?? 0,
    second: second ?? 0,
    millisecond: msText === undefined ? 0 : Number(msText.padEnd(3, '0')),
  });
}
