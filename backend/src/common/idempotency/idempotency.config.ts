import { z } from 'zod';

/** Injection token of the validated idempotency environment slice. */
export const IDEMPOTENCY_CONFIG = Symbol('IDEMPOTENCY_CONFIG');

/** Default lease of an in-progress key (seconds); see IdempotencyService.begin. */
export const DEFAULT_IDEMPOTENCY_LEASE_SECONDS = 120;

/**
 * Idempotency-specific environment (validated separately from the shared schema, see
 * src/common/config/env-section.ts). `IDEMPOTENCY_TTL_HOURS` stays in the shared schema.
 */
export const idempotencyEnvSchema = z.object({
  /**
   * How long an in-progress key (handler started, response not stored) blocks retries. A key
   * older than this was left behind by a crashed request and may be taken over by a retry.
   */
  IDEMPOTENCY_LEASE_SECONDS: z.coerce
    .number()
    .int()
    .min(5)
    .max(86_400)
    .default(DEFAULT_IDEMPOTENCY_LEASE_SECONDS),
});

export type IdempotencyConfig = z.output<typeof idempotencyEnvSchema>;
