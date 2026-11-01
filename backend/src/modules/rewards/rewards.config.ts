import { z } from 'zod';
import { envSectionProvider } from '../../common/config/env-section';

/**
 * Module-specific environment (validated separately from the shared schema, see
 * docs/FOUNDATION_SUMMARY.md section 8). Documented in src/modules/rewards/README.md.
 */
export const REWARDS_CONFIG = Symbol('REWARDS_CONFIG');

export const rewardsEnvSchema = z.object({
  /** Hard expiry of a voucher bought with points, in days after the redemption. */
  REWARDS_VOUCHER_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Attempts to find a free 6-character code before PC_VOUCHER_CODE_EXHAUSTED. */
  REWARDS_CODE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(8),
  /** Vouchers handled per batch by the minute sweep. */
  REWARDS_SWEEP_BATCH_SIZE: z.coerce.number().int().min(10).max(5000).default(500),
  /** How long a validator shift token stays valid after the PIN was entered. */
  VALIDATOR_SHIFT_HOURS: z.coerce.number().min(1).max(48).default(12),
  /**
   * Product decision (the app promises the points come back): a voucher bought with points that
   * expires unused refunds them through the club ledger. Coupons, tickets and certificates
   * issued by promos or the back office never carry points.
   */
  REWARDS_REFUND_ON_EXPIRY: z.stringbool().default(true),
});

export type RewardsConfig = z.output<typeof rewardsEnvSchema>;

export const DEFAULT_REWARDS_CONFIG: RewardsConfig = Object.freeze(rewardsEnvSchema.parse({}));

export const rewardsConfigProvider = envSectionProvider(
  REWARDS_CONFIG,
  rewardsEnvSchema,
  'rewards',
);
