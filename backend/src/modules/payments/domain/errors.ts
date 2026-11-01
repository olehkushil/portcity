import { defineErrorCodes } from '../../../common/errors/error-codes';

/**
 * Error codes reserved for the payments module in `src/common/contracts/payments.ts`
 * (PAYMENTS_ERROR_CODES). Thrown as `new DomainError(PaymentErrors.PC_PAYMENT_X, detail)`.
 */
export const PaymentErrors = defineErrorCodes({
  PC_PAYMENT_NOT_FOUND: { status: 404, title: 'Payment not found' },
  PC_PAYMENT_AMOUNT_INVALID: { status: 400, title: 'Payment amount is invalid' },
  PC_PAYMENT_INVALID_TRANSITION: {
    status: 409,
    title: 'Payment status transition is not allowed',
  },
  PC_PAYMENT_PROVIDER_ERROR: { status: 502, title: 'Payment provider error' },
  PC_PAYMENT_PROVIDER_UNKNOWN: { status: 404, title: 'Payment provider is unknown' },
  PC_PAYMENT_WEBHOOK_SIGNATURE: { status: 401, title: 'Webhook signature is invalid' },
  PC_PAYMENT_WEBHOOK_MALFORMED: { status: 400, title: 'Webhook payload is malformed' },
  PC_PAYMENT_REFUND_NOT_ALLOWED: { status: 422, title: 'Refund is not allowed for this payment' },
  PC_PAYMENT_WEBHOOK_STALE: { status: 400, title: 'Webhook notification is too old' },
  PC_PAYMENT_REFUND_IN_PROGRESS: { status: 409, title: 'A refund of this payment is in progress' },
});

export type PaymentErrorCode = keyof typeof PaymentErrors;
