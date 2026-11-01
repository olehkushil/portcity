import { createHmac } from 'node:crypto';
import { safeEqual } from '../../../common/auth/crypto';

/**
 * Stateless HMAC-signed tokens for short admin flows that must not be valid access tokens:
 * the TOTP login challenge (password accepted, second factor pending) and the TOTP setup
 * token (secret shown, first code not yet confirmed). Format: `base64url(json).base64url(hmac)`.
 */
export interface StatelessTokenPayload {
  purpose: string;
  subject: string;
  /** Unix seconds. */
  expiresAt: number;
  data?: Record<string, string>;
}

function sign(encodedPayload: string, secret: string, purpose: string): string {
  return createHmac('sha256', secret)
    .update(`stateless-token:${purpose}:${encodedPayload}`)
    .digest('base64url');
}

export function signStatelessToken(payload: StatelessTokenPayload, secret: string): string {
  if (!secret) {
    throw new Error('signStatelessToken requires a non-empty secret');
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded, secret, payload.purpose)}`;
}

function isPayload(value: unknown): value is StatelessTokenPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record['purpose'] !== 'string' ||
    typeof record['subject'] !== 'string' ||
    typeof record['expiresAt'] !== 'number'
  ) {
    return false;
  }
  if (record['data'] === undefined) {
    return true;
  }
  const data = record['data'];
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    Object.values(data as Record<string, unknown>).every((item) => typeof item === 'string')
  );
}

/** Returns the payload when the signature, purpose and expiry check out; null otherwise. */
export function verifyStatelessToken(
  token: string,
  secret: string,
  expectedPurpose: string,
  now: Date,
): StatelessTokenPayload | null {
  if (typeof token !== 'string') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  const [encoded, signature] = parts as [string, string];
  if (!safeEqual(signature, sign(encoded, secret, expectedPurpose))) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isPayload(parsed) || parsed.purpose !== expectedPurpose) {
    return null;
  }
  if (parsed.expiresAt * 1000 <= now.getTime()) {
    return null;
  }
  return parsed;
}
