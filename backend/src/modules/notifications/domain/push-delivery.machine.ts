import type { PushDeliveryStatus } from '../../../common/contracts/notifications';

/**
 * PushDelivery state machine (one row per notification and device):
 *
 *   queued -> sent | failed | skipped
 *   failed -> sent | failed | skipped      (retry while attempts < maxAttempts)
 *   sent, skipped                            final
 *
 * `failed` means the provider was asked and refused (or the call blew up);
 * `skipped` means no attempt made sense (provider not configured, no token).
 */
export const PUSH_DELIVERY_TRANSITIONS: Readonly<
  Record<PushDeliveryStatus, readonly PushDeliveryStatus[]>
> = Object.freeze({
  queued: ['sent', 'failed', 'skipped'],
  failed: ['sent', 'failed', 'skipped'],
  sent: [],
  skipped: [],
});

export function canTransitionDelivery(from: PushDeliveryStatus, to: PushDeliveryStatus): boolean {
  return PUSH_DELIVERY_TRANSITIONS[from].includes(to);
}

export function assertDeliveryTransition(from: PushDeliveryStatus, to: PushDeliveryStatus): void {
  if (!canTransitionDelivery(from, to)) {
    throw new Error(`Invalid push delivery transition ${from} -> ${to}`);
  }
}

export function isFinalDeliveryStatus(status: PushDeliveryStatus): boolean {
  return PUSH_DELIVERY_TRANSITIONS[status].length === 0;
}

/** What the provider adapter reports for one message. */
export type PushFailureCode =
  'invalid_token' | 'unregistered' | 'rate_limited' | 'provider_error' | 'not_configured';

export type PushSendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; code: PushFailureCode; retryable: boolean; message: string };

/** Status a delivery row takes after one attempt. */
export function deliveryStatusAfter(result: PushSendResult): PushDeliveryStatus {
  if (result.ok) {
    return 'sent';
  }
  return result.code === 'not_configured' ? 'skipped' : 'failed';
}

export interface DeliveryAttemptState {
  status: PushDeliveryStatus;
  attempts: number;
}

export type DeliveryPlan = 'send' | 'skip_final' | 'skip_exhausted';

/** Whether a (possibly existing) delivery row should be attempted in this job run. */
export function planDeliveryAttempt(
  existing: DeliveryAttemptState | null,
  maxAttempts: number,
): DeliveryPlan {
  if (!existing) {
    return 'send';
  }
  if (isFinalDeliveryStatus(existing.status)) {
    return 'skip_final';
  }
  if (existing.status === 'failed' && existing.attempts >= maxAttempts) {
    return 'skip_exhausted';
  }
  return 'send';
}

/** True when the job should be retried by the queue because this attempt failed transiently. */
export function shouldRetryDelivery(
  result: PushSendResult,
  attemptsAfter: number,
  maxAttempts: number,
): boolean {
  return !result.ok && result.retryable && attemptsAfter < maxAttempts;
}
