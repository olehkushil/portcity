import type { PaymentStatus } from '../../../common/contracts/payments';
import type { ProviderPaymentEvent } from './provider-events';
import { isOpenStatus } from './state-machine';

/** Answer of the provider adapter's status query for one payment. */
export type ProviderLookup =
  | { kind: 'event'; event: ProviderPaymentEvent }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; error: string };

export interface ReconcilablePayment {
  id: string;
  status: PaymentStatus;
  providerRef: string | null;
  createdAt: Date;
}

export type ReconcileDecision =
  | {
      action: 'skip';
      reason: 'not_open' | 'too_young' | 'provider_unavailable' | 'no_provider_ref';
    }
  /** Provider reports a terminal state: apply it like a webhook. */
  | { action: 'apply'; event: ProviderPaymentEvent }
  /**
   * Provider still says open, or does not know the payment, or no checkout was ever opened (the
   * creating request died before the provider call): cancel at the provider, then expire.
   */
  | {
      action: 'expire';
      reason: 'still_open_at_provider' | 'unknown_at_provider' | 'checkout_not_created';
    };

export function paymentAgeMinutes(
  payment: Pick<ReconcilablePayment, 'createdAt'>,
  now: Date,
): number {
  return (now.getTime() - payment.createdAt.getTime()) / 60_000;
}

/**
 * Hourly reconciliation rule (brief section 9): an open payment older than `timeoutMinutes`
 * is checked with the provider. A terminal answer is applied; "still pending" or "unknown"
 * expires the payment (the checkout page is abandoned); a provider outage waits for the
 * next run instead of guessing.
 */
export function decideReconciliation(
  payment: ReconcilablePayment,
  lookup: ProviderLookup | null,
  now: Date,
  timeoutMinutes: number,
): ReconcileDecision {
  if (!isOpenStatus(payment.status)) {
    return { action: 'skip', reason: 'not_open' };
  }
  if (paymentAgeMinutes(payment, now) < timeoutMinutes) {
    return { action: 'skip', reason: 'too_young' };
  }
  if (!payment.providerRef) {
    // Nobody ever received a checkout URL for it, so nobody can have paid it.
    return { action: 'expire', reason: 'checkout_not_created' };
  }
  if (lookup === null || lookup.kind === 'not_found') {
    return { action: 'expire', reason: 'unknown_at_provider' };
  }
  if (lookup.kind === 'unavailable') {
    return { action: 'skip', reason: 'provider_unavailable' };
  }
  if (lookup.event.kind === 'pending') {
    return { action: 'expire', reason: 'still_open_at_provider' };
  }
  return { action: 'apply', event: lookup.event };
}

/** Answer of the provider adapter to "cancel this checkout". */
export type ProviderCancelLookup =
  | { kind: 'cancelled' }
  | { kind: 'not_found' }
  /** The provider could not cancel because the payment already reached a terminal state. */
  | { kind: 'final'; event: ProviderPaymentEvent }
  | { kind: 'unavailable'; error: string };

export type CancelDecision =
  | { action: 'expire' }
  | { action: 'apply'; event: ProviderPaymentEvent }
  | { action: 'skip'; reason: 'provider_unavailable' };

/**
 * Second step of an `expire` decision: the checkout is cancelled at the provider first and the
 * payment expires locally only when the provider confirms the cancellation or does not know the
 * payment. A provider that answers with a terminal state (the customer paid in the meantime)
 * wins; an outage waits for the next run, so money captured during the race is never ignored.
 */
export function decideAfterCancel(cancel: ProviderCancelLookup): CancelDecision {
  switch (cancel.kind) {
    case 'cancelled':
    case 'not_found':
      return { action: 'expire' };
    case 'final':
      return cancel.event.kind === 'pending'
        ? { action: 'skip', reason: 'provider_unavailable' }
        : { action: 'apply', event: cancel.event };
    case 'unavailable':
      return { action: 'skip', reason: 'provider_unavailable' };
  }
}

/** Synthetic event used when the reconciliation expires a payment without a provider answer. */
export function expirationEvent(
  payment: ReconcilablePayment,
  now: Date,
  reason: string,
): ProviderPaymentEvent {
  return {
    externalId: `reconcile:${payment.id}:${now.toISOString()}`,
    providerRef: payment.providerRef ?? payment.id,
    paymentId: payment.id,
    kind: 'expired',
    failureCode: reason,
    raw: { source: 'payments-reconcile', reason },
  };
}
