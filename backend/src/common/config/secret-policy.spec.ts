import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DENY_LIST_ONLY_KEYS,
  MIN_PRODUCTION_SECRET_LENGTH,
  isDeniedSecret,
  isSecretKey,
  productionSecretIssues,
} from './secret-policy';

const ROOT = resolve(__dirname, '../../..');

/** `KEY=value` lines of .env.example. */
function envExampleValues(): Array<[string, string]> {
  return readFileSync(resolve(ROOT, '.env.example'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)] as [string, string];
    });
}

/** `KEY: value` and `KEY: ${KEY:-default}` lines of docker-compose.yml (the defaults are what runs). */
function composeValues(): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const raw of readFileSync(resolve(ROOT, 'docker-compose.yml'), 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+):\s*(.+?)\s*$/.exec(raw);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match as unknown as [string, string, string];
    const unquoted = rawValue.replace(/^"(.*)"$/, '$1');
    const fallback = /^\$\{[A-Z0-9_]+:-(.*)\}$/.exec(unquoted);
    result.push([key, fallback ? (fallback[1] ?? '') : unquoted]);
  }
  return result;
}

const isCredentialKey = (key: string): boolean =>
  isSecretKey(key) ||
  DENY_LIST_ONLY_KEYS.includes(key) ||
  key === 'MINIO_ROOT_PASSWORD' ||
  key === 'POSTGRES_PASSWORD';

describe('production secret policy', () => {
  it('recognises secret variables by name', () => {
    expect(isSecretKey('JWT_SECRET')).toBe(true);
    expect(isSecretKey('OTP_PEPPER')).toBe(true);
    expect(isSecretKey('PARKING_WEBHOOK_SECRET')).toBe(true);
    expect(isSecretKey('S3_SECRET_ACCESS_KEY')).toBe(false);
    expect(isSecretKey('SECRETARY')).toBe(false);
  });

  it.each([
    'dev-only-jwt-secret-change-me-0123456789abcdef',
    'compose-only-jwt-secret-please-change-0123456789',
    'test-only-otp-pepper',
    'ChangeMe-2026!',
    'something-CHANGEME-0123456789012345678901234',
    'my-secret-change-me-later-0123456789012345678',
    'portcity-secret',
    ' Portcity ',
  ])('denies the placeholder %s', (value) => {
    expect(isDeniedSecret(value)).toBe(true);
  });

  it('accepts random values', () => {
    expect(isDeniedSecret('Zr8v1yQb6m0kq3XwT9pL2sD7fH4jN5cA')).toBe(false);
  });

  it('requires the minimum length for secrets but not for deny-list-only credentials', () => {
    const short = 'Zr8v1yQb6m0kq3Xw';
    expect(productionSecretIssues({ JWT_SECRET: short })).toEqual([
      {
        key: 'JWT_SECRET',
        message: `must be a random secret of at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`,
      },
    ]);
    expect(productionSecretIssues({ S3_SECRET_ACCESS_KEY: short })).toEqual([]);
    expect(productionSecretIssues({ PORT: 'changeme' })).toEqual([]);
  });

  it('refuses every secret shipped in .env.example', () => {
    const secrets = envExampleValues().filter(
      ([key, value]) => isCredentialKey(key) && value !== '',
    );
    expect(secrets.map(([key]) => key)).toEqual(
      expect.arrayContaining(['JWT_SECRET', 'OTP_PEPPER', 'PARKING_WEBHOOK_SECRET']),
    );
    const accepted = secrets.filter(([, value]) => !isDeniedSecret(value)).map(([key]) => key);
    expect(accepted).toEqual([]);
  });

  it('refuses every secret shipped in docker-compose.yml', () => {
    const secrets = composeValues().filter(([key, value]) => isCredentialKey(key) && value !== '');
    expect(secrets.map(([key]) => key)).toEqual(
      expect.arrayContaining(['JWT_SECRET', 'OTP_PEPPER', 'S3_SECRET_ACCESS_KEY']),
    );
    const accepted = secrets.filter(([, value]) => !isDeniedSecret(value)).map(([key]) => key);
    expect(accepted).toEqual([]);
  });
});
