import { plateDigits } from './plate';

/** Accepted shape of a talon or paymat code typed by the member (provider-specific formats fit). */
export const VERIFICATION_CODE_PATTERN = /^[A-Za-z0-9-]{4,32}$/;

/**
 * Emulator verification rule (there is no real operator API yet): a talon or paymat code
 * matches a plate when its digits end with the plate's digit run and it has at least four
 * digits. `771234` and `1234` match `AC1234BC`; `1235` does not.
 */
export function codeMatchesPlate(code: string, plate: string): boolean {
  const digits = plateDigits(plate);
  if (!digits || digits.length < 2) {
    return false;
  }
  const codeDigits = code.replace(/\D/g, '');
  return codeDigits.length >= 4 && codeDigits.endsWith(digits);
}
