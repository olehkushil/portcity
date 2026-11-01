import { parseEnvSection } from '../../common/config/env-section';
import { identityEnvSchema, parseAdminRoles, parseStaticOtpCodes } from './identity.config';

const parse = (raw: Record<string, string>) => parseEnvSection(identityEnvSchema, 'identity', raw);

describe('identity env section', () => {
  it('has the brief defaults', () => {
    expect(parse({})).toMatchObject({
      OTP_TTL_SECONDS: 300,
      OTP_CODE_LENGTH: 6,
      OTP_MAX_ATTEMPTS: 5,
      OTP_PHONE_LIMIT: 3,
      OTP_PHONE_WINDOW_SECONDS: 600,
      OTP_IP_LIMIT: 10,
      OTP_IP_WINDOW_SECONDS: 3600,
      OTP_DEV_ECHO: false,
      OTP_STATIC_CODES: {},
      SMS_PROVIDER: 'log',
      ACCOUNT_DELETION_CRON: '15 4 * * *',
      OTP_RETENTION_DAYS: 7,
      REFRESH_RETENTION_DAYS: 60,
    });
  });

  it('requires a token for TurboSMS and forbids the code echo in production', () => {
    expect(() => parse({ SMS_PROVIDER: 'turbosms' })).toThrow(/TURBOSMS_TOKEN/);
    expect(parse({ SMS_PROVIDER: 'turbosms', TURBOSMS_TOKEN: 't' }).TURBOSMS_SENDER).toBe(
      'PortCity',
    );
    expect(() => parse({ NODE_ENV: 'production', OTP_DEV_ECHO: 'true' })).toThrow(/OTP_DEV_ECHO/);
  });

  it('refuses the log SMS adapter in production', () => {
    expect(() => parse({ NODE_ENV: 'production' })).toThrow(/SMS_PROVIDER/);
    expect(
      parse({ NODE_ENV: 'production', SMS_PROVIDER: 'turbosms', TURBOSMS_TOKEN: 't' }).SMS_PROVIDER,
    ).toBe('turbosms');
  });

  it('has the abuse-protection, admin and profile defaults', () => {
    expect(parse({})).toMatchObject({
      OTP_RESEND_COOLDOWN_SECONDS: 60,
      OTP_PHONE_DAILY_LIMIT: 5,
      OTP_VERIFY_FAILURE_LIMIT: 10,
      OTP_VERIFY_FAILURE_WINDOW_SECONDS: 86_400,
      SMS_DAILY_BUDGET: 5000,
      SMS_BUDGET_ALERT_PERCENT: 80,
      ALLOW_STATIC_OTP: false,
      ADMIN_REQUIRE_TOTP_ROLES: ['owner', 'manager'],
      ADMIN_TOTP_CHALLENGE_MAX_ATTEMPTS: 5,
      ADMIN_LOGIN_LOCK_THRESHOLD: 5,
      ADMIN_PASSWORD_SCRYPT_LOG_N: 17,
      ADMIN_SCRYPT_MAX_CONCURRENT: 4,
      PROFILE_BONUS_PER_FIELD: 10,
      PROFILE_BONUS_COMPLETE: 20,
      ACCOUNT_DELETION_GRACE_DAYS: 30,
      LEGAL_PROGRAM_VERSION: '2026-10',
    });
  });

  it('parses ADMIN_REQUIRE_TOTP_ROLES', () => {
    expect(parseAdminRoles(' Owner, manager ,owner')).toEqual(['owner', 'manager']);
    expect(parseAdminRoles('none')).toEqual([]);
    expect(parse({ ADMIN_REQUIRE_TOTP_ROLES: 'owner,support' }).ADMIN_REQUIRE_TOTP_ROLES).toEqual([
      'owner',
      'support',
    ]);
    expect(() => parse({ ADMIN_REQUIRE_TOTP_ROLES: 'owner,boss' })).toThrow(/boss/);
  });

  it('refuses static OTP codes in production unless allowed, and then only with 8 digits', () => {
    const production = { NODE_ENV: 'production', SMS_PROVIDER: 'turbosms', TURBOSMS_TOKEN: 't' };
    expect(() => parse({ ...production, OTP_STATIC_CODES: '+380501234567:123456' })).toThrow(
      /OTP_STATIC_CODES: demo codes are refused in production unless ALLOW_STATIC_OTP=true/,
    );
    expect(() =>
      parse({ ...production, OTP_STATIC_CODES: '+380501234567:123456', ALLOW_STATIC_OTP: 'true' }),
    ).toThrow(/8 digits/);
    expect(
      parse({ ...production, OTP_STATIC_CODES: '+380501234567:12345678', ALLOW_STATIC_OTP: 'true' })
        .OTP_STATIC_CODES,
    ).toEqual({ '+380501234567': '12345678' });
    // Development keeps working with short demo codes (docker-compose).
    expect(parse({ OTP_STATIC_CODES: '+380501234567:123456' }).OTP_STATIC_CODES).toEqual({
      '+380501234567': '123456',
    });
  });

  it('keeps the admin scrypt cost at 2^17 or more in production and checks the lock bounds', () => {
    const production = { NODE_ENV: 'production', SMS_PROVIDER: 'turbosms', TURBOSMS_TOKEN: 't' };
    expect(() => parse({ ...production, ADMIN_PASSWORD_SCRYPT_LOG_N: '15' })).toThrow(
      /ADMIN_PASSWORD_SCRYPT_LOG_N/,
    );
    expect(parse({ ADMIN_PASSWORD_SCRYPT_LOG_N: '10' }).ADMIN_PASSWORD_SCRYPT_LOG_N).toBe(10);
    expect(() =>
      parse({ ADMIN_LOGIN_LOCK_BASE_SECONDS: '600', ADMIN_LOGIN_LOCK_MAX_SECONDS: '60' }),
    ).toThrow(/ADMIN_LOGIN_LOCK_MAX_SECONDS/);
  });

  it('parses static demo codes', () => {
    expect(parseStaticOtpCodes(' 0501234567:123456 , +380671112233:654321 ')).toEqual({
      '+380501234567': '123456',
      '+380671112233': '654321',
    });
    expect(() => parseStaticOtpCodes('0501234567')).toThrow(/must look like/);
    expect(() => parseStaticOtpCodes('12:123456')).toThrow(/invalid Ukrainian phone/);
    expect(() => parseStaticOtpCodes('0501234567:12')).toThrow(/invalid code/);
  });
});
