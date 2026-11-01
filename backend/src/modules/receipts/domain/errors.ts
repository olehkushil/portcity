import { defineErrorCodes } from '../../../common/errors/error-codes';

/**
 * Error codes of the receipts module (names reserved in src/common/contracts/receipts.ts).
 * Rule rejections (TOO_OLD, FUTURE, EXCLUDED_TENANT, TOTAL_INVALID) are normally stored as the
 * `rejected` outcome of a submission; they are registered here so they can also be rendered as
 * problem documents when a caller needs to throw them.
 */
export const ReceiptErrors = defineErrorCodes({
  PC_RECEIPT_QR_INVALID: { status: 400, title: 'QR code is not a valid tax-service receipt' },
  PC_RECEIPT_DUPLICATE: { status: 409, title: 'Receipt already registered' },
  PC_RECEIPT_TOO_OLD: { status: 422, title: 'Receipt is older than the upload window' },
  PC_RECEIPT_FUTURE: { status: 422, title: 'Receipt is dated in the future' },
  PC_RECEIPT_EXCLUDED_TENANT: { status: 422, title: 'Tenant does not take part in the program' },
  PC_RECEIPT_TOTAL_INVALID: { status: 422, title: 'Receipt total is invalid' },
  PC_RECEIPT_NOT_FOUND: { status: 404, title: 'Receipt not found' },
  PC_RECEIPT_INVALID_TRANSITION: {
    status: 409,
    title: 'Receipt status does not allow this action',
  },
  PC_RECEIPT_APPEAL_NOT_ALLOWED: { status: 422, title: 'Receipt cannot be appealed' },
  PC_RECEIPT_PHOTO_REQUIRED: { status: 422, title: 'Receipt photo is required' },
  PC_RECEIPT_PHOTO_INVALID: { status: 422, title: 'Receipt photo is invalid' },
  PC_RECEIPT_MANUAL_DISABLED: { status: 403, title: 'Manual receipt submission is disabled' },
  /** Rule rejection code: the tax checker rejected the receipt during its verification hold. */
  PC_RECEIPT_NOT_VERIFIED: { status: 422, title: 'Receipt was not confirmed by the tax service' },
});

export type ReceiptErrorKey = keyof typeof ReceiptErrors;
