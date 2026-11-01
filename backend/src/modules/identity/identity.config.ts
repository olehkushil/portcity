import { z } from 'zod';
import { ADMIN_ROLES, type AdminRole } from '../../common/auth/auth.types';
import { envSectionProvider } from '../../common/config/env-section';
import { tryNormalizeUaPhone } from '../../common/phone/phone';

/** Injection token for the identity-specific environment slice (see README, section "Змінні середовища"). */
export const IDENTITY_CONFIG = Symbol('IDENTITY_CONFIG');

const booleanString = z.stringbool();

/** Production minimum for ADMIN_PASSWORD_SCRYPT_LOG_N (N = 2^17). Lower values exist for tests. */
export const MIN_PRODUCTION_SCRYPT_LOG_N = 17;
/** Static demo codes allowed in production (with ALLOW_STATIC_OTP=true) must have this many digits. */
export const PRODUCTION_STATIC_OTP_LENGTH = 8;

/**
 * `ADMIN_REQUIRE_TOTP_ROLES="owner,manager"`: roles that cannot sign in without a second factor.
 * `none` switches the requirement off (development only by convention).
 */
export function parseAdminRoles(raw: string): AdminRole[] {
  const value = raw.trim().toLowerCase();
  if (value === 'none') {
    return [];
  }
  const roles = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  const unknown = roles.filter((role) => !(ADMIN_ROLES as readonly string[]).includes(role));
  if (unknown.length > 0) {
    throw new Error(
      `unknown admin role(s): ${unknown.join(', ')}; use ${ADMIN_ROLES.join(', ')} or none`,
    );
  }
  return [...new Set(roles)] as AdminRole[];
}

const adminRoleList = z
  .string()
  .default('owner,manager')
  .transform((value, ctx): AdminRole[] => {
    try {
      return parseAdminRoles(value);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message });
      return z.NEVER;
    }
  });

/** Consent text version label, same rule as CONSENT_VERSION_PATTERN in domain/consents.ts. */
const consentVersion = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/, 'must be 1-32 letters, digits, ".", "_" or "-"');

/**
 * `OTP_STATIC_CODES="+380501234567:123456,+380671112233:654321"`: phones that always receive the
 * given code and no SMS (demo account, store review). Phones are normalised to E.164.
 */
export function parseStaticOtpCodes(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') {
      continue;
    }
    const separator = trimmed.lastIndexOf(':');
    if (separator <= 0) {
      throw new Error(`OTP_STATIC_CODES entry "${trimmed}" must look like "+380501234567:123456"`);
    }
    const phone = tryNormalizeUaPhone(trimmed.slice(0, separator));
    const code = trimmed.slice(separator + 1).trim();
    if (!phone) {
      throw new Error(`OTP_STATIC_CODES entry "${trimmed}" has an invalid Ukrainian phone`);
    }
    if (!/^\d{4,8}$/.test(code)) {
      throw new Error(`OTP_STATIC_CODES entry "${trimmed}" has an invalid code (4-8 digits)`);
    }
    result[phone] = code;
  }
  return result;
}

