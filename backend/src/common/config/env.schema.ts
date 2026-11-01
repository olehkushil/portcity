import { z } from 'zod';
import { PAYMENT_PROVIDERS } from '../contracts/payments';
import { productionSecretIssues } from './secret-policy';
import { type TrustProxySetting, parseTrustProxy } from './trust-proxy';

/**
 * Environment schema. Parsed once on boot by AppConfigModule (fail fast).
 * Module-specific variables may be added here or validated separately with
 * `parseEnvSection()` (see env-section.ts) to avoid merge conflicts between modules.
 */

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const APP_MODES = ['api', 'worker'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export const STORAGE_DRIVERS = ['memory', 's3'] as const;
/** `redis` uses BullMQ; `memory` keeps jobs in process (tests, openapi generation, API without Redis). */
export const QUEUE_DRIVERS = ['redis', 'memory'] as const;
/** Demo parking timeline stage reproduced by the emulator and prisma/seed.ts (brief section 11). */
export const PARKING_EMULATOR_SCENARIOS = ['free', 'payable', 'paid', 'closed'] as const;
/** `emulator`: demo operator in process; `vendor`: placeholder of the real operator (answers 503). */
export const PARKING_PROVIDERS = ['emulator', 'vendor'] as const;
/** Payment adapters known to the payments contract. */
export const PAYMENT_PROVIDER_NAMES = PAYMENT_PROVIDERS;
export const PUSH_PROVIDER_NAMES = ['stub', 'fcm'] as const;
/** The mall's address (просп. Соборності, 43). «вул. Сухомлинського, 1» is only an extra parking location. */
export const DEFAULT_MALL_ADDRESS = 'просп. Соборності, 43, Луцьк';

export type NodeEnv = (typeof NODE_ENVS)[number];
export type AppMode = (typeof APP_MODES)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];
export type QueueDriver = (typeof QUEUE_DRIVERS)[number];
export type ParkingEmulatorScenario = (typeof PARKING_EMULATOR_SCENARIOS)[number];

export const DEV_JWT_SECRET = 'dev-only-jwt-secret-change-me-0123456789abcdef';
const DEV_PREFIX = 'dev-only-';

const booleanString = z.stringbool();
const port = z.coerce.number().int().min(1).max(65535);
/** See trust-proxy.ts: false | hop count | list of trusted proxy networks (true = 1 hop). */
const trustProxy = z
  .string()
  .default('false')
  .transform((value, ctx): TrustProxySetting => {
    try {
      return parseTrustProxy(value);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message });
      return z.NEVER;
    }
  });
const csv = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const baseSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  APP_MODE: z.enum(APP_MODES).default('api'),
  PORT: port.default(3000),
  WORKER_PORT: port.default(3001),
  HOST: z.string().min(1).default('0.0.0.0'),
  TRUST_PROXY: trustProxy,
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LOG_PRETTY: booleanString.optional(),
  DOCS_ENABLED: booleanString.optional(),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173').transform(csv),

  DATABASE_URL: z.string().min(1).optional(),
  PRISMA_LAZY_CONNECT: booleanString.default(false),
  PRISMA_LOG_QUERIES: booleanString.default(false),

  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  QUEUE_DRIVER: z.enum(QUEUE_DRIVERS).default('redis'),
  BULL_PREFIX: z
    .string()
    .regex(/^[a-z0-9_-]+$/i, 'BULL_PREFIX may contain only letters, digits, "_" and "-"')
    .default('portcity'),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  OUTBOX_DISPATCH_EVERY_MS: z.coerce.number().int().min(1000).max(60_000).default(5000),

  JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
  JWT_ISSUER: z.string().min(1).default('portcity'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(60),
  OTP_PEPPER: z.string().min(8).default(`${DEV_PREFIX}otp-pepper`),
  VOUCHER_PEPPER: z.string().min(8).default(`${DEV_PREFIX}voucher-pepper`),
  MEMBER_QR_SECRET: z.string().min(8).default(`${DEV_PREFIX}member-qr-secret`),

  THROTTLE_TTL_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  THROTTLE_LIMIT: z.coerce.number().int().min(1).default(60),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),

  STORAGE_DRIVER: z.enum(STORAGE_DRIVERS).default('memory'),
  S3_ENDPOINT: z.string().min(1).optional(),
  S3_REGION: z.string().min(1).default('eu-central-1'),
  S3_BUCKET: z.string().min(1).default('portcity'),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: booleanString.default(true),
  S3_PRESIGN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(600),
  S3_PUBLIC_BASE_URL: z.string().min(1).optional(),

  /** How long AdminGuard trusts a cached "admin is active, role X" answer (0 = ask every time). */
  ADMIN_ACCESS_CACHE_SECONDS: z.coerce.number().int().min(0).max(600).default(30),

  MALL_NAME: z.string().min(1).default('Порт City'),
  MALL_ADDRESS: z.string().min(1).default(DEFAULT_MALL_ADDRESS),
  MALL_HOURS: z.string().min(1).default('10:00-22:00'),
  SUPPORT_PHONE: z.string().min(1).optional(),
  SUPPORT_EMAIL: z.string().min(1).optional(),

  /** Parking operator adapter (the parking section reads the same variable). */
  PARKING_PROVIDER: z.enum(PARKING_PROVIDERS).default('emulator'),
  PARKING_EMULATOR_SCENARIO: z.enum(PARKING_EMULATOR_SCENARIOS).default('payable'),
  /** Payment provider adapter for new payments (the payments section reads the same variable). */
  PAYMENTS_PROVIDER: z.enum(PAYMENT_PROVIDER_NAMES).default('mock'),
  /** Push adapter (the notifications section reads the same variable). */
  PUSH_PROVIDER: z.enum(PUSH_PROVIDER_NAMES).default('stub'),
  SEED_ADMIN_PASSWORD: z.string().min(1).optional(),
});

