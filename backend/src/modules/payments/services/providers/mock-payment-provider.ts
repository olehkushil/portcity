import { createHmac } from 'node:crypto';
import { safeEqual } from '../../../../common/auth/crypto';
import type { Kopecks } from '../../../../common/contracts/shared';
import { DomainError } from '../../../../common/errors/domain-error';
import { canonicalJson } from '../../../../common/idempotency/request-hash';
import { PaymentErrors } from '../../domain/errors';
import {
  type ProviderEventKind,
  type ProviderPaymentEvent,
  isProviderEventKind,
} from '../../domain/provider-events';
import {
  type CheckoutSession,
  type CreateCheckoutInput,
  PaymentProviderPort,
  type ProviderCancelResult,
  type ProviderRefundResult,
  type ProviderWebhookRequest,
  headerValue,
} from '../payment-provider.port';

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';
export const MOCK_PROVIDER_REF_PREFIX = 'mock_';

/** Wire format of a mock webhook body (snake_case like most Ukrainian acquirers). */
export interface MockWebhookBody {
  event_id: string;
  provider_ref: string;
  status: ProviderEventKind;
  payment_id?: string;
  amount_kopecks?: number;
  currency?: string;
  paid_at?: string;
  failure_code?: string;
  refunded_kopecks?: number;
  /** When the notification was sent (ISO 8601); checked only in strict mode. */
  sent_at?: string;
}

export interface MockCheckoutState {
  paymentId: string;
  userId: string;
  amountKopecks: Kopecks;
  currency: string;
  description: string;
  status: ProviderEventKind;
  refundedKopecks: Kopecks;
  createdAt: Date;
  paidAt: Date | null;
  failureCode: string | null;
  refundCount: number;
}

export interface MockPaymentProviderOptions {
  secret: string;
  checkoutBaseUrl: string;
  now: () => Date;
  /** How long a mock checkout stays open (minutes). */
  checkoutTtlMinutes?: number;
  /** Behave like a real acquirer for webhook strictness (tests of the strict path). Default false. */
  strictWebhooks?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw malformed(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw malformed(`${field} must be a non-negative integer`);
  }
  return value;
}

function malformed(detail: string): DomainError {
  return new DomainError(PaymentErrors.PC_PAYMENT_WEBHOOK_MALFORMED, detail, {
    details: { provider: 'mock' },
  });
}

/**
 * `X-Mock-Signature` is HMAC-SHA256 (hex) with the shared secret over the exact body bytes when
 * given a string or Buffer (what goes on the wire, `request.rawBody`); a parsed object is signed
 * over its canonical JSON, the fallback used when no raw body is available.
 */