export const identityEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** Lifetime of an SMS code. */
    OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(300),
    OTP_CODE_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
    /** Wrong codes accepted per challenge before it is burnt (brief section 4: maxAttempts 5). */
    OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    /** Brief section 8: 3 requests per phone per 10 minutes. */
    OTP_PHONE_LIMIT: z.coerce.number().int().min(1).max(100).default(3),
    OTP_PHONE_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(600),
    /** Brief section 8: 10 requests per IP per hour. */
    OTP_IP_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
    OTP_IP_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
    /** Minimum pause between two codes for one phone; `resendAvailableAt` in the response. */
    OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(600).default(60),
    /** SMS codes per phone per rolling 24 hours (SMS pumping protection). */
    OTP_PHONE_DAILY_LIMIT: z.coerce.number().int().min(1).max(100).default(5),
    /**
     * Wrong codes per phone over OTP_VERIFY_FAILURE_WINDOW_SECONDS (all challenges together);
     * reaching it locks verification and new codes for the phone until the window passes.
     */
    OTP_VERIFY_FAILURE_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
    OTP_VERIFY_FAILURE_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(600)
      .max(604_800)
      .default(86_400),
    /** Global SMS budget per Kyiv calendar day; requests beyond it get 503. */
    SMS_DAILY_BUDGET: z.coerce.number().int().min(1).max(10_000_000).default(5000),
    /** A warning is logged once a day (per replica) when this share of the budget is used. */
    SMS_BUDGET_ALERT_PERCENT: z.coerce.number().int().min(1).max(100).default(80),
    /**
     * Soft thresholds: from this many codes for the phone in 24 h, or from the IP (network) in the
     * IP window, the request must pass CaptchaVerifierPort (noop adapter until a provider is chosen).
     */
    OTP_CAPTCHA_PHONE_THRESHOLD: z.coerce.number().int().min(0).max(100).default(3),
    OTP_CAPTCHA_IP_THRESHOLD: z.coerce.number().int().min(0).max(1000).default(5),
    /** Returns the generated code in the HTTP response (local development only, rejected in production). */
    OTP_DEV_ECHO: booleanString.default(false),
    OTP_STATIC_CODES: z.string().default('').transform(parseStaticOtpCodes),
    /** Production only accepts OTP_STATIC_CODES with this flag, and then only 8-digit codes. */
    ALLOW_STATIC_OTP: booleanString.default(false),
    /**
     * `log` writes the SMS text to the application log (development only); `turbosms` posts to
     * the TurboSMS HTTP API with Node's built-in fetch (adapter written against the public docs,
     * not yet verified with a live account, see README).
     */
    SMS_PROVIDER: z.enum(['log', 'turbosms']).default('log'),
    TURBOSMS_API_URL: z.url().default('https://api.turbosms.ua/message/send.json'),
    TURBOSMS_TOKEN: z.string().min(1).optional(),
    /** Alpha name registered with TurboSMS (up to 11 Latin characters). */
    TURBOSMS_SENDER: z.string().min(1).max(11).default('PortCity'),
    TURBOSMS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(5000),
    /** Daily account-deletion run (cron in Europe/Kyiv). */
    ACCOUNT_DELETION_CRON: z.string().min(9).default('15 4 * * *'),
    /** Cooling-off period of `DELETE /me` (returned as `executeAfter`). */
    ACCOUNT_DELETION_GRACE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    ACCOUNT_DELETION_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
    /** Housekeeping in the same job: OTP challenges older than this are purged. */
    OTP_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    /** Refresh tokens expired or revoked longer ago than this are purged (>= refresh TTL keeps reuse detection). */
    REFRESH_RETENTION_DAYS: z.coerce.number().int().min(1).max(730).default(60),
    /** Back-office access tokens have no refresh token (schema has no admin sessions), so they live longer. */
    ADMIN_ACCESS_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(28_800),
    /** Validity of the stateless login challenge issued when a TOTP code is required. */
    ADMIN_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(300),
    /** Validity of the TOTP setup token (secret shown, code not yet confirmed). */
    ADMIN_TOTP_SETUP_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
    ADMIN_TOTP_ISSUER: z.string().min(1).max(60).default('PortCity Admin'),
    /** Accepted clock drift for TOTP codes, in seconds (30 = one step either way). */
    ADMIN_TOTP_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(120).default(30),
    /** Roles that must use TOTP; such an admin without TOTP gets PC_ADMIN_TOTP_SETUP_REQUIRED. */
    ADMIN_REQUIRE_TOTP_ROLES: adminRoleList,
    /** Codes accepted against one login challenge before it is dead (it is also single-use). */
    ADMIN_TOTP_CHALLENGE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    /** Failed logins (password or TOTP) per admin before the account is locked. */
    ADMIN_LOGIN_LOCK_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
    /** First lock duration; every further failure doubles it up to the maximum. */
    ADMIN_LOGIN_LOCK_BASE_SECONDS: z.coerce.number().int().min(1).max(86_400).default(300),
    ADMIN_LOGIN_LOCK_MAX_SECONDS: z.coerce.number().int().min(1).max(604_800).default(3600),
    /** A failure older than this restarts the counter at 1. */
    ADMIN_LOGIN_FAILURE_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(2_592_000)
      .default(86_400),
    /** Failed admin logins from one IP (network) within the burst window that trigger a warning log. */
    ADMIN_LOGIN_BURST_THRESHOLD: z.coerce.number().int().min(2).max(10_000).default(20),
    ADMIN_LOGIN_BURST_WINDOW_SECONDS: z.coerce.number().int().min(10).max(86_400).default(600),
    /** scrypt cost of new admin password hashes (log2 N; 17 = 128 MiB). Weaker hashes are upgraded at login. */
    ADMIN_PASSWORD_SCRYPT_LOG_N: z.coerce.number().int().min(10).max(20).default(17),
    /** Concurrent scrypt verifications on the public login endpoints, and how many may wait. */
    ADMIN_SCRYPT_MAX_CONCURRENT: z.coerce.number().int().min(1).max(64).default(4),
    ADMIN_SCRYPT_MAX_QUEUE: z.coerce.number().int().min(0).max(1000).default(16),
    /**
     * Points shown in profileCompletion. The club section reads the same two variables (same
     * defaults and bounds) and awards them on user.profile_field_completed, so display and
     * award cannot drift apart.
     */
    PROFILE_BONUS_PER_FIELD: z.coerce.number().int().min(0).max(1000).default(10),
    PROFILE_BONUS_COMPLETE: z.coerce.number().int().min(0).max(1000).default(20),
    /** GET /legal/documents: current consent texts; otp/verify and /me/consents default to these versions. */
    LEGAL_PROGRAM_VERSION: consentVersion.default('2026-10'),
    LEGAL_PROGRAM_URL: z.url().default('https://portcity.com.ua/loyalty/rules'),
    LEGAL_MARKETING_VERSION: consentVersion.default('2026-10'),
    LEGAL_MARKETING_URL: z.url().default('https://portcity.com.ua/loyalty/marketing-consent'),
    LEGAL_PROFILING_VERSION: consentVersion.default('2026-10'),
    LEGAL_PROFILING_URL: z.url().default('https://portcity.com.ua/loyalty/profiling-consent'),
    LEGAL_PRIVACY_POLICY_URL: z.url().default('https://portcity.com.ua/privacy'),
  })
  .superRefine((env, ctx) => {
    const production = env.NODE_ENV === 'production';
    const staticCodes = Object.entries(env.OTP_STATIC_CODES);
    if (production && staticCodes.length > 0) {
      if (!env.ALLOW_STATIC_OTP) {
        ctx.addIssue({
          code: 'custom',
          path: ['OTP_STATIC_CODES'],
          message: 'demo codes are refused in production unless ALLOW_STATIC_OTP=true',
        });
      } else if (staticCodes.some(([, code]) => code.length !== PRODUCTION_STATIC_OTP_LENGTH)) {
        ctx.addIssue({
          code: 'custom',
          path: ['OTP_STATIC_CODES'],
          message: `codes must have ${PRODUCTION_STATIC_OTP_LENGTH} digits in production`,
        });
      }
    }
    if (production && env.ADMIN_PASSWORD_SCRYPT_LOG_N < MIN_PRODUCTION_SCRYPT_LOG_N) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_PASSWORD_SCRYPT_LOG_N'],
        message: `must be at least ${MIN_PRODUCTION_SCRYPT_LOG_N} in production`,
      });
    }
    if (env.ADMIN_LOGIN_LOCK_MAX_SECONDS < env.ADMIN_LOGIN_LOCK_BASE_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_LOGIN_LOCK_MAX_SECONDS'],
        message: 'must not be lower than ADMIN_LOGIN_LOCK_BASE_SECONDS',
      });
    }
    if (env.NODE_ENV === 'production' && env.OTP_DEV_ECHO) {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_DEV_ECHO'],
        message: 'must be false in production (codes would leak into HTTP responses)',
      });
    }
    if (env.NODE_ENV === 'production' && env.SMS_PROVIDER === 'log') {
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_PROVIDER'],
        message: 'the log adapter only prints codes to the log; configure a gateway in production',
      });
    }
    if (env.SMS_PROVIDER === 'turbosms' && !env.TURBOSMS_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['TURBOSMS_TOKEN'],
        message: 'is required when SMS_PROVIDER=turbosms',
      });
    }
  });

export type IdentityConfig = z.output<typeof identityEnvSchema>;

export const identityConfigProvider = envSectionProvider(
  IDENTITY_CONFIG,
  identityEnvSchema,
  'identity',
);
