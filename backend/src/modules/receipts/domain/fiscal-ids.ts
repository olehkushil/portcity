/**
 * Canonical receipt identifiers. The `(fn, fiscal_id)` unique key of `receipts` stores these
 * forms, so the same receipt cannot be registered twice by rewriting its number
 * (`1180000001`, `01180000001`, `001180000001`, `118-000-0001`, lower case letters, spaces).
 *
 * Pure module: no Nest, no Prisma. Never throws.
 */
import { canonicalFiscalNumber } from '../../../common/contracts/content';

/** Canonical receipt number: upper-case Latin letters and digits, 1-64 characters. */
export const CANONICAL_FISCAL_ID_PATTERN = /^[A-Z0-9]{1,64}$/;
/** Longest raw receipt number (with separators) accepted before canonicalisation. */
export const FISCAL_ID_RAW_MAX_LENGTH = 128;
/** What the manual form accepts before canonicalisation: letters, digits, spaces, dashes. */
export const FISCAL_ID_INPUT_PATTERN = /^[A-Za-z0-9\s‐-―−-]{1,128}$/;
/** What the manual form accepts as `fn` before canonicalisation: digits, spaces, dashes. */
export const FN_INPUT_PATTERN = /^[0-9\s‐-―−-]{6,64}$/;

/** Whitespace, ASCII hyphen-minus, soft hyphen and the Unicode dashes. */
const SEPARATORS = /[\s­‐-―−-]+/g;

/**
 * Canonical fiscal number of a receipt (`id` parameter of the tax QR): trimmed, upper case,
 * spaces and dashes removed, leading zeros stripped from purely numeric ids (`0000` -> `0`).
 * Returns null when the result is not 1-64 Latin letters or digits (Cyrillic look-alikes are
 * refused rather than folded, so they cannot mint new variants either).
 */
export function canonicalFiscalId(input: string): string | null {
  if (typeof input !== 'string' || input.length > FISCAL_ID_RAW_MAX_LENGTH) {
    return null;
  }
  const compact = input.trim().toUpperCase().replace(SEPARATORS, '');
  if (!CANONICAL_FISCAL_ID_PATTERN.test(compact)) {
    return null;
  }
  if (/^\d+$/.test(compact)) {
    const stripped = compact.replace(/^0+/, '');
    return stripped === '' ? '0' : stripped;
  }
  return compact;
}

/**
 * Canonical fiscal number of the cash register (`fn`): digits only, leading zeros stripped,
 * 6-20 digits after that. Same function as content's whitelist uses.
 */
export function canonicalFn(input: string): string | null {
  return canonicalFiscalNumber(input);
}

/** Numeric value of a canonical receipt number, or null for alphanumeric ids. */
export function numericFiscalId(canonical: string): bigint | null {
  return /^\d{1,64}$/.test(canonical) ? BigInt(canonical) : null;
}