export function signMockWebhookBody(secret: string, body: unknown): string {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : canonicalJson(body);
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * In-memory stand-in for a real acquirer: returns a fake hosted checkout URL, remembers the
 * checkout so `getStatus` and `refund` work, and verifies HMAC-signed webhooks. Development
 * and tests only (rejected in production by the config schema). State lives in the API
 * process, so after a restart unknown references reconcile to `expired` like at a real
 * provider that purged an abandoned checkout.
 */
export class MockPaymentProvider extends PaymentProviderPort {
  readonly name = 'mock' as const;
  private readonly checkouts = new Map<string, MockCheckoutState>();
  /** Refund results by request idempotency key: a repeated request refunds nothing more. */
  private readonly refundsByKey = new Map<string, ProviderRefundResult>();
  private readonly ttlMs: number;

  constructor(private readonly options: MockPaymentProviderOptions) {
    super();
    this.ttlMs = (options.checkoutTtlMinutes ?? 30) * 60_000;
  }

  override get strictWebhooks(): boolean {
    return this.options.strictWebhooks ?? false;
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const providerRef = `${MOCK_PROVIDER_REF_PREFIX}${input.paymentId}`;
    const now = this.options.now();
    this.checkouts.set(providerRef, {
      paymentId: input.paymentId,
      userId: input.userId,
      amountKopecks: input.amountKopecks,
      currency: input.currency,
      description: input.description,
      status: 'pending',
      refundedKopecks: 0,
      createdAt: now,
      paidAt: null,
      failureCode: null,
      refundCount: 0,
    });
    const base = this.options.checkoutBaseUrl.replace(/\/+$/, '');
    return {
      providerRef,
      checkoutUrl: `${base}/${encodeURIComponent(providerRef)}`,
      expiresAt: new Date(now.getTime() + this.ttlMs),
    };
  }

  async getStatus(providerRef: string): Promise<ProviderPaymentEvent | null> {
    const state = this.checkouts.get(providerRef);
    if (!state) {
      return null;
    }
    return this.toEvent(providerRef, state, `status:${providerRef}:${state.status}`);
  }

  async cancelCheckout(providerRef: string): Promise<ProviderCancelResult> {
    const state = this.checkouts.get(providerRef);
    if (!state) {
      return { kind: 'not_found' };
    }
    if (state.status === 'pending') {
      state.status = 'cancelled';
      return { kind: 'cancelled' };
    }
    return {
      kind: 'final',
      event: this.toEvent(providerRef, state, `cancel:${providerRef}:${state.status}`),
    };
  }

  async refund(
    providerRef: string,
    amountKopecks: Kopecks,
    reason: string,
    idempotencyKey: string,
  ): Promise<ProviderRefundResult> {
    const repeated = this.refundsByKey.get(idempotencyKey);
    if (repeated) {
      return { ...repeated };
    }
    const state = this.checkouts.get(providerRef);
    if (!state) {
      throw new DomainError(
        PaymentErrors.PC_PAYMENT_PROVIDER_ERROR,
        `Mock provider does not know checkout ${providerRef}`,
        { details: { providerRef, reason } },
      );
    }
    if (state.status !== 'succeeded' && state.status !== 'refunded') {
      throw new DomainError(
        PaymentErrors.PC_PAYMENT_PROVIDER_ERROR,
        `Mock provider cannot refund a checkout in status ${state.status}`,
        { details: { providerRef } },
      );
    }
    const remaining = state.amountKopecks - state.refundedKopecks;
    if (amountKopecks <= 0 || amountKopecks > remaining) {
      throw new DomainError(
        PaymentErrors.PC_PAYMENT_PROVIDER_ERROR,
        `Mock provider rejected refund of ${amountKopecks} kopecks (remaining ${remaining})`,
        { details: { providerRef, amountKopecks, remaining } },
      );
    }
    state.refundedKopecks += amountKopecks;
    state.refundCount += 1;
    if (state.refundedKopecks >= state.amountKopecks) {
      state.status = 'refunded';
    }
    const result: ProviderRefundResult = {
      refundRef: `${providerRef}_refund_${state.refundCount}`,
      status: 'succeeded',
    };
    this.refundsByKey.set(idempotencyKey, result);
    return { ...result };
  }

  parseWebhook(request: ProviderWebhookRequest): ProviderPaymentEvent {
    const signature = headerValue(request.headers, MOCK_SIGNATURE_HEADER);
    if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) {
      throw new DomainError(
        PaymentErrors.PC_PAYMENT_WEBHOOK_SIGNATURE,
        `Missing or malformed ${MOCK_SIGNATURE_HEADER} header`,
        { details: { provider: 'mock' } },
      );
    }
    // Raw bytes when the HTTP layer kept them (always in the API), canonical JSON otherwise.
    const expected = signMockWebhookBody(this.options.secret, request.rawBody ?? request.body);
    if (!safeEqual(signature.toLowerCase(), expected)) {
      throw new DomainError(PaymentErrors.PC_PAYMENT_WEBHOOK_SIGNATURE, 'Signature mismatch', {
        details: { provider: 'mock' },
      });
    }
    return parseMockWebhookBody(request.body);
  }

  // --- helpers for tests, the dev checkout page and the README examples ---------------------

  /** Simulates the customer finishing (or abandoning) the hosted checkout. */
  settle(
    providerRef: string,
    outcome: Extract<ProviderEventKind, 'succeeded' | 'failed' | 'cancelled' | 'expired'>,
    failureCode?: string,
  ): MockCheckoutState {
    const state = this.checkouts.get(providerRef);
    if (!state) {
      throw new Error(`Mock checkout ${providerRef} does not exist`);
    }
    state.status = outcome;
    state.paidAt = outcome === 'succeeded' ? this.options.now() : null;
    state.failureCode = outcome === 'failed' ? (failureCode ?? 'card_declined') : null;
    return state;
  }

  /**
   * Builds a signed webhook request for a checkout in its current state: the body is serialised
   * once (`rawBody`) and the signature covers exactly that string, like a real provider call.
   */
  buildWebhook(
    providerRef: string,
    eventId: string,
    options: { sentAt?: Date; omit?: ReadonlyArray<'amount_kopecks' | 'currency'> } = {},
  ): { headers: Record<string, string>; body: MockWebhookBody; rawBody: string } {
    const state = this.checkouts.get(providerRef);
    if (!state) {
      throw new Error(`Mock checkout ${providerRef} does not exist`);
    }
    const body: MockWebhookBody = {
      event_id: eventId,
      provider_ref: providerRef,
      payment_id: state.paymentId,
      status: state.status,
      amount_kopecks: state.amountKopecks,
      currency: state.currency,
    };
    for (const field of options.omit ?? []) {
      delete body[field];
    }
    if (options.sentAt) {
      body.sent_at = options.sentAt.toISOString();
    }
    if (state.paidAt) {
      body.paid_at = state.paidAt.toISOString();
    }
    if (state.failureCode) {
      body.failure_code = state.failureCode;
    }
    if (state.refundedKopecks > 0) {
      body.refunded_kopecks = state.refundedKopecks;
    }
    const rawBody = JSON.stringify(body);
    return { headers: this.sign(rawBody), body, rawBody };
  }

  /**
   * Signs an arbitrary body (tests craft malformed or tampered payloads with it): a string or
   * Buffer is signed as raw bytes, an object over its canonical JSON.
   */
  sign(body: unknown): Record<string, string> {
    return { [MOCK_SIGNATURE_HEADER]: signMockWebhookBody(this.options.secret, body) };
  }

  getCheckout(providerRef: string): MockCheckoutState | undefined {
    return this.checkouts.get(providerRef);
  }

  /** Drops a checkout so the reconciliation sees "unknown at provider". */
  forget(providerRef: string): boolean {
    return this.checkouts.delete(providerRef);
  }

  private toEvent(
    providerRef: string,
    state: MockCheckoutState,
    externalId: string,
  ): ProviderPaymentEvent {
    return {
      externalId,
      providerRef,
      paymentId: state.paymentId,
      kind: state.status,
      amountKopecks: state.amountKopecks,
      currency: state.currency,
      paidAt: state.paidAt,
      failureCode: state.failureCode,
      refundedKopecks: state.refundedKopecks > 0 ? state.refundedKopecks : null,
      raw: { source: 'mock-status', status: state.status },
    };
  }
}

