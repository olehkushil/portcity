import { z } from 'zod';
import { PARKING_EMULATOR_SCENARIOS, envSectionProvider } from '../../common/config';

/** Injection token for the validated parking environment slice (`ParkingConfig`). */
export const PARKING_CONFIG = Symbol('PARKING_CONFIG');

const booleanString = z.stringbool();
const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

/**
 * Parking-specific environment variables (documented in src/modules/parking/README.md).
 * `PARKING_PROVIDER` and `PARKING_EMULATOR_SCENARIO` are also part of the shared schema;
 * the section narrows the provider to the adapters that exist.
 */
export const parkingEnvSchema = z
  .object({
    /** `emulator`: in-process demo operator; `vendor`: stub of the real operator (answers 503). */
    PARKING_PROVIDER: z.enum(['emulator', 'vendor']).default('emulator'),
    PARKING_EMULATOR_SCENARIO: z.enum(PARKING_EMULATOR_SCENARIOS).default('payable'),
    /** `today`: the demo timeline runs on today's Kyiv wall clock (like the seed); `now`: shifted to start at the scenario's moment. */
    PARKING_EMULATOR_ANCHOR: z.enum(['today', 'now']).default('today'),
    /** Plate of the demo vehicle the emulator reports (seed: AC1234BC). */
    PARKING_EMULATOR_PLATE: z
      .string()
      .regex(/^[A-Z0-9]{3,12}$/)
      .default('AC1234BC'),
    PARKING_VENDOR_BASE_URL: optionalText,
    PARKING_VENDOR_API_KEY: optionalText,
    /** HMAC-SHA256 secret for `POST /webhooks/parking/:provider` (header X-Parking-Signature). */
    PARKING_WEBHOOK_SECRET: z.string().min(8).default('dev-only-parking-webhook-secret'),
    /** Interval of the parking-sync job in the worker. */
    PARKING_SYNC_EVERY_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),
    /** GET /parking/session asks the provider again when the local copy is older than this. */
    PARKING_SESSION_STALE_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
    /** Lookups per hour per member for sessions of unverified plates (brief section 8). */
    PARKING_UNVERIFIED_LOOKUPS_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(10),
    PARKING_MAX_VEHICLES: z.coerce.number().int().min(1).max(20).default(5),
    /** Sessions (info timers and provider sessions not seen by the provider) are closed after this. */
    PARKING_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    /** When the feature flag row `parking.info_mode` is missing, info mode falls back to this. */
    PARKING_INFO_MODE_DEFAULT: booleanString.default(true),
    /** Info-mode timers publish outbox events too (default off: their reminders are local on the device). */
    PARKING_INFO_TIMER_EVENTS: booleanString.default(false),
    /** Reminder before the free period ends (design brief 4.1, F2). */
    PARKING_FREE_ENDING_REMINDER_MINUTES: z.coerce.number().int().min(1).max(30).default(5),
    /** Reminder before the paid period ends (design brief 4.1, F4). */
    PARKING_EXIT_REMINDER_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
    /** Exit is free during the first N minutes of an air-raid alert (operator's rules). */
    PARKING_AIR_RAID_FREE_EXIT_MINUTES: z.coerce.number().int().min(0).max(240).default(30),
    /** The hero keeps showing a closed session (F6 / I4) for this long after the exit. */
    PARKING_RECENT_CLOSED_HOURS: z.coerce.number().int().min(0).max(24).default(2),
    /** Deep link the payment provider redirects to after a parking checkout. */
    PARKING_PAYMENT_RETURN_URL: optionalText,
    /** Paying with fewer minutes left in the running hour also buys the next hour (0 = off). */
    PARKING_PAY_MIN_MINUTES_LEFT: z.coerce.number().int().min(0).max(30).default(5),
    /** Read only to reject development secrets in production. */
    NODE_ENV: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.PARKING_WEBHOOK_SECRET.startsWith('dev-only-')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PARKING_WEBHOOK_SECRET'],
        message: 'must be set to a real secret in production',
      });
    }
  });

export type ParkingConfig = z.output<typeof parkingEnvSchema>;

export const parkingConfigProvider = envSectionProvider(
  PARKING_CONFIG,
  parkingEnvSchema,
  'parking',
);

/** Defaults for unit tests and fakes. */
export function defaultParkingConfig(overrides: Partial<ParkingConfig> = {}): ParkingConfig {
  return { ...parkingEnvSchema.parse({}), ...overrides };
}
