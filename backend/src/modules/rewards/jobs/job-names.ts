/** Job names on the `vouchers-expire` queue (brief section 9). */
export const REWARDS_JOBS = {
  /** Every minute: lapsed activations return to issued, vouchers past expiresAt expire. */
  expireVouchers: 'expire',
} as const;

export type RewardsJobName = (typeof REWARDS_JOBS)[keyof typeof REWARDS_JOBS];

export const VOUCHERS_EXPIRE_SCHEDULE_ID = 'vouchers-expire-every-minute';
export const VOUCHERS_EXPIRE_EVERY_MS = 60_000;

/** Upper bound of batches per run so one tick never monopolises the worker. */
export const VOUCHERS_EXPIRE_MAX_BATCHES = 20;
