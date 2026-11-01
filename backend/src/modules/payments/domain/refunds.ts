import type { PaymentStatus } from '../../../common/contracts/payments';
import type { Kopecks } from '../../../common/contracts/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { PaymentErrors } from './errors';
import { isRefundableStatus } from './state-machine';

export interface RefundablePayment {
  id?: string;
  status: PaymentStatus;
  amountKopecks: Kopecks;
  refundedKopecks: Kopecks;
}

export interface RefundPlan {
  /** Amount of this refund operation. */
  refundKopecks: Kopecks;
  /** Cumulative refunded amount after the operation. */
  refundedKopecks: Kopecks;
  /** Amount that can still be refunded afterwards. */
  remainingKopecks: Kopecks;
  nextStatus: Extract<PaymentStatus, 'refunded' | 'partially_refunded'>;
  partial: boolean;
}

export function isPositiveKopecks(value: unknown): value is Kopecks {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Decides how a refund changes the payment. `requestedKopecks` undefined/null means
 * "everything that is left". Throws `PC_PAYMENT_REFUND_NOT_ALLOWED` for payments whose money
 * was never captured (or is already fully refunded) and `PC_PAYMENT_AMOUNT_INVALID` for a
 * non-positive, non-integer or too large amount.
 */
export function planRefund(
  payment: RefundablePayment,
  requestedKopecks?: Kopecks | null,
): RefundPlan {
  if (!isRefundableStatus(payment.status)) {
    throw new DomainError(
      PaymentErrors.PC_PAYMENT_REFUND_NOT_ALLOWED,
      `Payment in status "${payment.status}" cannot be refunded`,
      { details: { paymentId: payment.id ?? null, status: payment.status } },
    );
  }
  const remainingBefore = payment.amountKopecks - payment.refundedKopecks;
  if (remainingBefore <= 0) {
    throw new DomainError(
      PaymentErrors.PC_PAYMENT_REFUND_NOT_ALLOWED,
      'Payment is already fully refunded',
      { details: { paymentId: payment.id ?? null, refundedKopecks: payment.refundedKopecks } },
    );
  }

  const refundKopecks = requestedKopecks ?? remainingBefore;
  if (!isPositiveKopecks(refundKopecks)) {
    throw new DomainError(
      PaymentErrors.PC_PAYMENT_AMOUNT_INVALID,
      'Refund amount must be a positive integer number of kopecks',
      { details: { requestedKopecks: requestedKopecks ?? null } },
    );
  }
  if (refundKopecks > remainingBefore) {
    throw new DomainError(
      PaymentErrors.PC_PAYMENT_AMOUNT_INVALID,
      `Refund amount exceeds the refundable remainder of ${remainingBefore} kopecks`,
      {
        details: {
          paymentId: payment.id ?? null,
          requestedKopecks: refundKopecks,
          remainingKopecks: remainingBefore,
        },
      },
    );
  }

  const refundedKopecks = payment.refundedKopecks + refundKopecks;
  const remainingKopecks = payment.amountKopecks - refundedKopecks;
  const partial = remainingKopecks > 0;
  return {
    refundKopecks,
    refundedKopecks,
    remainingKopecks,
    nextStatus: partial ? 'partially_refunded' : 'refunded',
    partial,
  };
}
