/**
 * Validator PIN hardening (finding 8). Pure rules; the service persists the counter on the
 * device row (failed_pin_attempts, pin_locked_until) and writes the audit row.
 *
 * - new or changed PINs have at least 6 digits (existing 4-digit PINs keep working until changed);
 * - the PIN is accepted only by POST /validator/shift;
 * - 5 wrong PINs in a row lock opening a shift on that device for 15 minutes.
 */

/** PIN accepted when a device is registered or its PIN is changed. */
export const NEW_PIN_PATTERN = /^\d{6,12}$/;
/** PIN accepted when opening a shift (older devices may still have 4-digit PINs). */
export const SHIFT_PIN_PATTERN = /^\d{4,12}$/;

export const VALIDATOR_PIN_MAX_FAILURES = 5;
export const VALIDATOR_PIN_LOCK_MINUTES = 15;

export interface PinLockState {
  failedPinAttempts: number;
  pinLockedUntil: Date | null;
}

export function isPinLocked(state: Pick<PinLockState, 'pinLockedUntil'>, now: Date): boolean {
  return state.pinLockedUntil !== null && state.pinLockedUntil.getTime() > now.getTime();
}

export type PinFailureDecision =
  | { lock: false; failedPinAttempts: number }
  | { lock: true; failedPinAttempts: 0; pinLockedUntil: Date };

/**
 * After a wrong PIN: `attemptsAfter` is the counter including this failure. Reaching the limit
 * locks the device and restarts the counter, so the next window again allows 5 attempts.
 */
export function decidePinFailure(attemptsAfter: number, now: Date): PinFailureDecision {
  if (attemptsAfter >= VALIDATOR_PIN_MAX_FAILURES) {
    return {
      lock: true,
      failedPinAttempts: 0,
      pinLockedUntil: new Date(now.getTime() + VALIDATOR_PIN_LOCK_MINUTES * 60_000),
    };
  }
  return { lock: false, failedPinAttempts: attemptsAfter };
}
