/** Job names on the `parking-sync` queue (brief section 9). */
export const PARKING_JOBS = {
  /** Every PARKING_SYNC_EVERY_MS (60 s): operator sessions, missing sessions, info timers. */
  sync: 'sync',
  /** Every 5 min: paid app payments not applied or not registered with the operator yet. */
  paymentsSweep: 'payments-sweep',
} as const;

export const PARKING_SYNC_SCHEDULE_ID = 'parking-sync-every-minute';
export const PARKING_PAYMENTS_SWEEP_SCHEDULE_ID = 'parking-payments-sweep';
export const PARKING_PAYMENTS_SWEEP_EVERY_MS = 300_000;
