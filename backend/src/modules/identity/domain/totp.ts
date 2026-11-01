import { generateSecret, generateSync, generateURI } from 'otplib';
import { safeEqual } from '../../../common/auth/crypto';

/** Authenticator-app defaults (Google Authenticator, Authy, 1Password): SHA-1, 6 digits, 30 s. */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_CODE_PATTERN = /^\d{6}$/;

/** Base32 secret, 20 random bytes (RFC 4226 recommendation). otplib uses audited pure-JS crypto. */
export function generateTotpSecret(): string {
  return generateSecret({ length: 20 });
}

/** Current code for a secret at `nowMs`; used by tests and never exposed over HTTP. */
export function generateTotpCode(secret: string, nowMs: number): string {
  return generateSync({
    secret,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    epoch: Math.floor(nowMs / 1000),
  });
}

/** TOTP time step (counter) of a moment: unix seconds / 30, rounded down. */
export function totpStepAt(nowMs: number): number {
  return Math.floor(Math.floor(nowMs / 1000) / TOTP_PERIOD_SECONDS);
}

/**
 * Time step whose code equals `code` among the steps covering [now - tolerance, now + tolerance]
 * (seconds), or null. Every candidate is compared in constant time; when (improbably) two steps
 * share the code, the later step wins so replay protection stays strict. Malformed codes and
 * library errors (bad secret) count as no match instead of throwing.
 *
 * The step is what replay protection stores (AdminUser.totpLastStep): a code is accepted only
 * when its step is newer than the last accepted one.
 */
export function matchTotpStep(
  secret: string,
  code: string,
  nowMs: number,
  toleranceSeconds: number = TOTP_PERIOD_SECONDS,
): number | null {
  const token = code.trim();
  if (!TOTP_CODE_PATTERN.test(token)) {
    return null;
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  const tolerance = Math.max(0, toleranceSeconds);
  const first = Math.floor((nowSeconds - tolerance) / TOTP_PERIOD_SECONDS);
  const last = Math.floor((nowSeconds + tolerance) / TOTP_PERIOD_SECONDS);
  let matched: number | null = null;
  for (let step = first; step <= last; step += 1) {
    let candidate: string;
    try {
      candidate = generateTotpCode(secret, step * TOTP_PERIOD_SECONDS * 1000);
    } catch {
      return null;
    }
    if (safeEqual(candidate, token)) {
      matched = step;
    }
  }
  return matched;
}

/**
 * Constant-time verification with symmetric clock tolerance (seconds); see matchTotpStep.
 * Malformed codes and library errors (bad secret) count as invalid instead of throwing.
 */
export function verifyTotpCode(
  secret: string,
  code: string,
  nowMs: number,
  toleranceSeconds: number = TOTP_PERIOD_SECONDS,
): boolean {
  return matchTotpStep(secret, code, nowMs, toleranceSeconds) !== null;
}

/** `otpauth://totp/...` URI for the QR code shown during setup. */
export function buildTotpUri(issuer: string, label: string, secret: string): string {
  return generateURI({ issuer, label, secret, digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS });
}
