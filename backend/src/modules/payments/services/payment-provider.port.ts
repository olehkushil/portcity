import type { PaymentProvider } from '../../../common/contracts/payments';
import type { Kopecks } from '../../../common/contracts/shared';
import type { ProviderPaymentEvent } from '../domain/provider-events';

export interface CreateCheckoutInput {
  /** Our payment id; sent to the provider as the order id. */
  paymentId: string;
  userId: string;
  amountKopecks: Kopecks;
  currency: 'UAH';
  description: string;
  returnUrl: string | null;
  /** Business context (e.g. `{ sessionId }`), for provider dashboards only. */
  meta: Record<string, unknown>;
}

export interface CheckoutSession {
  /** Provider-side reference stored in `Payment.providerRef`. */
  providerRef: string;
  /** Hosted checkout page (Apple Pay / Google Pay / card) the app opens. */
  checkoutUrl: string;
  /** When the provider will stop accepting the checkout, if it says so. */
  expiresAt: Date | null;
}

export interface ProviderWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON body. */
  body: unknown;
  /**
   * Exact request bytes (`rawBody: true` in NestFactory.create, read from `request.rawBody`);
   * signatures are computed over them. Absent only for in-process calls, where adapters fall
   * back to the canonical JSON of `body`.
   */
  rawBody?: string | Buffer;
}

export interface ProviderRefundResult {
  refundRef: string | null;
  /** `succeeded`: confirmed synchronously; `pending`: the provider will send a `refunded` webhook. */
  status: 'succeeded' | 'pending';
}

/** Answer to "cancel this checkout" (reconciliation before a local expiry). */
export type ProviderCancelResult =
  | { kind: 'cancelled' }
  | { kind: 'not_found' }
  /** Too late to cancel: the payment already reached a terminal state (e.g. the customer paid). */
  | { kind: 'final'; event: ProviderPaymentEvent };

/**
 * Payment provider port (brief section 1 / plan section 8: provider abstraction so the
 * provider can change without a release). Adapters: MockPaymentProvider (dev, tests);
 * liqpay | mono | wayforpay | fondy | portmone are added after the Discovery shortlist.
 * The abstract class doubles as the Nest injection token for the default adapter.
 */
export abstract class PaymentProviderPort {
  abstract readonly name: PaymentProvider;

  /**
   * Real acquirers are strict (default): success notifications must carry the amount and the
   * currency, and timestamped notifications older than PAYMENTS_WEBHOOK_MAX_AGE_SECONDS are
   * rejected. Only the development mock may relax this.
   */
  get strictWebhooks(): boolean {
    return true;
  }

  /** Opens a hosted checkout for the payment. Throws on provider failure. */
  abstract createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;

  /** Provider's current knowledge of the payment, or null when it does not know the reference. */
  abstract getStatus(providerRef: string): Promise<ProviderPaymentEvent | null>;

  /**
   * Cancels an open hosted checkout so the customer can no longer pay it. Throws on provider
   * failure; answers `final` with the provider's event when the payment is already terminal.
   */
  abstract cancelCheckout(providerRef: string): Promise<ProviderCancelResult>;

  /**
   * Refunds part or all of a captured payment. `idempotencyKey` identifies the refund request:
   * repeating it (a retry after a timeout) must not refund twice.
   */
  abstract refund(
    providerRef: string,
    amountKopecks: Kopecks,
    reason: string,
    idempotencyKey: string,
  ): Promise<ProviderRefundResult>;

  /**
   * Verifies the callback signature and normalises the payload.
   * Throws `PC_PAYMENT_WEBHOOK_SIGNATURE` (401) or `PC_PAYMENT_WEBHOOK_MALFORMED` (400).
   */
  abstract parseWebhook(request: ProviderWebhookRequest): ProviderPaymentEvent;
}

export function headerValue(
  headers: ProviderWebhookRequest['headers'],
  name: string,
): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) {
    return direct[0];
  }
  if (typeof direct === 'string') {
    return direct;
  }
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = found?.[1];
  return Array.isArray(value) ? value[0] : value;
}
