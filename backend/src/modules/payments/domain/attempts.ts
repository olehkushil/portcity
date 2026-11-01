import { DomainError } from '../../../common/errors/domain-error';
import { PaymentErrors } from './errors';

/**
 * A logical payment (one `CreatePaymentInput.idempotencyKey`, e.g. "parking session S, paid until
 * 16:00") may need several checkout attempts: the first card is declined, the customer cancels,
 * the checkout expires. Attempt 1 uses the key as given, attempt n > 1 `<key>:a<n>`; an open or
 * paid attempt is handed out again, a closed unpaid one is followed by the next attempt.
 */
export const MAX_PAYMENT_ATTEMPTS = 50;

/** Room left in `payments.idempotency_key` (255) for the `:a<n>` suffix. */
export const ATTEMPT_SUFFIX_RESERVE = 15;

export function attemptKey(baseKey: string, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error(`attempt must be a positive integer, got ${attempt}`);
  }
  return attempt === 1 ? baseKey : `${baseKey}:a${attempt}`;
}

/** Parses `<key>:a<n>` back to `{ baseKey, attempt }` (attempt 1 for a key without suffix). */
export function parseAttemptKey(key: string): { baseKey: string; attempt: number } {
  const match = /^(.*):a(\d{1,4})$/.exec(key);
  if (match && match[1] && Number(match[2]) >= 2) {
    return { baseKey: match[1], attempt: Number(match[2]) };
  }
  return { baseKey: key, attempt: 1 };
}

export function tooManyAttempts(baseKey: string): DomainError {
  return new DomainError(
    PaymentErrors.PC_PAYMENT_INVALID_TRANSITION,
    `Payment "${baseKey}" was attempted ${MAX_PAYMENT_ATTEMPTS} times; start a new operation`,
    { details: { idempotencyKey: baseKey, maxAttempts: MAX_PAYMENT_ATTEMPTS } },
  );
}

/**
 * An attempt row was inserted but never got a checkout URL (the creating request crashed between
 * the insert and the provider call). Younger rows are being opened by a concurrent request.
 */
export const CHECKOUT_STUCK_AFTER_MS = 60_000;

export function isCheckoutStuck(
  row: { status: string; checkoutUrl: string | null; createdAt: Date },
  now: Date,
): boolean {
  return (
    (row.status === 'created' || row.status === 'pending') &&
    !row.checkoutUrl &&
    now.getTime() - row.createdAt.getTime() >= CHECKOUT_STUCK_AFTER_MS
  );
}

/** True when the provider told us the hosted checkout stops accepting payments before `now`. */
export function isCheckoutExpired(
  checkoutExpiresAt: string | null | undefined,
  now: Date,
): boolean {
  if (!checkoutExpiresAt) {
    return false;
  }
  const at = Date.parse(checkoutExpiresAt);
  return Number.isFinite(at) && at <= now.getTime();
}
