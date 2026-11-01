import { DEV_JWT_SECRET, cleanEnv, validateEnv } from './env.schema';

/** A production environment that passes every rule; tests break one rule at a time. */
const PRODUCTION = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db:5432/portcity',
  STORAGE_DRIVER: 's3',
  JWT_SECRET: 'Zr8v1yQb6m0kq3XwT9pL2sD7fH4jN5cA',
  OTP_PEPPER: 'n4Kx7Pq2Lw9Rt6Yz1Mb8Vc3Gd5Hf0Jsa',
  VOUCHER_PEPPER: 'Qe5Wr8Ty1Ui4Op7As0Df3Gh6Jk9Lz2Xc',
  MEMBER_QR_SECRET: 'Bv6Nm9Qw2Er5Ty8Ui1Op4As7Df0Gh3Jk',
  PARKING_PROVIDER: 'vendor',
  PAYMENTS_PROVIDER: 'liqpay',
  CORS_ORIGINS: 'https://admin.portcity.com.ua',
} as const;

describe('env schema', () => {
  it('applies defaults for a minimal development environment', () => {
    const config = validateEnv({ NODE_ENV: 'development', PRISMA_LAZY_CONNECT: 'true' });
    expect(config.PORT).toBe(3000);
    expect(config.APP_MODE).toBe('api');
    expect(config.LOG_PRETTY).toBe(true);
    expect(config.DOCS_ENABLED).toBe(true);
    expect(config.CORS_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:5173']);
    expect(config.TRUST_PROXY).toBe(false);
    expect(config.isDevelopment).toBe(true);
    expect(config.isWorker).toBe(false);
  });

  it('coerces numbers and booleans from strings', () => {
    const config = validateEnv({
      NODE_ENV: 'test',
      PORT: '4100',
      TRUST_PROXY: 'yes',
      LOG_PRETTY: '0',
      CORS_ORIGINS: ' https://a.example , https://b.example ,',
    });
    expect(config.PORT).toBe(4100);
    // The former boolean keeps working: true means one proxy hop.
    expect(config.TRUST_PROXY).toBe(1);
    expect(config.LOG_PRETTY).toBe(false);
    expect(config.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });

  it.each([
    ['false', false],
    ['true', 1],
    ['0', false],
    ['2', 2],
    ['10.0.0.0/8, 192.168.1.10', ['10.0.0.0/8', '192.168.1.10']],
    ['loopback,2001:db8::/32', ['loopback', '2001:db8::/32']],
  ])('parses TRUST_PROXY=%s', (raw, expected) => {
    expect(validateEnv({ NODE_ENV: 'test', TRUST_PROXY: raw }).TRUST_PROXY).toEqual(expected);
  });

  it.each(['11', '10.0.0.0/33', 'proxy.example', '2001:db8::/129'])(
    'refuses TRUST_PROXY=%s',
    (raw) => {
      expect(() => validateEnv({ NODE_ENV: 'test', TRUST_PROXY: raw })).toThrow(/TRUST_PROXY/);
    },
  );

  it('treats empty strings as unset', () => {
    expect(cleanEnv({ A: '', B: ' ', C: 'x', D: undefined })).toEqual({ C: 'x' });
    const config = validateEnv({ NODE_ENV: 'test', PORT: '' });
    expect(config.PORT).toBe(3000);
  });

  it('requires DATABASE_URL in development unless Prisma is lazy', () => {
    expect(() => validateEnv({ NODE_ENV: 'development' })).toThrow(/DATABASE_URL/);
    expect(() =>
      validateEnv({ NODE_ENV: 'development', PRISMA_LAZY_CONNECT: 'true' }),
    ).not.toThrow();
  });

  it('accepts a complete production environment', () => {
    expect(validateEnv({ ...PRODUCTION }).isProduction).toBe(true);
  });

  it('rejects development secrets in production', () => {
    expect(() => validateEnv({ ...PRODUCTION, JWT_SECRET: DEV_JWT_SECRET })).toThrow(/JWT_SECRET/);
    const { OTP_PEPPER: _unset, ...withoutPepper } = PRODUCTION;
    // Unset falls back to the dev-only default, which is refused.
    expect(() => validateEnv(withoutPepper)).toThrow(/OTP_PEPPER/);
  });

  it.each([
    ['JWT_SECRET', 'compose-only-jwt-secret-please-change-0123456789'],
    ['OTP_PEPPER', 'compose-only-otp-pepper-0123456789abcdefghijkl'],
    ['VOUCHER_PEPPER', 'short-but-random-Xy7'],
    ['MEMBER_QR_SECRET', 'please-changeme-before-going-live-0123456789'],
    ['S3_SECRET_ACCESS_KEY', 'portcity-secret'],
    ['SEED_ADMIN_PASSWORD', 'ChangeMe-2026!'],
  ])('refuses %s=%s in production', (key, value) => {
    expect(() => validateEnv({ ...PRODUCTION, [key]: value })).toThrow(new RegExp(key));
  });

  it('applies the secret policy to module secrets that the shared schema does not know', () => {
    expect(() =>
      validateEnv({ ...PRODUCTION, PARKING_WEBHOOK_SECRET: 'dev-only-parking-webhook-secret' }),
    ).toThrow(/PARKING_WEBHOOK_SECRET/);
    expect(() =>
      validateEnv({ ...PRODUCTION, PAYMENTS_LIQPAY_PRIVATE_SECRET: 'too-short-secret' }),
    ).toThrow(/PAYMENTS_LIQPAY_PRIVATE_SECRET: must be a random secret of at least 32/);
    expect(() =>
      validateEnv({
        ...PRODUCTION,
        PARKING_WEBHOOK_SECRET: 'Hk2Lm5Np8Qr1St4Uv7Wx0Yz3Ab6Cd9Ef',
      }),
    ).not.toThrow();
    // Outside production the policy does not apply (development defaults are the point there).
    expect(() =>
      validateEnv({ NODE_ENV: 'test', PARKING_WEBHOOK_SECRET: 'dev-only-parking-webhook-secret' }),
    ).not.toThrow();
  });

  it('never echoes secret values in the error message', () => {
    const value = 'compose-only-otp-pepper';
    let message = '';
    try {
      validateEnv({ ...PRODUCTION, OTP_PEPPER: value });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/OTP_PEPPER/);
    expect(message).not.toContain(value);
  });

  it('refuses a wildcard CORS allowlist in production only', () => {
    expect(() => validateEnv({ ...PRODUCTION, CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS/);
    expect(() =>
      validateEnv({ ...PRODUCTION, CORS_ORIGINS: 'https://admin.portcity.com.ua,*' }),
    ).toThrow(/CORS_ORIGINS/);
    expect(validateEnv({ NODE_ENV: 'test', CORS_ORIGINS: '*' }).CORS_ORIGINS).toEqual(['*']);
  });

  it('rejects the demo parking emulator and the mock payment provider in production', () => {
    expect(() => validateEnv({ ...PRODUCTION, PARKING_PROVIDER: 'emulator' })).toThrow(
      /PARKING_PROVIDER/,
    );
    expect(() => validateEnv({ ...PRODUCTION, PAYMENTS_PROVIDER: 'mock' })).toThrow(
      /PAYMENTS_PROVIDER/,
    );
  });

  it('defaults MALL_ADDRESS to the mall itself and narrows adapter names', () => {
    expect(validateEnv({ NODE_ENV: 'test' }).MALL_ADDRESS).toBe('просп. Соборності, 43, Луцьк');
    expect(() => validateEnv({ NODE_ENV: 'test', PUSH_PROVIDER: 'carrier-pigeon' })).toThrow(
      /PUSH_PROVIDER/,
    );
  });

  it('lists every invalid variable in the error message', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'test', PORT: 'abc', LOG_LEVEL: 'loud', BULL_PREFIX: 'bad prefix' }),
    ).toThrow(/PORT[\s\S]*LOG_LEVEL[\s\S]*BULL_PREFIX/);
  });
});
