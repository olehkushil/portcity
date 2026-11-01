import { canonicalFiscalNumber } from '../../../common/contracts/content';
import { DomainError } from '../../../common/errors/domain-error';
import { ContentErrors } from './errors';

export type FiscalNumberParseFailure = 'not_a_string' | 'empty' | 'not_digits' | 'length';

export type FiscalNumberParseResult =
  { ok: true; fn: string } | { ok: false; reason: FiscalNumberParseFailure; input: string };

/**
 * Normalises a cash register fiscal number as typed by an admin or read from a tax QR to the
 * canonical form shared with receipts (`canonicalFiscalNumber`): whitespace and dashes removed
 * (people paste "4000 1000 11"), digits only, leading zeros stripped, then 6-20 digits. The
 * whitelist and the receipts' `(fn, fiscal_id)` key therefore always agree. Never throws.
 */
export function parseFiscalNumber(input: unknown): FiscalNumberParseResult {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'not_a_string', input: String(input) };
  }
  const compact = input.replace(/[\s­‐-―−-]+/g, '');
  if (compact === '') {
    return { ok: false, reason: 'empty', input };
  }
  if (!/^\d+$/.test(compact)) {
    return { ok: false, reason: 'not_digits', input };
  }
  const fn = canonicalFiscalNumber(compact);
  if (fn === null) {
    return { ok: false, reason: 'length', input };
  }
  return { ok: true, fn };
}

/** Returns the normalised number or throws PC_FISCAL_NUMBER_INVALID (400). */
export function normalizeFiscalNumber(input: unknown): string {
  const parsed = parseFiscalNumber(input);
  if (!parsed.ok) {
    throw new DomainError(
      ContentErrors.PC_FISCAL_NUMBER_INVALID,
      'Fiscal number must consist of 6 to 20 digits',
      { details: { reason: parsed.reason } },
    );
  }
  return parsed.fn;
}

/**
 * Digits-only prefix for admin search (leading zeros dropped, as in the stored canonical
 * numbers); null when the query has no significant digits.
 */
export function fiscalNumberSearchPrefix(query: string | undefined): string | null {
  if (!query) {
    return null;
  }
  const digits = query.replace(/\D+/g, '').replace(/^0+/, '');
  return digits.length > 0 ? digits.slice(0, 20) : null;
}
