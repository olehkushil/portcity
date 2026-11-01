import { hmacSha256Hex, randomCode } from '../../../common/auth/crypto';
import {
  VOUCHER_ACTIVATION_SECONDS,
  VOUCHER_CODE_ALPHABET,
  VOUCHER_CODE_LENGTH,
  VOUCHER_CODE_PATTERN,
} from '../../../common/contracts/rewards';
import {
  type ParsedSignedToken,
  parseExpiringToken,
  signExpiringToken,
  toUnixSeconds,
} from './signed-token';

/**
 * Voucher activation (brief section 7): a 6-character code from the unambiguous alphabet
 * 23456789ABCDEFGHJKLMNPQRSTUVWXYZ, unique among non-final vouchers (partial unique index
 * `vouchers_code_live_key`), and a signed token base64url(voucherId.exp.hmac) valid for
 * 120 seconds. Redeem is atomic at the service level; re-activation is allowed while the
 * voucher's own `expiresAt` is not reached.
 */

export const ACTIVATION_TOKEN_KIND = 'voucher-activation';

export interface ActivationWindow {
  activatedAt: Date;
  activationExpiresAt: Date;
  /** Unix seconds, the `exp` embedded in the token. */
  exp: number;
}

/** The window starts at `now` and lasts `seconds` (default 120), aligned to whole seconds. */
export function computeActivationWindow(
  now: Date,
  seconds: number = VOUCHER_ACTIVATION_SECONDS,
): ActivationWindow {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error('Activation window must be a positive number of seconds');
  }
  const exp = toUnixSeconds(now) + seconds;
  return { activatedAt: now, activationExpiresAt: new Date(exp * 1000), exp };
}

export type CodeGenerator = (length: number, alphabet: string) => string;

/** Random 6-character activation code; `generator` is injectable for deterministic tests. */
export function generateActivationCode(generator: CodeGenerator = randomCode): string {
  const code = generator(VOUCHER_CODE_LENGTH, VOUCHER_CODE_ALPHABET);
  if (!VOUCHER_CODE_PATTERN.test(code)) {
    throw new Error(`Generated activation code "${code}" is outside the allowed alphabet`);
  }
  return code;
}

/**
 * Normalises a code typed by a cashier: trims, upper-cases, drops spaces and dashes.
 * Returns null when the result is not a valid code (wrong length or ambiguous characters).
 */
export function normalizeActivationCode(input: string): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return VOUCHER_CODE_PATTERN.test(code) ? code : null;
}

export function signActivationToken(voucherId: string, exp: number, secret: string): string {
  return signExpiringToken({ kind: ACTIVATION_TOKEN_KIND, subject: voucherId, exp, secret });
}

/** Verifies signature and expiry; `subject` of a successful parse is the voucher id. */
export function parseActivationToken(token: string, secret: string, now: Date): ParsedSignedToken {
  return parseExpiringToken(token, { kind: ACTIVATION_TOKEN_KIND, secret, now });
}

/** Stored in Voucher.tokenHash: HMAC-SHA256 hex of the token under the voucher pepper. */
export function activationTokenHash(token: string, secret: string): string {
  return hmacSha256Hex(secret, ACTIVATION_TOKEN_KIND, token);
}
