import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
/**
 * Node `crypto` only, no native addons (brief section 1):
 * - scrypt for admin passwords and validator PINs,
 * - HMAC-SHA256 with a server pepper for OTP codes, voucher codes, member QR payloads,
 * - SHA-256 for refresh tokens and validator device keys.
 */

export interface ScryptParams {
  /** CPU/memory cost; must be a power of two (stored as ln = log2 N). */
  N: number;
  r: number;
  p: number;
  keyLength: number;
  saltLength: number;
}

/**
 * Baseline parameters (N = 2^15, 32 MiB per hash): validator PINs (verified when a shift is
 * opened, POST /validator/shift) and anything that does not pass explicit parameters.
 */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = {
  N: 32_768,
  r: 8,
  p: 1,
  keyLength: 64,
  saltLength: 16,
};

/**
 * Back-office passwords: N = 2^17 (128 MiB, roughly 0.3-0.6 s per hash on a server core). New and
 * changed admin passwords use these; weaker stored hashes are upgraded on the next successful
 * login (`needsRehash`). Verification is memory-heavy, so callers on unauthenticated paths gate it
 * with a ConcurrencyLimiter (see AdminAuthService).
 */
export const PASSWORD_SCRYPT_PARAMS: ScryptParams = {
  ...DEFAULT_SCRYPT_PARAMS,
  N: 131_072,
};

/** `PASSWORD_SCRYPT_PARAMS` with another cost (log2 N); tests use a low value for speed. */
export function scryptParamsWithLogN(
  logN: number,
  base: ScryptParams = PASSWORD_SCRYPT_PARAMS,
): ScryptParams {
  return { ...base, N: 2 ** logN };
}

/** Alphabet without 0/O/1/I/l used for voucher activation codes (brief section 7). */
export const UNAMBIGUOUS_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Separator that makes `hmac(a, bc)` differ from `hmac(ab, c)`. */
const PART_SEPARATOR = '\u001f';

const MAX_LN = 31;

function deriveScrypt(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      params.keyLength,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

/**
 * Hashes a password with scrypt and returns a PHC string
 * `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt base64>$<hash base64>`.
 * This is the format `prisma/seed.ts` writes for admin passwords and validator PINs
 * (AdminUser.passwordHash, ValidatorDevice.pinHash), so seeded and application-created
 * rows verify through the same `verifyPassword`.
 */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  const ln = Math.log2(params.N);
  if (!Number.isInteger(ln) || ln < 1 || ln > MAX_LN) {
    throw new Error('scrypt parameter N must be a power of two between 2 and 2^31');
  }
  const salt = randomBytes(params.saltLength);
  const hash = await deriveScrypt(password, salt, params);
  return `$scrypt$ln=${ln},r=${params.r},p=${params.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export interface ParsedScryptHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function decodeBase64(value: string | undefined): Buffer | undefined {
  if (value === undefined || value.length === 0 || !/^[A-Za-z0-9+/_=-]+$/.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.length > 0 ? decoded : undefined;
}

/**
 * Parses a stored scrypt hash. Accepts the canonical PHC layout
 * `$scrypt$ln=14,r=8,p=1$<salt>$<hash>` (parameters in any order, salt and hash in standard
 * or URL-safe base64, padded or not) and the legacy layout `scrypt$N$r$p$<salt>$<hash>` that
 * early foundation builds produced. Returns null for anything else.
 */
export function parseScryptHash(stored: string): ParsedScryptHash | null {
  if (typeof stored !== 'string') {
    return null;
  }
  const parts = stored.split('$');

  if (parts.length === 5 && parts[0] === '' && parts[1] === 'scrypt') {
    const params = new Map<string, string>();
    for (const pair of (parts[2] ?? '').split(',')) {
      const [name, value] = pair.split('=');
      if (name && value !== undefined) {
        params.set(name, value);
      }
    }
    const ln = positiveInt(params.get('ln'));
    const r = positiveInt(params.get('r'));
    const p = positiveInt(params.get('p'));
    const salt = decodeBase64(parts[3]);
    const hash = decodeBase64(parts[4]);
    if (ln === undefined || ln > MAX_LN || r === undefined || p === undefined || !salt || !hash) {
      return null;
    }
    return { N: 2 ** ln, r, p, salt, hash };
  }

  if (parts.length === 6 && parts[0] === 'scrypt') {
    const N = positiveInt(parts[1]);
    const r = positiveInt(parts[2]);
    const p = positiveInt(parts[3]);
    const salt = decodeBase64(parts[4]);
    const hash = decodeBase64(parts[5]);
    if (N === undefined || r === undefined || p === undefined || !salt || !hash) {
      return null;
    }
    return { N, r, p, salt, hash };
  }

  return null;
}

/**
 * True when a stored hash is weaker than `target` (lower N, r or p, shorter key or salt, legacy
 * layout) and should be replaced after the password has been verified. Malformed values report
 * true as well; they never verify, so the caller never reaches the rehash for them.
 */
export function needsRehash(
  stored: string,
  target: ScryptParams = PASSWORD_SCRYPT_PARAMS,
): boolean {
  const parsed = parseScryptHash(stored);
  if (!parsed || !stored.startsWith('$scrypt$')) {
    return true;
  }
  return (
    parsed.N < target.N ||
    parsed.r < target.r ||
    parsed.p < target.p ||
    parsed.hash.length < target.keyLength ||
    parsed.salt.length < target.saltLength
  );
}

/** Constant-time verification; returns false for malformed stored values instead of throwing. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof stored !== 'string') {
    return false;
  }
  const parsed = parseScryptHash(stored);
  if (!parsed) {
    return false;
  }
  try {
    const actual = await deriveScrypt(password, parsed.salt, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      keyLength: parsed.hash.length,
      saltLength: parsed.salt.length,
    });
    return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash);
  } catch {
    return false;
  }
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256Base64Url(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('base64url');
}

/** HMAC-SHA256 over the parts (joined with an unambiguous separator), base64url encoded. */
export function hmacSha256(secret: string, ...parts: string[]): string {
  return createHmac('sha256', secret).update(parts.join(PART_SEPARATOR)).digest('base64url');
}

export function hmacSha256Hex(secret: string, ...parts: string[]): string {
  return createHmac('sha256', secret).update(parts.join(PART_SEPARATOR)).digest('hex');
}

/** Constant-time string comparison that does not leak the length through early exit timing. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/** Opaque random token (refresh tokens, validator keys). 32 bytes -> 43 base64url chars. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Uniformly random decimal digits (OTP codes). */
export function randomDigits(length = 6): string {
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += String(randomInt(0, 10));
  }
  return result;
}

/** Uniformly random code from an alphabet (voucher activation codes). */
export function randomCode(length: number, alphabet: string = UNAMBIGUOUS_ALPHABET): string {
  if (length <= 0 || alphabet.length < 2) {
    throw new Error('randomCode requires a positive length and an alphabet of at least 2 symbols');
  }
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += alphabet[randomInt(0, alphabet.length)];
  }
  return result;
}
