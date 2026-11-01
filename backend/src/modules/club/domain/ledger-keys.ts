/**
 * Idempotency keys the club module derives itself (callers supply their own for credit/hold/spend).
 * They live in PointsTransaction.idempotencyKey (unique), so a replay finds the existing row.
 */

/** One compensating row per reversed transaction, whatever key the caller sends. */
export function reversalKey(reversedTxId: string): string {
  return `reverse:${reversedTxId}`;
}

/**
 * Expiry row written together with a refund whose original buckets already expired
 * (redeem, wait past the expiry day, then cancel): one per reversed transaction.
 */
export function refundExpiryKey(reversedTxId: string): string {
  return `${reversalKey(reversedTxId)}:expire`;
}

/** One-off profile bonus for a filled profile field (user.profile_field_completed). */
export function profileFieldBonusKey(field: string, userId: string): string {
  return `profile-field:${field}:${userId}`;
}

/** One-off bonus when every profile field is filled. */
export function profileCompleteBonusKey(userId: string): string {
  return `profile-complete:${userId}`;
}

/** One expiry row per account and bucket day. */
export function expiryKey(accountId: string, dayKey: string): string {
  return `expire:${accountId}:${dayKey}`;
}

export const REVERSAL_KEY_PREFIX = 'reverse:';
export const EXPIRY_KEY_PREFIX = 'expire:';
