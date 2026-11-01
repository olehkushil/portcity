import { PAYMENT_STATUSES, type PaymentStatus } from '../../../common/contracts/payments';
import { DomainError } from '../../../common/errors/domain-error';
import { PaymentErrors } from './errors';

/**
 * Payment state machine (brief section 6):
 *
 *   created -> pending(3DS/wallet) -> succeeded -> fiscalized -> refunded | partially_refunded
 *                                  \-> failed | cancelled | expired
 *
 * Extensions documented in the module README:
 * - `created` may jump straight to `succeeded` (wallet payments without a 3DS step);
 * - a refund is allowed from `succeeded` as well as from `fiscalized`, because fiscalisation is
 *   optional (PAYMENTS_FISCALIZATION=none when the provider fiscalises on its own);
 * - `partially_refunded -> partially_refunded` models a second partial refund;
 * - `failed | cancelled | expired -> succeeded` is a late success: the provider captured the
 *   money after we had closed the payment (reconciliation expiry racing the customer, a
 *   provider that reverses a decline). Money was taken, so the payment must follow it; the
 *   `payment.succeeded` event carries `late: true` and the purpose module decides whether it
 *   can still use the payment or refunds it.
 */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> =
  Object.freeze({
    created: ['pending', 'succeeded', 'failed', 'cancelled', 'expired'],
    pending: ['succeeded', 'failed', 'cancelled', 'expired'],
    succeeded: ['fiscalized', 'partially_refunded', 'refunded'],
    fiscalized: ['partially_refunded', 'refunded'],
    partially_refunded: ['partially_refunded', 'refunded'],
    refunded: [],
    failed: ['succeeded'],
    cancelled: ['succeeded'],
    expired: ['succeeded'],
  });

/** Closed without captured money; only a provider-reported late success may move them. */
export const LATE_SUCCESS_SOURCES: readonly PaymentStatus[] = Object.freeze([
  'failed',
  'cancelled',
  'expired',
]);

/** Statuses whose payment may be handed out again for the same logical key (open or paid). */
export function isReusableStatus(status: PaymentStatus): boolean {
  return isOpenStatus(status) || isSettledStatus(status);
}

export function isLateSuccessSource(status: PaymentStatus): boolean {
  return LATE_SUCCESS_SOURCES.includes(status);
}

/** Statuses in which the customer may still complete the checkout. */
export const OPEN_STATUSES: readonly PaymentStatus[] = Object.freeze(['created', 'pending']);

/** Statuses in which money was captured (refunds possible). */
export const SETTLED_STATUSES: readonly PaymentStatus[] = Object.freeze([
  'succeeded',
  'fiscalized',
  'partially_refunded',
]);

/**
 * Closed statuses: the checkout is over. `refunded` never changes again; `failed`, `cancelled`
 * and `expired` only accept a late success reported by the provider (see LATE_SUCCESS_SOURCES).
 */
export const FINAL_STATUSES: readonly PaymentStatus[] = Object.freeze([
  'failed',
  'cancelled',
  'expired',
  'refunded',
]);

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === 'string' && (PAYMENT_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

/** Throws `PC_PAYMENT_INVALID_TRANSITION` (409) when the move is not in the table. */
export function assertTransition(from: PaymentStatus, to: PaymentStatus, paymentId?: string): void {
  if (!canTransition(from, to)) {
    throw new DomainError(
      PaymentErrors.PC_PAYMENT_INVALID_TRANSITION,
      `Payment cannot move from "${from}" to "${to}"`,
      { details: { paymentId: paymentId ?? null, from, to } },
    );
  }
}

export function isOpenStatus(status: PaymentStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export function isSettledStatus(status: PaymentStatus): boolean {
  return SETTLED_STATUSES.includes(status);
}

export function isFinalStatus(status: PaymentStatus): boolean {
  return FINAL_STATUSES.includes(status);
}

export function isRefundableStatus(status: PaymentStatus): boolean {
  return isSettledStatus(status);
}

/** The checkout URL is only meaningful while the payment is open (contract: null once final). */
export function visibleCheckoutUrl(
  status: PaymentStatus,
  checkoutUrl: string | null | undefined,
): string | null {
  return isOpenStatus(status) ? (checkoutUrl ?? null) : null;
}
