import { hmacSha256, safeEqual } from '../../../common/auth/crypto';

/**
 * Short-lived signed tokens of the form base64url(`<subject>.<exp>.<hmac>`), where
 * `hmac = HMAC-SHA256(secret, kind, subject, exp, ...extra)` (base64url) and `exp` is a unix
 * timestamp in seconds. Used for voucher activation tokens (brief section 7) and validator
 * shift tokens. Pure: the caller supplies `now`.
 */

const SUBJECT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface SignedTokenInput {
  kind: string;
  subject: string;
  /** Unix timestamp in seconds. */
  exp: number;
  secret: string;
  /** Extra material bound into the signature (e.g. a fingerprint of the current PIN hash). */
  extra?: readonly string[];
}

export type SignedTokenFailure = 'malformed' | 'bad_signature' | 'expired';

export type ParsedSignedToken =
  | { ok: true; subject: string; exp: number; expiresAt: Date }
  | { ok: false; reason: SignedTokenFailure };

function signature(input: SignedTokenInput): string {
  return hmacSha256(
    input.secret,
    input.kind,
    input.subject,
    String(input.exp),
    ...(input.extra ?? []),
  );
}

export function signExpiringToken(input: SignedTokenInput): string {
  if (!SUBJECT_PATTERN.test(input.subject)) {
    throw new Error('Token subject contains unsupported characters');
  }
  if (!Number.isInteger(input.exp) || input.exp <= 0) {
    throw new Error('Token exp must be a positive unix timestamp in seconds');
  }
  const raw = `${input.subject}.${input.exp}.${signature(input)}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function parseExpiringToken(
  token: string,
  options: { kind: string; secret: string; now: Date; extra?: readonly string[] },
): ParsedSignedToken {
  if (typeof token !== 'string' || token.length === 0 || token.length > 512) {
    return { ok: false, reason: 'malformed' };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    return { ok: false, reason: 'malformed' };
  }
  const raw = Buffer.from(token, 'base64url').toString('utf8');
  const parts = raw.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed' };
  }
  const [subject, expText, mac] = parts as [string, string, string];
  if (!SUBJECT_PATTERN.test(subject) || !/^\d{1,12}$/.test(expText) || mac.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  const exp = Number(expText);
  const expected = signature({
    kind: options.kind,
    subject,
    exp,
    secret: options.secret,
    ...(options.extra ? { extra: options.extra } : {}),
  });
  if (!safeEqual(mac, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (exp * 1000 <= options.now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, subject, exp, expiresAt: new Date(exp * 1000) };
}

/** Unix seconds for `date`, rounded down. */
export function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
