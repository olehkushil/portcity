import { createHash, scryptSync } from 'node:crypto';
import {
  DEFAULT_SCRYPT_PARAMS,
  PASSWORD_SCRYPT_PARAMS,
  UNAMBIGUOUS_ALPHABET,
  hashPassword,
  hmacSha256,
  hmacSha256Hex,
  needsRehash,
  parseScryptHash,
  scryptParamsWithLogN,
  randomCode,
  randomDigits,
  randomToken,
  safeEqual,
  sha256Base64Url,
  sha256Hex,
  verifyPassword,
} from './crypto';

/** Mirror of `scryptPhc()` in prisma/seed.ts: the format seeded admin passwords and PINs use. */
function seedStylePhc(secret: string, saltLabel: string): string {
  const salt = createHash('sha256')
    .update(`portcity-seed-salt:${saltLabel}`)
    .digest()
    .subarray(0, 16);
  const hash = scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1 });
  return `$scrypt$ln=14,r=8,p=1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

describe('crypto helpers', () => {
  const fastParams = { N: 1024, r: 8, p: 1, keyLength: 32, saltLength: 16 };

  it('hashes passwords as PHC scrypt strings and verifies them', async () => {
    const stored = await hashPassword('ChangeMe-2026!', fastParams);
    expect(stored.startsWith('$scrypt$ln=10,r=8,p=1$')).toBe(true);
    expect(stored.split('$')).toHaveLength(5);
    expect(parseScryptHash(stored)).toMatchObject({ N: 1024, r: 8, p: 1 });
    await expect(verifyPassword('ChangeMe-2026!', stored)).resolves.toBe(true);
    await expect(verifyPassword('changeme-2026!', stored)).resolves.toBe(false);
  });

  it('verifies the PHC strings written by prisma/seed.ts', async () => {
    const stored = seedStylePhc('ChangeMe-2026!', 'admin:admin@portcity.local');
    expect(parseScryptHash(stored)).toMatchObject({ N: 16384, r: 8, p: 1 });
    await expect(verifyPassword('ChangeMe-2026!', stored)).resolves.toBe(true);
    await expect(verifyPassword('ChangeMe-2027!', stored)).resolves.toBe(false);

    const pin = seedStylePhc('1234', 'validator:aroma-kava-1');
    await expect(verifyPassword('1234', pin)).resolves.toBe(true);
    await expect(verifyPassword('0000', pin)).resolves.toBe(false);
  });

  it('accepts PHC parameters in any order and URL-safe base64', async () => {
    const salt = Buffer.from('0123456789abcdef');
    const hash = scryptSync('secret'.normalize('NFKC'), salt, 32, { N: 1024, r: 8, p: 1 });
    const stored = `$scrypt$p=1,r=8,ln=10$${salt.toString('base64url')}$${hash.toString('base64url')}`;
    await expect(verifyPassword('secret', stored)).resolves.toBe(true);
  });

  it('still verifies the legacy scrypt$N$r$p$salt$hash layout', async () => {
    const salt = Buffer.from('fedcba9876543210');
    const hash = scryptSync('legacy'.normalize('NFKC'), salt, 32, { N: 1024, r: 8, p: 1 });
    const stored = `scrypt$1024$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
    expect(parseScryptHash(stored)).toMatchObject({ N: 1024, r: 8, p: 1 });
    await expect(verifyPassword('legacy', stored)).resolves.toBe(true);
    await expect(verifyPassword('other', stored)).resolves.toBe(false);
  });

  it('hashes admin passwords with N = 2^17 and fits the scrypt memory limit', async () => {
    expect(PASSWORD_SCRYPT_PARAMS).toMatchObject({ N: 2 ** 17, r: 8, p: 1, keyLength: 64 });
    expect(DEFAULT_SCRYPT_PARAMS.N).toBe(2 ** 15);
    const stored = await hashPassword('Correct-Horse-2026', PASSWORD_SCRYPT_PARAMS);
    expect(stored.startsWith('$scrypt$ln=17,r=8,p=1$')).toBe(true);
    await expect(verifyPassword('Correct-Horse-2026', stored)).resolves.toBe(true);
    expect(needsRehash(stored)).toBe(false);
  });

  it('flags hashes weaker than the target parameters for rehashing', async () => {
    const target = scryptParamsWithLogN(12);
    expect(target).toMatchObject({ N: 4096, keyLength: 64, saltLength: 16 });
    const weak = await hashPassword('secret', { ...target, N: 1024 });
    const current = await hashPassword('secret', target);
    const shortKey = await hashPassword('secret', { ...target, keyLength: 32 });
    expect(needsRehash(weak, target)).toBe(true);
    expect(needsRehash(current, target)).toBe(false);
    expect(needsRehash(shortKey, target)).toBe(true);
    // The seed writes ln=14 with 32-byte keys: upgraded on the first login.
    expect(needsRehash(seedStylePhc('ChangeMe-2026!', 'admin'))).toBe(true);
    // Stronger than the target is fine (no downgrade).
    expect(needsRehash(current, scryptParamsWithLogN(10))).toBe(false);
    expect(needsRehash('scrypt$1024$8$1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA', target)).toBe(true);
    expect(needsRehash('not-a-hash', target)).toBe(true);
  });

  it('produces a different salt every time', async () => {
    const first = await hashPassword('secret', fastParams);
    const second = await hashPassword('secret', fastParams);
    expect(first).not.toBe(second);
  });

  it('rejects malformed stored hashes without throwing', async () => {
    await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$abc$8$1$c2FsdA$aGFzaA')).resolves.toBe(false);
    await expect(verifyPassword('x', '$scrypt$ln=abc,r=8,p=1$c2FsdA$aGFzaA')).resolves.toBe(false);
    await expect(verifyPassword('x', '$scrypt$ln=99,r=8,p=1$c2FsdA$aGFzaA')).resolves.toBe(false);
    await expect(verifyPassword('x', '$scrypt$ln=10,r=8$c2FsdA$aGFzaA')).resolves.toBe(false);
    await expect(verifyPassword('x', 'bcrypt$10$salt$hash$extra$')).resolves.toBe(false);
    expect(parseScryptHash('')).toBeNull();
    await expect(hashPassword('')).rejects.toThrow();
    await expect(hashPassword('x', { ...fastParams, N: 1000 })).rejects.toThrow(/power of two/);
  });

  it('computes deterministic digests', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Base64Url('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
    expect(sha256Base64Url('abc')).toBe(Buffer.from(sha256Hex('abc'), 'hex').toString('base64url'));
    expect(hmacSha256('pepper', '+380501234567', '123456')).toBe(
      hmacSha256('pepper', '+380501234567', '123456'),
    );
    expect(hmacSha256('pepper', 'a', 'bc')).not.toBe(hmacSha256('pepper', 'ab', 'c'));
    expect(hmacSha256('pepper', 'x')).not.toBe(hmacSha256('other', 'x'));
    expect(hmacSha256Hex('pepper', 'x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('compares strings safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('generates random material of the right shape', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomDigits(6)).toMatch(/^\d{6}$/);
    expect(randomDigits(4)).toMatch(/^\d{4}$/);
    const code = randomCode(6);
    expect(code).toHaveLength(6);
    for (const char of code) {
      expect(UNAMBIGUOUS_ALPHABET.includes(char)).toBe(true);
    }
    expect(randomCode(8, 'ab')).toMatch(/^[ab]{8}$/);
    expect(() => randomCode(0)).toThrow();
  });
});