/** Validates the mock wire format and maps it to the normalised event. Exported for tests. */
export function parseMockWebhookBody(body: unknown): ProviderPaymentEvent {
  if (!isRecord(body)) {
    throw malformed('Body must be a JSON object');
  }
  const eventId = optionalString(body.event_id, 'event_id');
  const providerRef = optionalString(body.provider_ref, 'provider_ref');
  if (!eventId) {
    throw malformed('event_id is required');
  }
  if (!providerRef) {
    throw malformed('provider_ref is required');
  }
  if (!isProviderEventKind(body.status)) {
    throw malformed(
      'status must be one of pending, succeeded, failed, cancelled, expired, refunded',
    );
  }
  const paidAt = optionalTimestamp(body.paid_at, 'paid_at');
  const occurredAt = optionalTimestamp(body.sent_at, 'sent_at');
  return {
    externalId: eventId,
    providerRef,
    paymentId: optionalString(body.payment_id, 'payment_id') ?? null,
    kind: body.status,
    amountKopecks: optionalInt(body.amount_kopecks, 'amount_kopecks') ?? null,
    currency: optionalString(body.currency, 'currency') ?? null,
    paidAt,
    failureCode: optionalString(body.failure_code, 'failure_code') ?? null,
    refundedKopecks: optionalInt(body.refunded_kopecks, 'refunded_kopecks') ?? null,
    occurredAt,
    raw: body,
  };
}

function optionalTimestamp(value: unknown, field: string): Date | null {
  const raw = optionalString(value, field);
  if (raw === undefined) {
    return null;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw malformed(`${field} must be an ISO 8601 timestamp`);
  }
  return date;
}
