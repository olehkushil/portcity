import { DomainError } from '../errors/domain-error';
import { CommonErrors } from '../errors/error-codes';

/**
 * Money is always an integer number of kopecks (1 UAH = 100 kopecks).
 * Points are plain integers. Float arithmetic is never used for business values.
 */
export type Kopecks = number;

export const KOPECKS_PER_UAH = 100;
export const UAH_SYMBOL = '₴';

export function isKopecks(value: unknown): value is Kopecks {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertKopecks(value: unknown, field = 'amount'): asserts value is Kopecks {
  if (!isKopecks(value)) {
    throw new DomainError(
      CommonErrors.PC_COMMON_MONEY_INVALID,
      `${field} must be an integer amount in kopecks`,
      { details: { field, value: typeof value === 'number' ? value : String(value) } },
    );
  }
}

function invalidAmount(input: unknown): DomainError {
  return new DomainError(CommonErrors.PC_COMMON_MONEY_INVALID, 'Cannot parse money amount', {
    details: { input: String(input) },
  });
}

/**
 * Parses a human/QR amount in hryvnias into kopecks.
 * Accepts `.` or `,` as the decimal separator, thousands separators (space, NBSP, apostrophe,
 * or the "other" punctuation mark), an optional sign and an optional currency suffix.
 * A single separator is treated as the decimal separator (`1.234` is 1 UAH 23.4 kop).
 * Extra fractional digits are rounded half up to one kopeck (`12.345` -> 1235).
 */
export function uahToKopecks(input: string | number): Kopecks {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw invalidAmount(input);
    }
    return uahToKopecks(input.toFixed(6));
  }

  let text = input
    .trim()
    .replace(/(?:грн\.?|uah|₴)$/i, '')
    .replace(/[\s']/g, '');
  if (text === '') {
    throw invalidAmount(input);
  }

  const commaCount = (text.match(/,/g) ?? []).length;
  const dotCount = (text.match(/\./g) ?? []).length;
  let decimalSeparator: ',' | '.' | null = null;
  if (commaCount > 0 && dotCount > 0) {
    decimalSeparator = text.lastIndexOf(',') > text.lastIndexOf('.') ? ',' : '.';
  } else if (commaCount === 1) {
    decimalSeparator = ',';
  } else if (dotCount === 1) {
    decimalSeparator = '.';
  }

  if (decimalSeparator) {
    const index = text.lastIndexOf(decimalSeparator);
    const integerPart = text.slice(0, index).replace(/[.,]/g, '');
    const fractionPart = text.slice(index + 1);
    text = `${integerPart}.${fractionPart}`;
  } else {
    text = text.replace(/[.,]/g, '');
  }

  const match = /^([-+]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw invalidAmount(input);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const integerDigits = match[2] ?? '0';
  const fractionDigits = match[3] ?? '';

  const cents = Number(`${fractionDigits}00`.slice(0, 2));
  const firstDroppedDigit = fractionDigits.length > 2 ? Number(fractionDigits[2]) : 0;
  let kopecks = Number(integerDigits) * KOPECKS_PER_UAH + cents;
  if (firstDroppedDigit >= 5) {
    kopecks += 1;
  }
  if (!Number.isSafeInteger(kopecks)) {
    throw invalidAmount(input);
  }
  return sign * kopecks || 0;
}

/** Float value in hryvnias, for display/analytics only. Never store the result. */
export function kopecksToUah(kopecks: Kopecks): number {
  assertKopecks(kopecks);
  return kopecks / KOPECKS_PER_UAH;
}

export interface FormatUahOptions {
  /** `symbol` -> "1 234,56 ₴", `word` -> "1 234,56 грн", `none` -> "1 234,56". */
  unit?: 'symbol' | 'word' | 'none';
  /** `always` keeps ",00"; `auto` drops a zero fraction. */
  fraction?: 'always' | 'auto';
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Formats kopecks the Ukrainian way: space thousands separator, comma decimal. */
export function formatUah(kopecks: Kopecks, options: FormatUahOptions = {}): string {
  assertKopecks(kopecks);
  const unit = options.unit ?? 'symbol';
  const fraction = options.fraction ?? 'always';
  const negative = kopecks < 0;
  const abs = Math.abs(kopecks);
  const whole = Math.floor(abs / KOPECKS_PER_UAH);
  const cents = abs % KOPECKS_PER_UAH;

  let text = groupThousands(String(whole));
  if (fraction === 'always' || cents !== 0) {
    text += `,${String(cents).padStart(2, '0')}`;
  }
  if (unit === 'symbol') {
    text += ` ${UAH_SYMBOL}`;
  } else if (unit === 'word') {
    text += ' грн';
  }
  return negative ? `-${text}` : text;
}

export type Rounding = 'floor' | 'round' | 'ceil';

/** Applies a percentage to an amount, returning integer kopecks. Percent may be fractional. */
export function applyPercent(
  kopecks: Kopecks,
  percent: number,
  rounding: Rounding = 'round',
): Kopecks {
  assertKopecks(kopecks);
  if (!Number.isFinite(percent)) {
    throw invalidAmount(percent);
  }
  const basisPoints = Math.round(percent * 100);
  const exact = (kopecks * basisPoints) / 10_000;
  return Math[rounding](exact);
}

/**
 * Loyalty points for a receipt: floor(total in UAH * rate%) with integer-safe arithmetic.
 * `pointsFromKopecks(12345, 3)` -> 3 (123.45 UAH at 3% = 3.70 points).
 */
export function pointsFromKopecks(totalKopecks: Kopecks, ratePercent: number): number {
  assertKopecks(totalKopecks, 'totalKopecks');
  if (totalKopecks < 0 || !Number.isFinite(ratePercent) || ratePercent < 0) {
    throw new DomainError(
      CommonErrors.PC_COMMON_MONEY_INVALID,
      'Points can only be computed for non-negative amounts and rates',
    );
  }
  const basisPoints = Math.round(ratePercent * 100);
  return Math.floor((totalKopecks * basisPoints) / 1_000_000);
}

export function sumKopecks(values: readonly Kopecks[]): Kopecks {
  let total = 0;
  for (const value of values) {
    assertKopecks(value);
    total += value;
  }
  return total;
}

/**
 * Ukrainian plural form: `pluralizeUk(5, ['бал', 'бали', 'балів'])` -> "балів".
 * Forms are [one, few, many].
 */
export function pluralizeUk(count: number, forms: readonly [string, string, string]): string {
  const abs = Math.abs(Math.trunc(count));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return forms[0];
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return forms[1];
  }
  return forms[2];
}

/** "1 250 балів" for notifications and messages. */
export function formatPoints(points: number): string {
  if (!Number.isSafeInteger(points)) {
    throw invalidAmount(points);
  }
  const abs = Math.abs(points);
  const text = `${groupThousands(String(abs))} ${pluralizeUk(abs, ['бал', 'бали', 'балів'])}`;
  return points < 0 ? `-${text}` : text;
}
