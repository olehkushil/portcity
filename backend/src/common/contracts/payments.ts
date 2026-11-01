/**
 * Payments contract: create and read payments through the configured provider adapter.
 * Implemented by `src/modules/payments`, provided under PAYMENTS_PORT.
 * Consumers: parking (POST /parking/session/:id/pay), admin (reports, refunds).
 * Status changes reach consumers through outbox events (`payment.succeeded`, ...).
 */
import type { Kopecks, Uuid } from './shared';

export const PAYMENTS_PORT = Symbol('PAYMENTS_PORT');

export const PAYMENT_PURPOSES = ['parking', 'other'] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export const PAYMENT_PROVIDERS = [
  'mock',
  'liqpay',
  'mono',
  'wayforpay',
  'fondy',
  'portmone',
] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const PAYMENT_STATUSES = [
  'created',
  'pending',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'refunded',
  'partially_refunded',
  'fiscalized',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_CURRENCY = 'UAH';

/** Pending payments older than this are reconciled with the provider or expired (brief section 9). */
export const PAYMENT_PENDING_TIMEOUT_MINUTES = 20;

export interface PaymentSummary {
  id: Uuid;
  userId: Uuid;
  purpose: PaymentPurpose;
  amountKopecks: Kopecks;
  currency: typeof PAYMENT_CURRENCY;
  provider: PaymentProvider;
  providerRef: string | null;
  status: PaymentStatus;
  /** Where the app sends the user to pay (null once the payment is final). */
  checkoutUrl: string | null;
  fiscalReceiptUrl: string | null;
  failureCode: string | null;
  refundedKopecks: Kopecks;
  paidAt: Date | null;
  meta: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePaymentInput {
  userId: Uuid;
  purpose: PaymentPurpose;
  /** Positive integer. */
  amountKopecks: Kopecks;
  /**
   * Unique per logical operation, e.g. `parking:<sessionId>:<paidUntilIso>` (at most 240
   * characters). An open or paid attempt for the key is returned again; after a failed,
   * cancelled, expired or refunded attempt a new attempt `<key>:a<n>` is created.
   */
  idempotencyKey: string;
  /** Shown on the provider's checkout page. */
  description: string;
  /** Business context echoed back in events, e.g. `{ sessionId }` for parking. */
  meta?: Record<string, unknown>;
  /** Deep link the provider redirects to after checkout. */
  returnUrl?: string;
}

/** Automatic refund asked for by the purpose module (e.g. a parking payment that cannot be used). */
export interface AutoRefundRequest {
  paymentId: Uuid;
  /** Machine-readable reason, e.g. `session_closed`, `already_paid`. */
  reason: string;
  /** Module asking for the refund, e.g. `parking`. */
  source: string;
  /** Defaults to everything still refundable. */
  amountKopecks?: Kopecks;
}

export interface AutoRefundResult {
  paymentId: Uuid;
  /**
   * `queued`: a refund job was queued now; `already_queued`: an earlier request exists (queued,
   * running or done); `not_refundable`: the payment holds no captured money.
   */
  outcome: 'queued' | 'already_queued' | 'not_refundable';
  status: PaymentStatus;
}

export interface PaymentsPort {
  /**
   * Creates (or reuses) a payment with a hosted checkout URL. Never joins a caller transaction:
   * the row is committed in its own short transaction, the provider is called outside any
   * transaction and the row is updated afterwards, so the caller links the returned payment in
   * its own write after this call.
   */
  createPayment(input: CreatePaymentInput): Promise<PaymentSummary>;
  getPayment(paymentId: Uuid): Promise<PaymentSummary | null>;
  /** Payments by id (missing ids are skipped), in no particular order. */
  getPayments(paymentIds: readonly Uuid[]): Promise<PaymentSummary[]>;
  /** The latest attempt for a logical key (`<key>`, `<key>:a2`, ...), or null. */
  getPaymentByIdempotencyKey(idempotencyKey: string): Promise<PaymentSummary | null>;
  /** Queues an automatic refund (idempotent per payment); the refund itself runs in a job. */
  requestRefund(input: AutoRefundRequest): Promise<AutoRefundResult>;
}

export const PAYMENTS_ERROR_CODES = [
  'PC_PAYMENT_NOT_FOUND',
  'PC_PAYMENT_AMOUNT_INVALID',
  'PC_PAYMENT_INVALID_TRANSITION',
  'PC_PAYMENT_PROVIDER_ERROR',
  'PC_PAYMENT_PROVIDER_UNKNOWN',
  'PC_PAYMENT_WEBHOOK_SIGNATURE',
  'PC_PAYMENT_WEBHOOK_MALFORMED',
  'PC_PAYMENT_REFUND_NOT_ALLOWED',
  /** 400: a strict provider sent a notification older than PAYMENTS_WEBHOOK_MAX_AGE_SECONDS. */
  'PC_PAYMENT_WEBHOOK_STALE',
  /** 409: a refund of this payment is already reserved and not finished yet. */
  'PC_PAYMENT_REFUND_IN_PROGRESS',
] as const;
export type PaymentsErrorCode = (typeof PAYMENTS_ERROR_CODES)[number];
