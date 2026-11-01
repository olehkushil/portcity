/**
 * Newcomer control (plan 7.3 / 12.2): points are credited from the very first receipt, but a new
 * member cannot spend them for `newcomerLockHours` (72 h) or until the second confirmed receipt,
 * whichever comes first. The lock is set when the account is created; the ledger lifts it early
 * when a receipt credit brings the member to NEWCOMER_UNLOCK_RECEIPTS credited receipts.
 */
export const NEWCOMER_UNLOCK_RECEIPTS = 2;

export function isNewcomerLockActive(lockUntil: Date | null, now: Date): boolean {
  return lockUntil !== null && lockUntil.getTime() > now.getTime();
}

/** True when the lock is still running and the member has enough credited receipts to lift it. */
export function shouldLiftNewcomerLock(
  lockUntil: Date | null,
  now: Date,
  creditedReceipts: number,
): boolean {
  return isNewcomerLockActive(lockUntil, now) && creditedReceipts >= NEWCOMER_UNLOCK_RECEIPTS;
}