/** Every variable of the shared schema (documentation checks: .env.example must list them all). */
export const SHARED_ENV_KEYS: readonly string[] = Object.freeze(Object.keys(baseSchema.shape));

export const envSchema = baseSchema
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string): void => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (env.NODE_ENV === 'production') {
      // Parsed values, so schema defaults (dev-only-*) are caught even when the variable is unset.
      const secrets: Record<string, string> = {
        JWT_SECRET: env.JWT_SECRET,
        OTP_PEPPER: env.OTP_PEPPER,
        VOUCHER_PEPPER: env.VOUCHER_PEPPER,
        MEMBER_QR_SECRET: env.MEMBER_QR_SECRET,
        ...(env.S3_SECRET_ACCESS_KEY ? { S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY } : {}),
        ...(env.SEED_ADMIN_PASSWORD ? { SEED_ADMIN_PASSWORD: env.SEED_ADMIN_PASSWORD } : {}),
      };
      for (const problem of productionSecretIssues(secrets)) {
        issue(problem.key, problem.message);
      }
      if (env.CORS_ORIGINS.includes('*')) {
        issue(
          'CORS_ORIGINS',
          'must list the allowed origins explicitly in production ("*" refused)',
        );
      }
      if (!env.DATABASE_URL) {
        issue('DATABASE_URL', 'is required in production');
      }
      if (env.STORAGE_DRIVER === 'memory') {
        issue('STORAGE_DRIVER', 'must be "s3" in production (memory storage loses data)');
      }
      if (env.QUEUE_DRIVER === 'memory') {
        issue('QUEUE_DRIVER', 'must be "redis" in production (memory queues lose jobs)');
      }
      if (env.PARKING_PROVIDER === 'emulator') {
        issue('PARKING_PROVIDER', 'the demo emulator must not serve real members in production');
      }
      if (env.PAYMENTS_PROVIDER === 'mock') {
        issue('PAYMENTS_PROVIDER', 'the mock payment provider must not be used in production');
      }
    }
    if (env.APP_MODE === 'worker' && env.QUEUE_DRIVER === 'memory') {
      issue('QUEUE_DRIVER', 'the worker needs Redis-backed queues (QUEUE_DRIVER=redis)');
    }
    if (!env.DATABASE_URL && !env.PRISMA_LAZY_CONNECT && env.NODE_ENV !== 'test') {
      issue('DATABASE_URL', 'is required unless PRISMA_LAZY_CONNECT=true');
    }
  })
  .transform((env) => ({
    ...env,
    LOG_PRETTY: env.LOG_PRETTY ?? env.NODE_ENV === 'development',
    DOCS_ENABLED: env.DOCS_ENABLED ?? env.NODE_ENV !== 'production',
    isProduction: env.NODE_ENV === 'production',
    isDevelopment: env.NODE_ENV === 'development',
    isTest: env.NODE_ENV === 'test',
    isWorker: env.APP_MODE === 'worker',
  }));

export type AppConfig = z.output<typeof envSchema>;
export type RawEnv = Record<string, string | undefined>;

/** Drops empty strings so `FOO=` in a .env file behaves like an unset variable. */
export function cleanEnv(raw: RawEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.trim() !== '') {
      result[key] = value;
    }
  }
  return result;
}

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

let current: AppConfig | undefined;

/**
 * Secrets of module env sections (`PARKING_WEBHOOK_SECRET`, `PAYMENTS_MOCK_WEBHOOK_SECRET`, any
 * future `*_SECRET` / `*_PEPPER`) are not part of the shared schema, so the production policy is
 * applied to the raw variables here; shared secrets are checked inside the schema.
 */
function moduleSecretIssues(env: Record<string, string>): string[] {
  const shared = new Set(SHARED_ENV_KEYS);
  const moduleEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !shared.has(key)));
  return productionSecretIssues(moduleEnv).map((item) => `  - ${item.key}: ${item.message}`);
}

/** Validates raw environment variables. Throws a readable error when invalid (fail fast). */
export function validateEnv(raw: RawEnv): AppConfig {
  const cleaned = cleanEnv(raw);
  const parsed = envSchema.safeParse(cleaned);
  const extra = cleaned['NODE_ENV'] === 'production' ? moduleSecretIssues(cleaned) : [];
  if (!parsed.success || extra.length > 0) {
    const lines = [parsed.success ? '' : formatZodIssues(parsed.error), ...extra].filter(Boolean);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  current = parsed.data;
  return parsed.data;
}

/** Returns the configuration validated by the last `validateEnv` call (or validates process.env). */
export function getValidatedEnv(): AppConfig {
  return current ?? validateEnv(process.env);
}
