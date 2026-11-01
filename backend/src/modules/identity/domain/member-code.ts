import { MEMBER_CODE_LENGTH, MEMBER_CODE_PATTERN } from '../../../common/contracts/identity';

/** Uniform random integer in `[0, maxExclusive)`; injected so tests are deterministic. */
export type RandomInt = (maxExclusive: number) => number;

/**
 * Luhn check digit for a string of decimal digits: the digit that, appended to `digits`,
 * makes the whole sequence pass the Luhn test. Used so that a member code typed by hand at a
 * cash desk or kiosk is caught when one digit is wrong or two neighbours are swapped.
 */
export function luhnCheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) {
    throw new Error('luhnCheckDigit expects a non-empty string of decimal digits');
  }
  let sum = 0;
  let double = true;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

/** 9 decimal digits (contract pattern). Lookups accept any well-formed code, including seeded ones. */
export function isWellFormedMemberCode(code: string): boolean {
  return MEMBER_CODE_PATTERN.test(code);
}

/** True when the last digit is the Luhn check digit of the first eight (codes generated here). */
export function hasValidCheckDigit(code: string): boolean {
  if (!isWellFormedMemberCode(code)) {
    return false;
  }
  return luhnCheckDigit(code.slice(0, -1)) === Number(code.charAt(code.length - 1));
}

/**
 * New member code: first digit 1-9 (always nine significant digits), six random digits,
 * one Luhn check digit. Uniqueness is enforced by the database; callers retry on collision.
 */
export function generateMemberCode(randomInt: RandomInt): string {
  let body = String(1 + randomInt(9));
  for (let index = 0; index < MEMBER_CODE_LENGTH - 2; index += 1) {
    body += String(randomInt(10));
  }
  return body + String(luhnCheckDigit(body));
}

/** `734211800` -> `734 211 800` for the card screen. */
export function formatMemberCode(code: string): string {
  if (!isWellFormedMemberCode(code)) {
    return code;
  }
  return `${code.slice(0, 3)} ${code.slice(3, 6)} ${code.slice(6)}`;
}
