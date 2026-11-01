import { z } from 'zod';

/** Injection token of the validated notifications environment slice. */
export const NOTIFICATIONS_CONFIG = Symbol('NOTIFICATIONS_CONFIG');

export const PUSH_PROVIDERS = ['stub', 'fcm'] as const;
export type PushProviderName = (typeof PUSH_PROVIDERS)[number];

/**
 * Module-specific environment (validated separately from the shared schema, see
 * src/common/config/env-section.ts). Documented in the module README.
 */
export const notificationsEnvSchema = z.object({
  /** `stub` logs and records pushes in memory; `fcm` sends through FCM HTTP v1. */
  PUSH_PROVIDER: z.enum(PUSH_PROVIDERS).default('stub'),
  /** Firebase project id (FCM HTTP v1 endpoint path). */
  FCM_PROJECT_ID: z.string().min(1).optional(),
  /** Service account JSON (raw or base64) used to mint OAuth2 tokens for FCM. */
  FCM_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),
  /** Static OAuth2 access token for local experiments (expires after an hour). */
  FCM_ACCESS_TOKEN: z.string().min(1).optional(),
  FCM_ENDPOINT: z.url().default('https://fcm.googleapis.com'),
  FCM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  /** Attempts per (notification, device) before a push is given up. */
  PUSH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  /** Hours before an event start at which the ticket reminder is sent. */
  NOTIFICATIONS_TICKET_REMINDER_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /** Hours before a voucher expiry at which the reminder is sent. */
  NOTIFICATIONS_VOUCHER_EXPIRING_HOURS: z.coerce.number().int().min(1).max(168).default(24),
});

export type NotificationsConfig = z.output<typeof notificationsEnvSchema>;
