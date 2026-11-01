import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Payment, PaymentWebhookLog, Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import {
  OUTBOX_AGGREGATES,
  PAYMENT_EVENTS,
  type PaymentPayload,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import {
  type AutoRefundRequest,
  type AutoRefundResult,
  type CreatePaymentInput,
  PAYMENT_CURRENCY,
  type PaymentProvider,
  type PaymentPurpose,
  type PaymentStatus,
  type PaymentSummary,
  type PaymentsPort,
} from '../../../common/contracts/payments';
import type { ActorRef } from '../../../common/contracts/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { isUniqueViolation } from '../../../common/prisma/prisma.errors';
import { PrismaService, type Tx } from '../../../common/prisma/prisma.service';
import { QUEUES } from '../../../common/queue/queue.constants';
import { Clock } from '../../../common/time/clock';
import {
  MAX_PAYMENT_ATTEMPTS,
  attemptKey,
  isCheckoutExpired,
  isCheckoutStuck,
  tooManyAttempts,
} from '../domain/attempts';
import { PaymentErrors } from '../domain/errors';
import {
  type ProviderPaymentEvent,
  applyProviderEvent,
  outboxTypeForStatus,
} from '../domain/provider-events';
import { displayNumberOf, signOperatorQr } from '../domain/receipt';
import {
  type ProviderCancelLookup,
  type ProviderLookup,
  type ReconcileDecision,
  decideAfterCancel,
  decideReconciliation,
  expirationEvent,
  paymentAgeMinutes,
} from '../domain/reconcile';
import { isPositiveKopecks, planRefund } from '../domain/refunds';
import {
  assertTransition,
  isOpenStatus,
  isRefundableStatus,
  isReusableStatus,
  isSettledStatus,
} from '../domain/state-machine';
import { type ValidatedCreatePaymentInput, validateCreatePaymentInput } from '../domain/validation';
import { AUTO_REFUND_JOB_OPTIONS, PAYMENT_JOBS } from '../jobs/job-names';
import { PAYMENTS_CONFIG, type PaymentsConfig } from '../payments.config';
import { FiscalizationPort, type FiscalizationResult } from './fiscalization.port';
import {
  type AutoRefundRecord,
  type InternalMeta,
  type PaymentCursor,
  type PendingRefundRecord,
  type RefundRecord,
  buildInitialMeta,
  callerMeta,
  cursorWhere,
  internalMeta,
  isPaymentCursor,
  paymentCursorOf,
  toPaymentSummary,
  withInternalMeta,
} from './payment.mapper';
import type { CheckoutSession, ProviderRefundResult } from './payment-provider.port';
import { PaymentProviderRegistry } from './providers/provider.registry';

/** Minimal producer-side queue surface (BullMQ `Queue` or the in-memory stand-in). */
export interface JobQueue {
  add(
    name: string,
    data: unknown,
    opts?: {
      jobId?: string;
      attempts?: number;
      backoff?: { type: 'exponential' | 'fixed'; delay: number };
    },
  ): Promise<unknown>;
}

export type EventSource = 'webhook' | 'reconcile' | 'admin';

export type ApplyOutcome =
  | {
      kind: 'transitioned';
      paymentId: string;
      from: PaymentStatus;
      to: PaymentStatus;
      payment: PaymentSummary;
      /** A success after the payment had failed, been cancelled or expired. */
      late?: boolean;
    }
  | { kind: 'noop'; paymentId: string; reason: string; payment: PaymentSummary }
  | { kind: 'ignored'; paymentId: string; reason: string; detail: string; payment: PaymentSummary };

export function describeOutcome(outcome: ApplyOutcome): string {
  switch (outcome.kind) {
    case 'transitioned':
      return `transitioned:${outcome.from}->${outcome.to}${outcome.late ? ':late' : ''}`;
    case 'noop':
      return `noop:${outcome.reason}`;
    case 'ignored':
      return `ignored:${outcome.reason}`;
  }
}

export type FiscalizeOutcome =
  | { kind: 'fiscalized'; paymentId: string; fiscalReceiptUrl: string | null }
  | { kind: 'skipped'; paymentId: string; reason: string };

export type AutoRefundOutcome =
  | { kind: 'refunded'; paymentId: string; status: PaymentStatus }
  | { kind: 'skipped'; paymentId: string; reason: string };

export type ReconcileOutcome =
  | { action: 'skipped'; reason: string; payment: PaymentSummary }
  | { action: 'applied'; outcome: ApplyOutcome; payment: PaymentSummary }
  | { action: 'expired'; outcome: ApplyOutcome; payment: PaymentSummary };

export interface ListPaymentsFilter {
  userId?: string;
  status?: PaymentStatus;
  provider?: PaymentProvider;
  purpose?: PaymentPurpose;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

export interface RefundRequest {
  amountKopecks?: number | null;
  reason: string;
  actor: ActorRef;
  ip?: string | null;
  /** Idempotency key of the refund at the provider; generated when absent. */
  requestId?: string;
}

export interface AdminPaymentDetail {
  payment: PaymentSummary;
  internal: InternalMeta;
  webhooks: PaymentWebhookLog[];
}

/** Receipt screen fields (PaymentDto) derived from the payment and configuration. */
export interface PaymentReceiptFields {
  /** Short human id, e.g. `4F7K-2031`. */
  displayNumber: string;
  merchantName: string;
  parking: { plateDisplay: string | null; paidUntil: Date | null; sessionId: string } | null;
  /** Signed QR payload for the parking operator; null unless a paid parking payment. */
  operatorQrPayload: string | null;
}

/** How long a caller waits for a concurrent request to open the checkout of the same attempt. */
const CHECKOUT_WAIT_STEPS = 10;
const CHECKOUT_WAIT_STEP_MS = 200;

/**
 * Payments: creation through the configured provider adapter, status transitions driven by
 * provider events (webhooks, reconciliation), refunds and the fiscalisation hook. Implements
 * PAYMENTS_PORT for parking and admin. Every status change happens under a row lock inside a
 * transaction together with the outbox event (brief section 3). No provider call ever runs inside
 * a database transaction: rows are reserved first, the provider is called, the result is stored.
 */
@Injectable()
export class PaymentsService implements PaymentsPort {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly providers: PaymentProviderRegistry,
    private readonly fiscalization: FiscalizationPort,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
    @InjectQueue(QUEUES.paymentsReconcile) private readonly queue: JobQueue,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  // --- PaymentsPort ----------------------------------------------------------------------------

  /**
   * Creates or reuses an attempt for the logical key (see domain/attempts.ts): an open or paid
   * attempt is returned again, a closed unpaid one is followed by `<key>:a<n+1>`. The attempt row
   * is committed in its own short transaction (never the caller's), the provider is called
   * outside any transaction and the checkout is stored afterwards.
   */
  async createPayment(input: CreatePaymentInput): Promise<PaymentSummary> {
    const valid = validateCreatePaymentInput(input);
    for (let attempt = 1; attempt <= MAX_PAYMENT_ATTEMPTS; attempt += 1) {
      const key = attemptKey(valid.idempotencyKey, attempt);
      const existing = await this.prisma.payment.findUnique({ where: { idempotencyKey: key } });
      if (existing) {
        const reused = await this.reuseAttempt(existing, valid);
        if (reused) {
          return reused;
        }
        continue;
      }
      const inserted = await this.insertAttempt(valid, key, attempt);
      if (inserted) {
        return this.openCheckout(inserted, valid);
      }
      // A concurrent call inserted this attempt between our read and our insert (P2002).
      const raced = await this.prisma.payment.findUnique({ where: { idempotencyKey: key } });
      if (raced) {
        this.logger.warn(`createPayment raced on key "${key}"; using payment ${raced.id}`);
        const reused = await this.reuseAttempt(raced, valid);
        if (reused) {
          return reused;
        }
      }
    }
    throw tooManyAttempts(valid.idempotencyKey);
  }

  async getPayment(paymentId: string): Promise<PaymentSummary | null> {
    const row = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    return row ? toPaymentSummary(row) : null;
  }

  async getPayments(paymentIds: readonly string[]): Promise<PaymentSummary[]> {
    const ids = [...new Set(paymentIds)];
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.prisma.payment.findMany({ where: { id: { in: ids } } });
    return rows.map(toPaymentSummary);
  }

  /** The latest attempt of the logical key (`<key>`, `<key>:a2`, ...). */
  async getPaymentByIdempotencyKey(idempotencyKey: string): Promise<PaymentSummary | null> {
    let latest: Payment | null = null;
    for (let attempt = 1; attempt <= MAX_PAYMENT_ATTEMPTS; attempt += 1) {
      const row = await this.prisma.payment.findUnique({
        where: { idempotencyKey: attemptKey(idempotencyKey, attempt) },
      });
      if (!row) {
        break;
      }
      latest = row;
    }
    return latest ? toPaymentSummary(latest) : null;
  }

  /**
   * Queues an automatic refund once per payment (PaymentsPort): the request is stored under the
   * row lock in `_internal.autoRefund` and audited, then the `auto-refund` job (long retry policy)
   * refunds through the provider. The hourly reconciliation re-queues requests whose job was lost.
   */
  async requestRefund(input: AutoRefundRequest): Promise<AutoRefundResult> {
    if (input.amountKopecks !== undefined && !isPositiveKopecks(input.amountKopecks)) {
      throw new DomainError(
        PaymentErrors.PC_PAYMENT_AMOUNT_INVALID,
        'Refund amount must be a positive integer number of kopecks',
        { details: { amountKopecks: input.amountKopecks } },
      );
    }
    const now = this.clock.now();
    const decided = await this.prisma.withTx(async (tx) => {
      const row = await this.lockPayment(tx, input.paymentId);
      const existing = internalMeta(row.meta).autoRefund;
      if (existing) {
        return {
          outcome: 'already_queued' as const,
          row,
          enqueue: existing.state === 'queued',
        };
      }
      if (!isRefundableStatus(row.status) || row.amountKopecks - row.refundedKopecks <= 0) {
        return { outcome: 'not_refundable' as const, row, enqueue: false };
      }
      const record: AutoRefundRecord = {
        state: 'queued',
        reason: input.reason,
        source: input.source,
        amountKopecks: input.amountKopecks ?? null,
        requestedAt: now.toISOString(),
      };
      const updated = await tx.payment.update({
        where: { id: row.id },
        data: { updatedAt: now, meta: withInternalMeta(row.meta, { autoRefund: record }) },
      });
      await this.audit.audit(
        {
          actor: { type: 'system', id: `auto-refund:${input.source}` },
          action: 'payment.auto_refund_requested',
          entityType: 'payment',
          entityId: row.id,
          before: { status: row.status, refundedKopecks: row.refundedKopecks },
          after: { autoRefund: record },
          reason: input.reason,
        },
        tx,
      );
      return { outcome: 'queued' as const, row: updated, enqueue: true };
    });
    if (decided.enqueue) {
      await this.enqueueAutoRefund(input.paymentId);
    }
    if (decided.outcome === 'queued') {
      this.logger.warn(
        `Automatic refund queued for payment ${input.paymentId} (${input.source}: ${input.reason})`,
      );
    }
    return { paymentId: input.paymentId, outcome: decided.outcome, status: decided.row.status };
  }

  // --- member and admin reads ------------------------------------------------------------------

  /** Throws 404 for a missing payment and for another member's payment (no existence leak). */
  async getPaymentForUser(userId: string, paymentId: string): Promise<PaymentSummary> {
    const row = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!row || row.userId !== userId) {
      throw this.notFound(paymentId);
    }
    return toPaymentSummary(row);
  }

  async requirePayment(paymentId: string): Promise<PaymentSummary> {
    const summary = await this.getPayment(paymentId);
    if (!summary) {
      throw this.notFound(paymentId);
    }
    return summary;
  }

  async list(filter: ListPaymentsFilter): Promise<Page<PaymentSummary>> {
    const cursor = decodeCursor<PaymentCursor>(filter.cursor, isPaymentCursor);
    const createdAt: Prisma.DateTimeFilter | undefined =
      filter.from || filter.to
        ? {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lt: filter.to } : {}),
          }
        : undefined;
    const rows = await this.prisma.payment.findMany({
      where: {
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.provider ? { provider: filter.provider } : {}),
        ...(filter.purpose ? { purpose: filter.purpose } : {}),
        ...(createdAt ? { createdAt } : {}),
        AND: cursorWhere(cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
    });
    return toPage(rows.map(toPaymentSummary), filter.limit, paymentCursorOf);
  }

  async getAdminDetail(paymentId: string): Promise<AdminPaymentDetail> {
    const row = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!row) {
      throw this.notFound(paymentId);
    }
    const webhooks = await this.prisma.paymentWebhookLog.findMany({
      where: { paymentId },
      orderBy: { receivedAt: 'asc' },
      take: 100,
    });
    return { payment: toPaymentSummary(row), internal: internalMeta(row.meta), webhooks };
  }

  /**
   * Receipt screen fields: display number, merchant (the parking operator for parking), the
   * parking facts from the caller meta and the signed operator QR for paid parking payments.
   * E-mailing a receipt is out of scope: the app shares `fiscalReceiptUrl`.
   */
  receiptOf(summary: PaymentSummary): PaymentReceiptFields {
    const meta = summary.meta;
    const sessionId = typeof meta['sessionId'] === 'string' ? meta['sessionId'] : null;
    const paidUntilRaw = typeof meta['paidUntil'] === 'string' ? new Date(meta['paidUntil']) : null;
    const paidUntil = paidUntilRaw && !Number.isNaN(paidUntilRaw.getTime()) ? paidUntilRaw : null;
    const plateDisplay =
      typeof meta['plateDisplay'] === 'string'
        ? meta['plateDisplay']
        : typeof meta['plate'] === 'string'
          ? meta['plate']
          : null;
    const parking =
      summary.purpose === 'parking' && sessionId ? { plateDisplay, paidUntil, sessionId } : null;
    const operatorQrPayload =
      parking && parking.paidUntil && isSettledStatus(summary.status)
        ? signOperatorQr(this.config.PAYMENTS_RECEIPT_QR_SECRET, {
            paymentId: summary.id,
            sessionId: parking.sessionId,
            paidUntil: parking.paidUntil,
            amountKopecks: summary.amountKopecks,
          })
        : null;
    return {
      displayNumber: displayNumberOf(summary.id),
      merchantName:
        summary.purpose === 'parking'
          ? this.config.PAYMENTS_PARKING_MERCHANT_NAME
          : this.config.PAYMENTS_MERCHANT_NAME,
      parking,
      operatorQrPayload,
    };
  }

  // --- provider events (webhooks, reconciliation) ----------------------------------------------

  /** Applies a provider event in its own transaction and runs the after-commit follow-ups. */
  async applyProviderEvent(
    paymentId: string,
    event: ProviderPaymentEvent,
    source: EventSource,
  ): Promise<ApplyOutcome> {
    const outcome = await this.prisma.withTx((tx) =>
      this.applyProviderEventInTx(tx, paymentId, event, source),
    );
    await this.followUp(outcome);
    return outcome;
  }

  /**
   * Locks the payment, decides with the pure `applyProviderEvent` and persists the transition
   * plus its outbox event. The caller commits and then calls `followUp(outcome)`.
   */
  async applyProviderEventInTx(
    tx: Tx,
    paymentId: string,
    event: ProviderPaymentEvent,
    source: EventSource,
  ): Promise<ApplyOutcome> {
    const row = await this.lockPayment(tx, paymentId);
    const now = this.clock.now();
    const decision = applyProviderEvent(
      {
        id: row.id,
        status: row.status,
        amountKopecks: row.amountKopecks,
        refundedKopecks: row.refundedKopecks,
        currency: row.currency,
        providerRef: row.providerRef,
      },
      event,
      now,
    );

    if (decision.kind === 'noop') {
      return { kind: 'noop', paymentId, reason: decision.reason, payment: toPaymentSummary(row) };
    }
    if (decision.kind === 'ignore') {
      this.logger.warn(
        `Ignoring ${source} event ${event.externalId} (${event.kind}) for payment ${paymentId}: ${decision.reason} (${decision.detail})`,
      );
      return {
        kind: 'ignored',
        paymentId,
        reason: decision.reason,
        detail: decision.detail,
        payment: toPaymentSummary(row),
      };
    }

    const late = decision.late === true;
    const internal: Partial<InternalMeta> = {
      lastEvent: { source, externalId: event.externalId, at: now.toISOString() },
    };
    if (late) {
      internal.lateSuccess = { from: decision.from, at: now.toISOString() };
    }
    if (decision.patch.refundedKopecks !== undefined) {
      const record: RefundRecord = {
        refundRef: event.externalId,
        kopecks: decision.patch.refundedKopecks - row.refundedKopecks,
        reason: 'reported by provider',
        source: 'provider',
        actorId: null,
        at: now.toISOString(),
      };
      internal.refunds = [...(internalMeta(row.meta).refunds ?? []), record];
      internal.pendingRefund = null;
    }
    const data: Prisma.PaymentUpdateManyMutationInput = {
      status: decision.to,
      updatedAt: now,
      meta: withInternalMeta(row.meta, internal),
    };
    if (decision.patch.providerRef !== undefined) {
      data.providerRef = decision.patch.providerRef;
    }
    if (decision.patch.paidAt !== undefined) {
      data.paidAt = decision.patch.paidAt;
    }
    if (decision.patch.failureCode !== undefined) {
      data.failureCode = decision.patch.failureCode;
    }
    if (decision.patch.refundedKopecks !== undefined) {
      data.refundedKopecks = decision.patch.refundedKopecks;
    }

    const updated = await this.persistTransition(tx, row, decision.to, data);
    await this.publishStatusEvent(tx, updated, { late });
    if (late) {
      this.logger.warn(
        `Payment ${paymentId}: late success after ${decision.from} (${source} ${event.externalId}); the purpose module decides whether to keep or refund it`,
      );
    } else {
      this.logger.log(
        `Payment ${paymentId}: ${decision.from} -> ${decision.to} (${source} ${event.externalId})`,
      );
    }
    return {
      kind: 'transitioned',
      paymentId,
      from: decision.from,
      to: decision.to,
      payment: toPaymentSummary(updated),
      ...(late ? { late: true } : {}),
    };
  }

  /** After-commit side effects that must not run inside the transaction (queue writes). */
  async followUp(outcome: ApplyOutcome): Promise<void> {
    if (outcome.kind !== 'transitioned' || outcome.to !== 'succeeded') {
      return;
    }
    if (!this.fiscalizationEnabled) {
      return;
    }
    await this.enqueueFiscalize(outcome.paymentId);
  }

  get fiscalizationEnabled(): boolean {
    return this.fiscalization.name !== 'none';
  }

  async enqueueFiscalize(paymentId: string): Promise<void> {
    try {
      await this.queue.add(
        PAYMENT_JOBS.fiscalize,
        { paymentId },
        { jobId: `${PAYMENT_JOBS.fiscalize}-${paymentId}` },
      );
    } catch (error) {
      // The hourly reconciliation re-enqueues succeeded payments without a fiscal receipt.
      this.logger.error(
        `Could not enqueue fiscalisation for payment ${paymentId}: ${messageOf(error)}`,
      );
    }
  }

  /** `jobSuffix` lets the hourly sweep re-queue a request whose first job failed for good. */
  async enqueueAutoRefund(paymentId: string, jobSuffix?: string): Promise<void> {
    try {
      await this.queue.add(
        PAYMENT_JOBS.autoRefund,
        { paymentId },
        {
          jobId: `${PAYMENT_JOBS.autoRefund}-${paymentId}${jobSuffix ? `-${jobSuffix}` : ''}`,
          ...AUTO_REFUND_JOB_OPTIONS,
        },
      );
    } catch (error) {
      // The hourly reconciliation re-queues automatic refunds that are still `queued`.
      this.logger.error(
        `Could not enqueue the automatic refund of payment ${paymentId}: ${messageOf(error)}`,
      );
    }
  }

  // --- fiscalisation ---------------------------------------------------------------------------

  async fiscalize(paymentId: string): Promise<FiscalizeOutcome> {
    const row = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!row) {
      return { kind: 'skipped', paymentId, reason: 'not_found' };
    }
    if (row.status !== 'succeeded') {
      return { kind: 'skipped', paymentId, reason: `status_${row.status}` };
    }
    if (!this.fiscalizationEnabled) {
      return { kind: 'skipped', paymentId, reason: 'disabled' };
    }
    const now = this.clock.now();
    let result: FiscalizationResult;
    try {
      result = await this.fiscalization.fiscalize({
        paymentId: row.id,
        userId: row.userId,
        purpose: row.purpose,
        amountKopecks: row.amountKopecks,
        currency: row.currency,
        description: internalMeta(row.meta).description ?? `Payment ${row.id}`,
        provider: row.provider,
        providerRef: row.providerRef,
        paidAt: row.paidAt ?? now,
      });
    } catch (error) {
      // Merged under the row lock: a refund reserved meanwhile must not be overwritten.
      await this.mergeInternalMeta(
        row.id,
        {
          fiscalization: {
            state: 'failed',
            adapter: this.fiscalization.name,
            reason: messageOf(error),
            at: now.toISOString(),
          },
        },
        'succeeded',
      );
      throw this.providerError(this.fiscalization.name, 'fiscalize', error);
    }

    if (result.kind === 'skipped') {
      await this.mergeInternalMeta(
        row.id,
        {
          fiscalization: {
            state: 'skipped',
            adapter: this.fiscalization.name,
            reason: result.reason,
            at: now.toISOString(),
          },
        },
        'succeeded',
      );
      return { kind: 'skipped', paymentId, reason: result.reason };
    }

    return this.prisma.withTx(async (tx) => {
      const locked = await this.lockPayment(tx, paymentId);
      if (locked.status !== 'succeeded') {
        return { kind: 'skipped', paymentId, reason: `status_${locked.status}` };
      }
      const updated = await this.persistTransition(tx, locked, 'fiscalized', {
        status: 'fiscalized',
        fiscalReceiptUrl: result.fiscalReceiptUrl,
        updatedAt: this.clock.now(),
        meta: withInternalMeta(locked.meta, {
          fiscalization: {
            state: 'done',
            adapter: this.fiscalization.name,
            fiscalRef: result.fiscalRef,
            at: this.clock.now().toISOString(),
          },
        }),
      });
      await this.publishStatusEvent(tx, updated);
      this.logger.log(`Payment ${paymentId}: succeeded -> fiscalized (${this.fiscalization.name})`);
      return { kind: 'fiscalized', paymentId, fiscalReceiptUrl: updated.fiscalReceiptUrl };
    });
  }

  /**
   * Succeeded payments that still need a fiscal receipt (no attempt yet, or a failed one);
   * the hourly job re-enqueues them. Payments the adapter explicitly skipped are excluded.
   * Raw SQL because a Prisma JSON-path filter under NOT drops rows where the path is absent.
   */
  async findUnfiscalized(limit: number): Promise<string[]> {
    // The JSON path literal mirrors INTERNAL_META_KEY ('_internal'); a spec guards the spelling.
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM payments
      WHERE status = 'succeeded'
        AND COALESCE(meta #>> '{_internal,fiscalization,state}', '') <> 'skipped'
      ORDER BY paid_at ASC NULLS LAST, created_at ASC
      LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  // --- refunds ---------------------------------------------------------------------------------

  /**
   * Refund in three steps so that money can never be refunded twice: (1) under the row lock the
   * amount is checked and reserved in `_internal.pendingRefund` with a request id; (2) the
   * provider is called outside any transaction with that request id as its idempotency key;
   * (3) under the lock the result is recorded. A reservation left by a crash or a transport error
   * is resumed with the same request id; a definitive provider rejection releases it.
   */
  async refund(paymentId: string, request: RefundRequest): Promise<PaymentSummary> {
    const reserved = await this.prisma.withTx(async (tx) => {
      const locked = await this.lockPayment(tx, paymentId);
      if (!locked.providerRef) {
        planRefund(locked, request.amountKopecks);
        throw new DomainError(
          PaymentErrors.PC_PAYMENT_REFUND_NOT_ALLOWED,
          'Payment has no provider reference to refund against',
          { details: { paymentId } },
        );
      }
      const pending = internalMeta(locked.meta).pendingRefund ?? null;
      if (pending) {
        const resumable =
          pending.requestId !== undefined &&
          pending.state !== 'awaiting_provider' &&
          (request.amountKopecks === undefined ||
            request.amountKopecks === null ||
            request.amountKopecks === pending.kopecks);
        if (!resumable || !pending.requestId) {
          throw new DomainError(
            PaymentErrors.PC_PAYMENT_REFUND_IN_PROGRESS,
            'A refund of this payment is already in progress',
            {
              details: {
                paymentId,
                pendingKopecks: pending.kopecks,
                state: pending.state ?? 'awaiting_provider',
              },
            },
          );
        }
        this.logger.warn(`Resuming refund ${pending.requestId} of payment ${paymentId}`);
        return {
          row: locked,
          requestId: pending.requestId,
          kopecks: pending.kopecks,
          reason: pending.reason,
        };
      }
      const plan = planRefund(locked, request.amountKopecks);
      const requestId = request.requestId ?? uuidv7();
      const reservation: PendingRefundRecord = {
        requestId,
        state: 'reserved',
        refundRef: null,
        kopecks: plan.refundKopecks,
        reason: request.reason,
        actorId: request.actor.id ?? null,
        requestedAt: this.clock.now().toISOString(),
      };
      await tx.payment.update({
        where: { id: paymentId },
        data: { meta: withInternalMeta(locked.meta, { pendingRefund: reservation }) },
      });
      return { row: locked, requestId, kopecks: plan.refundKopecks, reason: request.reason };
    });

    const providerRef = reserved.row.providerRef ?? '';
    const provider = this.providers.get(reserved.row.provider);
    let result: ProviderRefundResult;
    try {
      result = await provider.refund(
        providerRef,
        reserved.kopecks,
        reserved.reason,
        reserved.requestId,
      );
    } catch (error) {
      await this.releaseOrMarkReservation(paymentId, reserved.requestId, error);
      throw this.providerError(provider.name, 'refund', error);
    }

    const now = this.clock.now();
    return this.prisma.withTx(async (tx) => {
      const locked = await this.lockPayment(tx, paymentId);
      const before = { status: locked.status, refundedKopecks: locked.refundedKopecks };
      const pending = internalMeta(locked.meta).pendingRefund ?? null;
      if (!pending || pending.requestId !== reserved.requestId) {
        // The provider's `refunded` webhook recorded this refund in the meantime.
        return toPaymentSummary(locked);
      }

      if (result.status === 'pending') {
        // The provider confirms asynchronously; the `refunded` webhook completes the transition.
        const updated = await tx.payment.update({
          where: { id: paymentId },
          data: {
            updatedAt: now,
            meta: withInternalMeta(locked.meta, {
              pendingRefund: {
                ...pending,
                state: 'awaiting_provider',
                refundRef: result.refundRef,
              },
            }),
          },
        });
        await this.audit.audit(
          {
            actor: request.actor,
            action: 'payment.refund_requested',
            entityType: 'payment',
            entityId: paymentId,
            before,
            after: {
              ...before,
              pendingRefundKopecks: pending.kopecks,
              refundRef: result.refundRef,
            },
            reason: request.reason,
            ip: request.ip ?? null,
          },
          tx,
        );
        return toPaymentSummary(updated);
      }

      const freshPlan = planRefund(locked, pending.kopecks);
      const record: RefundRecord = {
        refundRef: result.refundRef,
        kopecks: freshPlan.refundKopecks,
        reason: pending.reason,
        source: request.actor.type === 'system' ? 'system' : 'admin',
        actorId: request.actor.id ?? null,
        at: now.toISOString(),
      };
      const updated = await this.persistTransition(tx, locked, freshPlan.nextStatus, {
        status: freshPlan.nextStatus,
        refundedKopecks: freshPlan.refundedKopecks,
        updatedAt: now,
        meta: withInternalMeta(locked.meta, {
          refunds: [...(internalMeta(locked.meta).refunds ?? []), record],
          pendingRefund: null,
        }),
      });
      await this.publishStatusEvent(tx, updated);
      await this.audit.audit(
        {
          actor: request.actor,
          action: 'payment.refund',
          entityType: 'payment',
          entityId: paymentId,
          before,
          after: {
            status: updated.status,
            refundedKopecks: updated.refundedKopecks,
            refundKopecks: freshPlan.refundKopecks,
            refundRef: result.refundRef,
          },
          reason: request.reason,
          ip: request.ip ?? null,
        },
        tx,
      );
      this.logger.log(
        `Payment ${paymentId}: refunded ${freshPlan.refundKopecks} kopecks -> ${updated.status}`,
      );
      return toPaymentSummary(updated);
    });
  }

  /** Handler of the `auto-refund` job: performs a refund queued through `requestRefund`. */
  async runAutoRefund(paymentId: string): Promise<AutoRefundOutcome> {
    const row = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!row) {
      return { kind: 'skipped', paymentId, reason: 'not_found' };
    }
    const auto = internalMeta(row.meta).autoRefund;
    if (!auto || auto.state !== 'queued') {
      return { kind: 'skipped', paymentId, reason: auto ? `state_${auto.state}` : 'not_requested' };
    }
    if (!isRefundableStatus(row.status) || row.amountKopecks - row.refundedKopecks <= 0) {
      await this.mergeInternalMeta(paymentId, {
        autoRefund: {
          ...auto,
          state: 'skipped',
          completedAt: this.clock.now().toISOString(),
          detail: `status ${row.status}`,
        },
      });
      return { kind: 'skipped', paymentId, reason: `status_${row.status}` };
    }
    const actor: ActorRef = { type: 'system', id: `auto-refund:${auto.source}` };
    const summary = await this.refund(paymentId, {
      amountKopecks: auto.amountKopecks,
      reason: `auto refund (${auto.source}: ${auto.reason})`,
      actor,
      requestId: `auto-refund:${paymentId}`,
    });
    await this.mergeInternalMeta(paymentId, {
      autoRefund: {
        ...auto,
        state: 'done',
        completedAt: this.clock.now().toISOString(),
        detail: summary.status,
      },
    });
    return { kind: 'refunded', paymentId, status: summary.status };
  }

  /** Automatic refunds still `queued` (their job may have been lost); the hourly job re-queues them. */
  async findQueuedAutoRefunds(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM payments
      WHERE status IN ('succeeded', 'fiscalized', 'partially_refunded')
        AND meta #>> '{_internal,autoRefund,state}' = 'queued'
      ORDER BY updated_at ASC
      LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  // --- reconciliation --------------------------------------------------------------------------

  /** Ids of open payments created before `olderThan`, oldest first. */
  async findStaleOpenPayments(olderThan: Date, limit: number): Promise<string[]> {
    const rows = await this.prisma.payment.findMany({
      where: { status: { in: ['created', 'pending'] }, createdAt: { lt: olderThan } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async lookupAtProvider(row: Pick<Payment, 'provider' | 'providerRef'>): Promise<ProviderLookup> {
    const provider = this.providers.tryGet(row.provider);
    if (!provider) {
      return { kind: 'unavailable', error: `no adapter for provider ${row.provider}` };
    }
    if (!row.providerRef) {
      return { kind: 'not_found' };
    }
    try {
      const event = await provider.getStatus(row.providerRef);
      return event ? { kind: 'event', event } : { kind: 'not_found' };
    } catch (error) {
      return { kind: 'unavailable', error: messageOf(error) };
    }
  }

  /** Cancels the hosted checkout before a local expiry (no checkout reference: nothing to cancel). */
  async cancelAtProvider(
    row: Pick<Payment, 'provider' | 'providerRef'>,
  ): Promise<ProviderCancelLookup> {
    if (!row.providerRef) {
      return { kind: 'not_found' };
    }
    const provider = this.providers.tryGet(row.provider);
    if (!provider) {
      return { kind: 'unavailable', error: `no adapter for provider ${row.provider}` };
    }
    try {
      return await provider.cancelCheckout(row.providerRef);
    } catch (error) {
      return { kind: 'unavailable', error: messageOf(error) };
    }
  }

  /**
   * Reconciles one open payment with its provider (brief section 9). `force` ignores the
   * pending timeout (admin tool, a retried checkout); the hourly job only passes payments that
   * are old enough. Before a local expiry the checkout is cancelled at the provider; the
   * payment expires only when the provider confirms the cancellation or does not know it.
   */
  async reconcilePayment(
    paymentId: string,
    options: { force?: boolean; actor?: ActorRef; ip?: string | null } = {},
  ): Promise<ReconcileOutcome> {
    const row = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!row) {
      throw this.notFound(paymentId);
    }
    const summary = toPaymentSummary(row);
    if (!isOpenStatus(row.status)) {
      return { action: 'skipped', reason: 'not_open', payment: summary };
    }
    const now = this.clock.now();
    const subject = {
      id: row.id,
      status: row.status,
      providerRef: row.providerRef,
      createdAt: row.createdAt,
    };
    const timeout = options.force ? 0 : this.config.PAYMENTS_PENDING_TIMEOUT_MINUTES;
    if (paymentAgeMinutes(subject, now) < timeout) {
      return { action: 'skipped', reason: 'too_young', payment: summary };
    }
    const lookup = row.providerRef ? await this.lookupAtProvider(row) : null;
    const decision: ReconcileDecision = decideReconciliation(subject, lookup, now, timeout);

    let result: ReconcileOutcome;
    if (decision.action === 'skip') {
      result = { action: 'skipped', reason: decision.reason, payment: summary };
    } else if (decision.action === 'apply') {
      const outcome = await this.applyProviderEvent(paymentId, decision.event, 'reconcile');
      result = { action: 'applied', outcome, payment: outcome.payment };
    } else {
      const next = decideAfterCancel(await this.cancelAtProvider(row));
      if (next.action === 'skip') {
        result = { action: 'skipped', reason: next.reason, payment: summary };
      } else if (next.action === 'apply') {
        const outcome = await this.applyProviderEvent(paymentId, next.event, 'reconcile');
        result = { action: 'applied', outcome, payment: outcome.payment };
      } else {
        const outcome = await this.applyProviderEvent(
          paymentId,
          expirationEvent(subject, now, decision.reason),
          'reconcile',
        );
        result = { action: 'expired', outcome, payment: outcome.payment };
      }
    }

    if (options.actor) {
      await this.audit.audit({
        actor: options.actor,
        action: 'payment.reconcile',
        entityType: 'payment',
        entityId: paymentId,
        before: { status: row.status },
        after: {
          status: result.payment.status,
          action: result.action,
          detail: 'outcome' in result ? describeOutcome(result.outcome) : result.reason,
        },
        ip: options.ip ?? null,
      });
    }
    return result;
  }

  // --- attempts (createPayment) ----------------------------------------------------------------

  /** Decides whether an existing attempt is handed out again; null means "try the next attempt". */
  private async reuseAttempt(
    row: Payment,
    valid: ValidatedCreatePaymentInput,
  ): Promise<PaymentSummary | null> {
    if (row.amountKopecks !== valid.amountKopecks || row.userId !== valid.userId) {
      this.logger.warn(
        `createPayment replay for key "${row.idempotencyKey}" differs from the stored payment ${row.id}`,
      );
    }
    if (isSettledStatus(row.status)) {
      return toPaymentSummary(row);
    }
    if (!isOpenStatus(row.status)) {
      // failed, cancelled, expired or refunded: the customer may try again.
      return null;
    }
    const now = this.clock.now();
    if (!row.checkoutUrl) {
      if (isCheckoutStuck(row, now)) {
        await this.abandonAttempt(row.id, 'checkout_not_created');
        return null;
      }
      return this.awaitCheckout(row);
    }
    if (isCheckoutExpired(internalMeta(row.meta).checkoutExpiresAt, now)) {
      // The hosted page no longer accepts the payment: settle it with the provider first.
      const outcome = await this.reconcilePayment(row.id, { force: true });
      return isReusableStatus(outcome.payment.status) ? outcome.payment : null;
    }
    return toPaymentSummary(row);
  }

  /** A concurrent request is opening the checkout of this attempt: wait briefly for its URL. */
  private async awaitCheckout(row: Payment): Promise<PaymentSummary | null> {
    let current: Payment = row;
    for (let step = 0; step < CHECKOUT_WAIT_STEPS; step += 1) {
      await this.sleep(CHECKOUT_WAIT_STEP_MS);
      const reread = await this.prisma.payment.findUnique({ where: { id: row.id } });
      if (!reread) {
        return null;
      }
      current = reread;
      if (current.checkoutUrl || !isOpenStatus(current.status)) {
        break;
      }
    }
    return isReusableStatus(current.status) ? toPaymentSummary(current) : null;
  }

  /** Overridable in tests; real time on purpose (a short pause while another request works). */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Commits the attempt row (own transaction) with `payment.created`; null on a key collision. */
  private async insertAttempt(
    valid: ValidatedCreatePaymentInput,
    key: string,
    attempt: number,
  ): Promise<Payment | null> {
    const provider = this.providers.default;
    const now = this.clock.now();
    try {
      return await this.prisma.withTx(async (tx) => {
        const row = await tx.payment.create({
          data: {
            id: uuidv7(),
            userId: valid.userId,
            purpose: valid.purpose,
            amountKopecks: valid.amountKopecks,
            currency: PAYMENT_CURRENCY,
            provider: provider.name,
            providerRef: null,
            status: 'created',
            idempotencyKey: key,
            checkoutUrl: null,
            meta: buildInitialMeta(valid.meta, {
              description: valid.description,
              returnUrl: valid.returnUrl,
              baseKey: valid.idempotencyKey,
              attempt,
            }),
            createdAt: now,
            updatedAt: now,
          },
        });
        await this.outbox.publish(
          tx,
          buildOutboxEvent(
            PAYMENT_EVENTS.created,
            OUTBOX_AGGREGATES.payment,
            row.id,
            this.eventPayload(row),
          ),
        );
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return null;
      }
      throw error;
    }
  }

  /** Calls the provider outside any transaction, then stores the checkout under the row lock. */
  private async openCheckout(
    row: Payment,
    valid: ValidatedCreatePaymentInput,
  ): Promise<PaymentSummary> {
    const provider = this.providers.get(row.provider);
    let checkout: CheckoutSession;
    try {
      checkout = await provider.createCheckout({
        paymentId: row.id,
        userId: valid.userId,
        amountKopecks: valid.amountKopecks,
        currency: PAYMENT_CURRENCY,
        description: valid.description,
        returnUrl: valid.returnUrl ?? this.config.PAYMENTS_RETURN_URL,
        meta: valid.meta,
      });
    } catch (error) {
      try {
        await this.abandonAttempt(row.id, 'checkout_create_failed');
      } catch (abandonError) {
        this.logger.error(
          `Could not close payment ${row.id} after a failed checkout: ${messageOf(abandonError)}`,
        );
      }
      throw this.providerError(provider.name, 'createCheckout', error);
    }

    const updated = await this.prisma.withTx(async (tx) => {
      const locked = await this.lockPayment(tx, row.id);
      return tx.payment.update({
        where: { id: row.id },
        data: {
          ...(locked.providerRef ? {} : { providerRef: checkout.providerRef }),
          checkoutUrl: checkout.checkoutUrl,
          updatedAt: this.clock.now(),
          meta: withInternalMeta(locked.meta, {
            checkoutExpiresAt: checkout.expiresAt ? checkout.expiresAt.toISOString() : null,
          }),
        },
      });
    });
    return toPaymentSummary(updated);
  }

  /**
   * Closes an attempt that never got a usable checkout (`cancelled` with the reason as failure
   * code; audit-only event, the member saw the error in the app). Only an open attempt without
   * a checkout URL is touched.
   */
  private async abandonAttempt(paymentId: string, reason: string): Promise<void> {
    await this.prisma.withTx(async (tx) => {
      const locked = await this.lockPayment(tx, paymentId);
      if (!isOpenStatus(locked.status) || locked.checkoutUrl) {
        return;
      }
      const now = this.clock.now();
      const updated = await this.persistTransition(tx, locked, 'cancelled', {
        status: 'cancelled',
        failureCode: reason,
        updatedAt: now,
        meta: withInternalMeta(locked.meta, {
          lastEvent: { source: 'checkout', externalId: reason, at: now.toISOString() },
        }),
      });
      await this.publishStatusEvent(tx, updated);
      this.logger.warn(`Payment ${paymentId}: attempt closed (${reason})`);
    });
  }

  // --- internals -------------------------------------------------------------------------------

  private async lockPayment(tx: Tx, paymentId: string): Promise<Payment> {
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
    const row = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!row) {
      throw this.notFound(paymentId);
    }
    return row;
  }

  /** Merges `patch` into `_internal` under the row lock (optionally only in one status). */
  private async mergeInternalMeta(
    paymentId: string,
    patch: Partial<InternalMeta>,
    onlyInStatus?: PaymentStatus,
  ): Promise<void> {
    await this.prisma.withTx(async (tx) => {
      const locked = await this.lockPayment(tx, paymentId);
      if (onlyInStatus && locked.status !== onlyInStatus) {
        return;
      }
      await tx.payment.update({
        where: { id: paymentId },
        data: { meta: withInternalMeta(locked.meta, patch) },
      });
    });
  }

  /**
   * After a failed provider refund call: a definitive rejection (the adapter's DomainError)
   * releases the reservation; a transport error keeps it as `failed`, to be resumed with the
   * same request id (the provider de-duplicates it).
   */
  private async releaseOrMarkReservation(
    paymentId: string,
    requestId: string,
    error: unknown,
  ): Promise<void> {
    try {
      await this.prisma.withTx(async (tx) => {
        const locked = await this.lockPayment(tx, paymentId);
        const pending = internalMeta(locked.meta).pendingRefund ?? null;
        if (!pending || pending.requestId !== requestId) {
          return;
        }
        await tx.payment.update({
          where: { id: paymentId },
          data: {
            meta: withInternalMeta(locked.meta, {
              pendingRefund: DomainError.is(error)
                ? null
                : { ...pending, state: 'failed', lastError: messageOf(error) },
            }),
          },
        });
      });
    } catch (storeError) {
      this.logger.error(
        `Could not update the refund reservation of payment ${paymentId}: ${messageOf(storeError)}`,
      );
    }
  }

  /** Guarded update: the row must still be in `row.status`, otherwise a concurrent change won. */
  private async persistTransition(
    tx: Tx,
    row: Payment,
    to: PaymentStatus,
    data: Prisma.PaymentUpdateManyMutationInput,
  ): Promise<Payment> {
    assertTransition(row.status, to, row.id);
    const result = await tx.payment.updateMany({
      where: { id: row.id, status: row.status },
      data: { ...data, status: to },
    });
    if (result.count !== 1) {
      throw new DomainError(
        PaymentErrors.PC_PAYMENT_INVALID_TRANSITION,
        `Payment ${row.id} changed concurrently while moving to "${to}"`,
        { details: { paymentId: row.id, from: row.status, to } },
      );
    }
    const updated = await tx.payment.findUnique({ where: { id: row.id } });
    if (!updated) {
      throw this.notFound(row.id);
    }
    return updated;
  }

  private eventPayload(row: Payment): PaymentPayload {
    return {
      paymentId: row.id,
      userId: row.userId,
      purpose: row.purpose,
      amountKopecks: row.amountKopecks,
      provider: row.provider,
      providerRef: row.providerRef,
      status: row.status,
      meta: callerMeta(row.meta),
    };
  }

  private async publishStatusEvent(
    tx: Tx,
    row: Payment,
    options: { late?: boolean } = {},
  ): Promise<void> {
    const type = outboxTypeForStatus(row.status);
    if (!type) {
      return;
    }
    const base = this.eventPayload(row);
    const aggregate = OUTBOX_AGGREGATES.payment;
    switch (type) {
      case 'payment.succeeded':
        await this.outbox.publish(
          tx,
          buildOutboxEvent(PAYMENT_EVENTS.succeeded, aggregate, row.id, {
            ...base,
            paidAt: (row.paidAt ?? this.clock.now()).toISOString(),
            ...(options.late ? { late: true } : {}),
          }),
        );
        return;
      case 'payment.failed':
        await this.outbox.publish(
          tx,
          buildOutboxEvent(PAYMENT_EVENTS.failed, aggregate, row.id, {
            ...base,
            failureCode: row.failureCode,
          }),
        );
        return;
      case 'payment.cancelled':
        await this.outbox.publish(
          tx,
          buildOutboxEvent(PAYMENT_EVENTS.cancelled, aggregate, row.id, base),
        );
        return;
      case 'payment.expired':
        await this.outbox.publish(
          tx,
          buildOutboxEvent(PAYMENT_EVENTS.expired, aggregate, row.id, base),
        );
        return;
      case 'payment.refunded':
        await this.outbox.publish(
          tx,
          buildOutboxEvent(PAYMENT_EVENTS.refunded, aggregate, row.id, {
            ...base,
            refundedKopecks: row.refundedKopecks,
            partial: row.status === 'partially_refunded',
          }),
        );
        return;
      case 'payment.fiscalized':
        await this.outbox.publish(
          tx,
          buildOutboxEvent(PAYMENT_EVENTS.fiscalized, aggregate, row.id, {
            ...base,
            fiscalReceiptUrl: row.fiscalReceiptUrl,
          }),
        );
        return;
    }
  }

  private notFound(paymentId: string): DomainError {
    return new DomainError(PaymentErrors.PC_PAYMENT_NOT_FOUND, `Payment ${paymentId} not found`, {
      details: { paymentId },
    });
  }

  private providerError(provider: string, operation: string, error: unknown): DomainError {
    if (DomainError.is(error)) {
      return error;
    }
    this.logger.error(`Provider ${provider} failed on ${operation}: ${messageOf(error)}`);
    return new DomainError(
      PaymentErrors.PC_PAYMENT_PROVIDER_ERROR,
      `Payment provider ${provider} failed on ${operation}`,
      { cause: error, details: { provider, operation } },
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
