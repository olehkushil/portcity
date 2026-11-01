import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { DomainError } from '../errors/domain-error';
import { CommonErrors } from '../errors/error-codes';

export const DEFAULT_COUNTRY: CountryCode = 'UA';
export const UA_E164_PATTERN = /^\+380\d{9}$/;

/**
 * Accepts the ways Ukrainians type numbers: `0501234567`, `+380 50 123 45 67`,
 * `380501234567`, `80501234567`, `(050) 123-45-67`. Returns E.164 (`+380501234567`)
 * or `null` when the input is not a valid Ukrainian number.
 */
export function tryNormalizeUaPhone(input: string): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  let text = input.trim().replace(/[\s\-().]/g, '');
  if (text === '') {
    return null;
  }
  if (!text.startsWith('+')) {
    const digits = text.replace(/\D/g, '');
    if (digits !== text) {
      return null;
    }
    if (digits.length === 12 && digits.startsWith('380')) {
      text = `+${digits}`;
    } else if (digits.length === 11 && digits.startsWith('80')) {
      // Legacy intercity prefix "8 050 ..." still typed by some users.
      text = `+38${digits.slice(1)}`;
    } else if (digits.length === 10 && digits.startsWith('0')) {
      text = `+38${digits}`;
    } else if (digits.length === 9) {
      text = `+380${digits}`;
    } else {
      return null;
    }
  }
  const parsed = parsePhoneNumberFromString(text, DEFAULT_COUNTRY);
  if (!parsed || parsed.country !== 'UA' || !parsed.isValid()) {
    return null;
  }
  const e164 = parsed.number;
  return UA_E164_PATTERN.test(e164) ? e164 : null;
}

/** Same as `tryNormalizeUaPhone` but throws `PC_COMMON_PHONE_INVALID`. */
export function normalizeUaPhone(input: string): string {
  const normalized = tryNormalizeUaPhone(input);
  if (!normalized) {
    throw new DomainError(
      CommonErrors.PC_COMMON_PHONE_INVALID,
      'Phone number must be a valid Ukrainian mobile or landline number',
    );
  }
  return normalized;
}

export function isUaPhone(input: string): boolean {
  return tryNormalizeUaPhone(input) !== null;
}

/** `+380501234567` -> `+380 50 *** ** 67` for logs and messages. */
export function maskPhone(e164: string): string {
  if (!UA_E164_PATTERN.test(e164)) {
    return e164.length <= 4
      ? '***'
      : `${e164.slice(0, 4)}${'*'.repeat(e164.length - 6)}${e164.slice(-2)}`;
  }
  return `${e164.slice(0, 4)} ${e164.slice(4, 6)} *** ** ${e164.slice(-2)}`;
}

/** `+380501234567` -> `+380 50 123 45 67` for display in the app. */
export function formatUaPhone(e164: string): string {
  if (!UA_E164_PATTERN.test(e164)) {
    return e164;
  }
  return `${e164.slice(0, 4)} ${e164.slice(4, 6)} ${e164.slice(6, 9)} ${e164.slice(9, 11)} ${e164.slice(11)}`;
}
