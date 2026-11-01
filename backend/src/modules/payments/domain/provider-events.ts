import type { PaymentStatus } from '../../../common/contracts/payments';
import type { Kopecks } from '../../../common/contracts/shared';
import { planRefund } from './refunds';
import {
  canTransition,
  isFinalStatus,
  isLateSuccessSource,
  isOpenStatus,
  isSettledStatus,
} from './state-machine';

/** What a provider can tell us about a payment, through a webhook or a status query. */
export const PROVIDER_EVENT_KINDS = [
  'pending',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'refunded',
] as const;
export type ProviderEventKind = (typeof PROVIDER_EVENT_KINDS)[number];

export function isProviderEventKind(value: unknown): value is ProviderEventKind {
  return typeof value === 'string' && (PROVIDER_EVENT_KINDS as readonly string[]).includes(value);
}

/** Provider callback or status answer, normalised by the provider adapter. */
export interface ProviderPaymentEvent {
  /** Provider-side unique id of this notification; `(provider, externalId)` is the webhook log key. */
  externalId: string;
  /** Provider-side reference of the payment (Payment.providerRef). */
  providerRef: string;
  /** Our payment id when the provider echoes it back (order id). */
  paymentId?: string | null;
  kind: ProviderEventKind;
  /** Captured amount reported by the provider (checked against the payment on success). */
  amountKopecks?: Kopecks | null;
  currency?: string | null;
  paidAt?: Date | null;
  failureCode?: string | null;
  /** Cumulative refunded amount reported by the provider (kind `refunded`). */
  refundedKopecks?: Kopecks | null;
  /**
   * When the provider sent this notification, if it says so (signed timestamp). Strict adapters
   * reject notifications older than PAYMENTS_WEBHOOK_MAX_AGE_SECONDS (replay protection).
   */
  occurredAt?: Date | null;
  /** Payload as received, stored in the webhook log. */
  raw: Record<string, unknown>;
}

export interface PaymentSnapshot {
  id?: string;
  status: PaymentStatus;
  amountKopecks: Kopecks;
  refundedKopecks: Kopecks;
  currency: string;
  providerRef: string | null;
}

export interface PaymentPatch {
  providerRef?: string;
  paidAt?: Date;
  failureCode?: string | null;
  refundedKopecks?: Kopecks;
}

export type ProviderEventDecision =
  | {
      kind: 'transition';
      from: PaymentStatus;
      to: PaymentStatus;
      patch: PaymentPatch;
      /** A success reported after the payment had failed, been cancelled or expired. */
      late?: boolean;
    }
  | { kind: 'noop'; reason: 'already_in_status' | 'nothing_to_refund' }
  | {
      kind: 'ignore';
      reason: 'final' | 'stale' | 'conflict' | 'amount_mismatch' | 'currency_mismatch';
      detail: string;
    };

const TERMINAL_FAILURE_KINDS: ReadonlySet<ProviderEventKind> = new Set([
  'failed',
  'cancelled',
  'expired',
]);

/**
 * Pure decision: how does a provider event change a payment? Handles duplicates (same
 * notification twice), out-of-order deliveries (`pending` after `succeeded`), conflicts
 * (`failed` after `succeeded`), amount or currency mismatches and cumulative refunds.
 * The caller persists the transition and publishes the matching outbox event.
 */
