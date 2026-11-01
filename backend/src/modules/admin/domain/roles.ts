/**
 * Role sets per back-office action (brief section 3: owner | manager | moderator | support | validator).
 * `owner` passes every RolesGuard check, so it is never listed explicitly.
 */
export const ADMIN_ROLE_SETS = {
  /** Read audit, adjustments, flags and reports. */
  read: ['manager', 'moderator', 'support'],
  /** Request a manual adjustment (support compensates members, managers correct balances). */
  adjustmentRequest: ['manager', 'support'],
  /** Approve, apply or reject an adjustment. */
  adjustmentDecision: ['manager'],
  /** Create, update or delete feature flags. */
  flagWrite: ['manager'],
  /** Recompute a daily report on demand. */
  reportRecompute: ['manager'],
  /** Read and handle member support requests. */
  support: ['manager', 'support'],
} as const;
