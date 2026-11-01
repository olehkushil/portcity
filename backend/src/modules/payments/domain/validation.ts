import {
  type CreatePaymentInput,
  PAYMENT_PURPOSES,
  type PaymentPurpose,
} from '../../../common/contracts/payments';
import { DomainError } from '../../../common/errors/domain-error';
import { CommonErrors } from '../../../common/errors/error-codes';
import { PaymentErrors } from './errors';
import { ATTEMPT_SUFFIX_RESERVE } from './attempts';
import { isPositiveKopecks } from './refunds';

/** The column holds 255 characters; the rest is reserved for the attempt suffix `:a<n>`. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255 - ATTEMPT_SUFFIX_RESERVE;
export const MAX_DESCRIPTION_LENGTH = 255;
export const MAX_RETURN_URL_LENGTH = 2048;

export interface ValidatedCreatePaymentInput {
  userId: string;
  purpose: PaymentPurpose;
  amountKopecks: number;
  idempotencyKey: string;
  description: string;
  meta: Record<string, unknown>;
  returnUrl: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidField(field: string, message: string): DomainError {
  return new DomainError(CommonErrors.PC_COMMON_VALIDATION, message, {
    details: [{ path: field, messages: [message] }],
  });
}

/**
 * Normalises and checks `PaymentsPort.createPayment` input (called by other modules, so the
 * HTTP ValidationPipe never saw it). Amount problems are `PC_PAYMENT_AMOUNT_INVALID`;
 * structural problems are `PC_COMMON_VALIDATION` with the same `details` shape as the pipe.
 */
export function validateCreatePaymentInput(input: CreatePaymentInput): ValidatedCreatePaymentInput {
  if (!isPositiveKopecks(input.amountKopecks)) {
    throw new DomainError(
      PaymentErrors.PC_PAYMENT_AMOUNT_INVALID,
      'amountKopecks must be a positive integer number of kopecks',
      { details: { amountKopecks: input.amountKopecks } },
    );
  }
  if (typeof input.userId !== 'string' || input.userId.trim() === '') {
    throw invalidField('userId', 'userId is required');
  }
  if (!(PAYMENT_PURPOSES as readonly string[]).includes(input.purpose)) {
    throw invalidField('purpose', `purpose must be one of ${PAYMENT_PURPOSES.join(', ')}`);
  }
  const idempotencyKey =
    typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  if (idempotencyKey.length === 0 || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw invalidField(
      'idempotencyKey',
      `idempotencyKey must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (description.length === 0 || description.length > MAX_DESCRIPTION_LENGTH) {
    throw invalidField('description', `description must be 1-${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if (input.meta !== undefined && !isPlainObject(input.meta)) {
    throw invalidField('meta', 'meta must be a plain object');
  }
  let returnUrl: string | null = null;
  if (input.returnUrl !== undefined) {
    if (typeof input.returnUrl !== 'string' || input.returnUrl.length > MAX_RETURN_URL_LENGTH) {
      throw invalidField(
        'returnUrl',
        `returnUrl must be a string up to ${MAX_RETURN_URL_LENGTH} characters`,
      );
    }
    returnUrl = input.returnUrl.trim() === '' ? null : input.returnUrl.trim();
  }
  return {
    userId: input.userId,
    purpose: input.purpose,
    amountKopecks: input.amountKopecks,
    idempotencyKey,
    description,
    meta: input.meta ? { ...input.meta } : {},
    returnUrl,
  };
}