export function applyProviderEvent(
  payment: PaymentSnapshot,
  event: ProviderPaymentEvent,
  now: Date,
): ProviderEventDecision {
  const { status } = payment;

  if (event.kind === 'refunded') {
    return decideRefund(payment, event);
  }

  // The same notification delivered twice (BullMQ retry, provider retry) is a no-op.
  if (event.kind === status) {
    return { kind: 'noop', reason: 'already_in_status' };
  }

  if (isFinalStatus(status)) {
    if (event.kind === 'succeeded' && isLateSuccessSource(status)) {
      // The provider captured the money after we closed the payment: follow the money.
      const mismatch = amountOrCurrencyMismatch(payment, event);
      if (mismatch) {
        return mismatch;
      }
      return {
        kind: 'transition',
        from: status,
        to: 'succeeded',
        patch: { ...refPatch(payment, event), paidAt: event.paidAt ?? now, failureCode: null },
        late: true,
      };
    }
    return { kind: 'ignore', reason: 'final', detail: `payment is ${status}` };
  }

  if (event.kind === 'pending') {
    if (status === 'pending') {
      return { kind: 'noop', reason: 'already_in_status' };
    }
    if (!isOpenStatus(status)) {
      return { kind: 'ignore', reason: 'stale', detail: `pending after ${status}` };
    }
    return { kind: 'transition', from: status, to: 'pending', patch: refPatch(payment, event) };
  }

  if (event.kind === 'succeeded') {
    if (isSettledStatus(status)) {
      return { kind: 'noop', reason: 'already_in_status' };
    }
    const mismatch = amountOrCurrencyMismatch(payment, event);
    if (mismatch) {
      return mismatch;
    }
    return {
      kind: 'transition',
      from: status,
      to: 'succeeded',
      patch: { ...refPatch(payment, event), paidAt: event.paidAt ?? now, failureCode: null },
    };
  }

  if (TERMINAL_FAILURE_KINDS.has(event.kind)) {
    const to: PaymentStatus = event.kind;
    if (status === to) {
      return { kind: 'noop', reason: 'already_in_status' };
    }
    if (isSettledStatus(status)) {
      return {
        kind: 'ignore',
        reason: 'conflict',
        detail: `${event.kind} reported after the payment was ${status}`,
      };
    }
    if (!canTransition(status, to)) {
      return { kind: 'ignore', reason: 'stale', detail: `${event.kind} after ${status}` };
    }
    const patch: PaymentPatch = refPatch(payment, event);
    if (event.kind === 'failed') {
      patch.failureCode = event.failureCode ?? 'provider_failed';
    } else if (event.failureCode) {
      patch.failureCode = event.failureCode;
    }
    return { kind: 'transition', from: status, to, patch };
  }

  return {
    kind: 'ignore',
    reason: 'stale',
    detail: `unsupported event kind ${String(event.kind)}`,
  };
}

function decideRefund(
  payment: PaymentSnapshot,
  event: ProviderPaymentEvent,
): ProviderEventDecision {
  const { status } = payment;
  if (status === 'refunded') {
    return { kind: 'noop', reason: 'already_in_status' };
  }
  if (!isSettledStatus(status)) {
    return {
      kind: 'ignore',
      reason: 'conflict',
      detail: `refund reported for a payment in status ${status}`,
    };
  }
  const cumulative = event.refundedKopecks ?? null;
  let requested: Kopecks | null = null;
  if (cumulative !== null) {
    const delta = cumulative - payment.refundedKopecks;
    if (delta <= 0) {
      return { kind: 'noop', reason: 'nothing_to_refund' };
    }
    requested = Math.min(delta, payment.amountKopecks - payment.refundedKopecks);
  }
  const plan = planRefund(payment, requested);
  return {
    kind: 'transition',
    from: status,
    to: plan.nextStatus,
    patch: { ...refPatch(payment, event), refundedKopecks: plan.refundedKopecks },
  };
}

/** A success whose reported amount or currency differs from the payment is never applied. */
function amountOrCurrencyMismatch(
  payment: PaymentSnapshot,
  event: ProviderPaymentEvent,
): Extract<ProviderEventDecision, { kind: 'ignore' }> | null {
  if (event.currency && event.currency.toUpperCase() !== payment.currency.toUpperCase()) {
    return {
      kind: 'ignore',
      reason: 'currency_mismatch',
      detail: `provider reported ${event.currency}, payment is ${payment.currency}`,
    };
  }
  if (
    event.amountKopecks !== undefined &&
    event.amountKopecks !== null &&
    event.amountKopecks !== payment.amountKopecks
  ) {
    return {
      kind: 'ignore',
      reason: 'amount_mismatch',
      detail: `provider reported ${event.amountKopecks} kopecks, payment is ${payment.amountKopecks}`,
    };
  }
  return null;
}

function refPatch(payment: PaymentSnapshot, event: ProviderPaymentEvent): PaymentPatch {
  return payment.providerRef ? {} : { providerRef: event.providerRef };
}

/** Outbox event type published for a transition, or null when none is defined (pending). */
export function outboxTypeForStatus(
  to: PaymentStatus,
):
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.cancelled'
  | 'payment.expired'
  | 'payment.refunded'
  | 'payment.fiscalized'
  | null {
  switch (to) {
    case 'succeeded':
      return 'payment.succeeded';
    case 'failed':
      return 'payment.failed';
    case 'cancelled':
      return 'payment.cancelled';
    case 'expired':
      return 'payment.expired';
    case 'refunded':
    case 'partially_refunded':
      return 'payment.refunded';
    case 'fiscalized':
      return 'payment.fiscalized';
    default:
      return null;
  }
}
