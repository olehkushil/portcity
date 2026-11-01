import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JWT implementation on top of Node crypto (no external dependency).
 * Used for short-lived access tokens; refresh tokens are opaque random strings.
 */

export type JwtFailure =
  | 'malformed'
  | 'unsupported_algorithm'
  | 'invalid_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'issuer_mismatch';

export class JwtError extends Error {
  constructor(
    readonly reason: JwtFailure,
    message?: string,
  ) {
    super(message ?? `JWT verification failed: ${reason}`);
    this.name = 'JwtError';
  }
}

export interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [claim: string]: unknown;
}

export interface VerifyJwtOptions {
  now?: Date;
  clockToleranceSeconds?: number;
  issuer?: string;
}

const HEADER = Object.freeze({ alg: 'HS256', typ: 'JWT' });

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new JwtError('malformed');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function signJwtHs256(claims: JwtClaims, secret: string): string {
  if (!secret) {
    throw new Error('JWT secret must not be empty');
  }
  const signingInput = `${encode(HEADER)}.${encode(claims)}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

export function verifyJwtHs256(
  token: string,
  secret: string,
  options: VerifyJwtOptions = {},
): JwtClaims {
  if (typeof token !== 'string') {
    throw new JwtError('malformed');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new JwtError('malformed');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  const header = decodeJson(encodedHeader);
  if (!isRecord(header) || header['alg'] !== 'HS256') {
    throw new JwtError('unsupported_algorithm');
  }

  const expected = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const actual = Buffer.from(encodedSignature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new JwtError('invalid_signature');
  }

  const payload = decodeJson(encodedPayload);
  if (!isRecord(payload)) {
    throw new JwtError('malformed');
  }

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const tolerance = options.clockToleranceSeconds ?? 0;
  if (typeof payload['exp'] === 'number' && nowSeconds >= payload['exp'] + tolerance) {
    throw new JwtError('expired');
  }
  if (typeof payload['nbf'] === 'number' && nowSeconds + tolerance < payload['nbf']) {
    throw new JwtError('not_yet_valid');
  }
  if (options.issuer !== undefined && payload['iss'] !== options.issuer) {
    throw new JwtError('issuer_mismatch');
  }
  return payload;
}

/** Decodes without verifying. Only for logging/debugging, never for authorization. */
export function decodeJwtUnsafe(
  token: string,
): { header: Record<string, unknown>; payload: JwtClaims } | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const header = decodeJson(parts[0] ?? '');
    const payload = decodeJson(parts[1] ?? '');
    if (!isRecord(header) || !isRecord(payload)) {
      return null;
    }
    return { header, payload: payload };
  } catch {
    return null;
  }
}
