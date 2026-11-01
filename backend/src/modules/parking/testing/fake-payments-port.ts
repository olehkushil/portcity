import type { PaymentSucceededPayload } from '../../../common/contracts/events';
import type {
  AutoRefundRequest,
  AutoRefundResult,
  CreatePaymentInput,
  PaymentStatus,
  PaymentSummary,
  PaymentsPort,
} from '../../../common/contracts/payments';

const REUSABLE: readonly PaymentStatus[] = [
  'created',
  'pending',
  'succeeded',
  'fiscalized',
  'partially_refunded',
];

function attemptKey(baseKey: string, attempt: number): string {
  return attempt === 1 ? baseKey : `${baseKey}:a${attempt}`;
}

/**
 * In-memory PAYMENTS_PORT for parking tests, with the real port's rules: an open or paid attempt
 * of the logical key is returned again, a closed unpaid one is followed by `<key>:a<n>`, and the
 * call never receives the caller's transaction. Helpers move a payment to a status and build the
 * `payment.succeeded` payload the payments module would publish.
 */
export class FakePaymentsPort implements PaymentsPort {
  readonly payments = new Map<string, PaymentSummary>();
  readonly createCalls: CreatePaymentInput[] = [];
  readonly refundRequests: AutoRefundRequest[] = [];
  /** Number of arguments of the last createPayment call (2 would mean a transaction was passed). */
  lastCallArgs = 0;
  private sequence = 0;

  constructor(private readonly now: () => Date) {}

  async createPayment(input: CreatePaymentInput, ...rest: unknown[]): Promise<PaymentSummary> {
    this.createCalls.push({ ...input });
    this.lastCallArgs = 1 + rest.length;
    for (let attempt = 1; attempt < 100; attempt += 1) {
      const key = attemptKey(input.idempotencyKey, attempt);
      const existing = this.byKey(key);
      if (!existing) {
        return this.insert(input, key);
      }
      if (REUSABLE.includes(existing.status)) {
        return existing;
      }
    }
    throw new Error('FakePaymentsPort: too many attempts');
  }

  async getPayment(paymentId: string): Promise<PaymentSummary | null> {
    return this.payments.get(paymentId) ?? null;
  }

  async getPayments(paymentIds: readonly string[]): Promise<PaymentSummary[]> {
    return [...new Set(paymentIds)]
      .map((id) => this.payments.get(id))
      .filter((payment): payment is PaymentSummary => payment !== undefined);
  }

  async getPaymentByIdempotencyKey(idempotencyKey: string): Promise<PaymentSummary | null> {
    let latest: PaymentSummary | null = null;
    for (let attempt = 1; ; attempt += 1) {
      const found = this.byKey(attemptKey(idempotencyKey, attempt));
      if (!found) {
        return latest;
      }
      latest = found;
    }
  }

  async requestRefund(input: AutoRefundRequest): Promise<AutoRefundResult> {
    const payment = this.payments.get(input.paymentId);
    if (!payment) {
      throw new Error(`FakePaymentsPort: unknown payment ${input.paymentId}`);
    }
    const already = this.refundRequests.some((request) => request.paymentId === input.paymentId);
    this.refundRequests.push({ ...input });
    if (already) {
      return { paymentId: payment.id, outcome: 'already_queued', status: payment.status };
    }
    const refundable = ['succeeded', 'fiscalized', 'partially_refunded'].includes(payment.status);
    return {
      paymentId: payment.id,
      outcome: refundable ? 'queued' : 'not_refundable',
      status: payment.status,
    };
  }

  setStatus(paymentId: string, status: PaymentStatus): PaymentSummary {
    const payment = this.payments.get(paymentId);
    if (!payment) {
      throw new Error(`FakePaymentsPort: unknown payment ${paymentId}`);
    }
    const now = this.now();
    const updated: PaymentSummary = {
      ...payment,
      status,
      checkoutUrl: status === 'created' || status === 'pending' ? payment.checkoutUrl : null,
      paidAt: status === 'succeeded' ? now : payment.paidAt,
      updatedAt: now,
    };
    this.payments.set(paymentId, updated);
    return updated;
  }

  /**
   * Marks the payment succeeded and returns the outbox payload of `payment.succeeded`
   * (`late: true` when it had failed, been cancelled or expired before).
   */
  succeed(paymentId: string): PaymentSucceededPayload {
    const before = this.payments.get(paymentId)?.status;
    const late = before === 'failed' || before === 'cancelled' || before === 'expired';
    const payment = this.setStatus(paymentId, 'succeeded');
    const { _idempotencyKey: _ignored, ...meta } = payment.meta;
    return {
      paymentId: payment.id,
      userId: payment.userId,
      purpose: payment.purpose,
      amountKopecks: payment.amountKopecks,
      provider: payment.provider,
      providerRef: payment.providerRef,
      status: 'succeeded',
      meta,
      paidAt: (payment.paidAt ?? this.now()).toISOString(),
      ...(late ? { late: true } : {}),
    };
  }

  private byKey(key: string): PaymentSummary | undefined {
    return [...this.payments.values()].find((payment) => payment.meta['_idempotencyKey'] === key);
  }

  private insert(input: CreatePaymentInput, key: string): PaymentSummary {
    this.sequence += 1;
    const id = `00000000-0000-7000-8000-${String(this.sequence).padStart(12, '0')}`;
    const now = this.now();
    const summary: PaymentSummary = {
      id,
      userId: input.userId,
      purpose: input.purpose,
      amountKopecks: input.amountKopecks,
      currency: 'UAH',
      provider: 'mock',
      providerRef: `mock-${this.sequence}`,
      status: 'created',
      checkoutUrl: `https://pay.example.test/checkout/${id}`,
      fiscalReceiptUrl: null,
      failureCode: null,
      refundedKopecks: 0,
      paidAt: null,
      meta: { ...(input.meta ?? {}), _idempotencyKey: key },
      createdAt: now,
      updatedAt: now,
    };
    this.payments.set(id, summary);
    return summary;
  }
}
