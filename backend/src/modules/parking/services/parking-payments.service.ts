import { Inject, Injectable, Logger } from '@nestjs/common';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import type {
  ParkingPaymentOpsAlertPayload,
  PaymentSucceededPayload,
} from '../../../common/contracts/events';
import type { ParkingChargeLine } from '../../../common/contracts/parking';
import {
  type AutoRefundResult,
  PAYMENTS_PORT,
  type PaymentSummary,
  type PaymentsPort,
} from '../../../common/contracts/payments';
import { DomainError } from '../../../common/errors/domain-error';
import { formatUah } from '../../../common/money/money';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { PrismaService, type Tx } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { formatKyiv } from '../../../common/time/kyiv';
import { ParkingErrors } from '../domain/errors';
import { PAID_PAYMENT_STATUSES } from '../domain/history';
import { payCharge } from '../domain/pay-charge';
import { paymentOpsAlertEvent } from '../domain/parking-events';
import { formatPlate } from '../domain/plate';
import { isFinalStatus } from '../domain/session-state';
import { type SessionRecord, buildSessionView } from '../domain/session-view';
import { HOUR_MS, MINUTE_MS, quote } from '../domain/tariff';
import { PARKING_CONFIG, type ParkingConfig } from '../parking.config';
import { ParkingProviderPort } from '../provider/parking-provider.port';
import { SessionSyncService } from './session-sync.service';
import { TariffService } from './tariff.service';

/** POST /parking/session/:id/pay result: the payment to open plus what it buys. */
export interface ParkingPaymentView {
  sessionId: string;
  amountKopecks: number;
  /** Exit deadline the payment buys (end of the running hour, or of the next one). */
  paidUntil: Date;
  /** The running hour ends in less than PARKING_PAY_MIN_MINUTES_LEFT: the next hour is included. */
  includesNextHour: boolean;
  breakdown: ParkingChargeLine[];
  payment: PaymentSummary;
}

/** Why a succeeded app payment cannot be used by its session. */
export type UnusableReason =
  'session_not_found' | 'session_closed' | 'session_closed_unpaid' | 'already_paid';

export type PaymentApplication =
  | { action: 'applied' | 'duplicate'; sessionId: string; status: string; paidUntil: Date | null }
  | {
      action: 'refund_queued';
      reason: UnusableReason;
      sessionId: string | null;
      refund: AutoRefundResult['outcome'];
    }
  | { action: 'alerted'; reason: UnusableReason; sessionId: string }
  | { action: 'ignored'; reason: string; sessionId: string | null };

/** Values of ParkingPaymentLink.outcome. */
export const LINK_OUTCOMES = {
  applied: 'applied',
  refundQueued: 'refund_queued',
  alerted: 'alerted',
} as const;

export interface ParkingPaymentsSweepSummary {
  checked: number;
  applied: number;
  refunds: number;
  alerts: number;
  skipped: number;
  failed: number;
  webhookLogsPurged: number;
}

/** The sweep looks back this far (links older than this are left to support). */
export const PAYMENT_SWEEP_WINDOW_HOURS = 48;
/** ...and leaves the newest links to the outbox consumer for a while. */
export const PAYMENT_SWEEP_GRACE_MS = 2 * MINUTE_MS;

interface LinkRow {
  sessionId: string;
  paymentId: string;
  paidUntil: Date | null;
  outcome: string | null;
  outcomeAt: Date | null;
  registeredAt: Date | null;
  createdAt: Date;
}

function readMeta(meta: Record<string, unknown>): {
  sessionId: string | null;
  paidUntil: Date | null;
} {
  const sessionId = typeof meta['sessionId'] === 'string' ? meta['sessionId'] : null;
  const rawPaidUntil = typeof meta['paidUntil'] === 'string' ? new Date(meta['paidUntil']) : null;
  const paidUntil = rawPaidUntil && !Number.isNaN(rawPaidUntil.getTime()) ? rawPaidUntil : null;
  return { sessionId, paidUntil };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Paying a parking session in the app (brief section 8): the amount is re-read from the operator
 * right before the payment, the payment is created through PAYMENTS_PORT (in its own committed
 * transaction; never inside ours) with a key derived from (session, paid period) and linked to
 * the session afterwards; `payment.succeeded` (outbox, queue parking-events, long retry policy)
 * marks the session paid and tells the operator to open the barrier. A payment the session can
 * no longer use (closed session, hour already paid by another attempt) is refunded automatically
 * and reported as an ops alert; the 5-minute sweep re-registers paid payments the operator has
 * not accepted yet.
 */
@Injectable()
export class ParkingPaymentsService {
  private readonly logger = new Logger(ParkingPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly sync: SessionSyncService,
    private readonly tariffs: TariffService,
    private readonly provider: ParkingProviderPort,
    private readonly outbox: OutboxService,
    @Inject(PAYMENTS_PORT) private readonly payments: PaymentsPort,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
    @Inject(PARKING_CONFIG) private readonly config: ParkingConfig,
  ) {}

  async pay(userId: string, sessionId: string): Promise<ParkingPaymentView> {
    let record: SessionRecord | null = await this.prisma.parkingSession.findFirst({
      where: { id: sessionId, userId },
    });
    if (!record) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_SESSION_NOT_FOUND,
        'Parking session not found',
        {
          details: { sessionId },
        },
      );
    }
    if (record.source !== 'provider') {
      throw new DomainError(
        ParkingErrors.PC_PARKING_INVALID_TRANSITION,
        'Info-mode timers are paid at the paymat; use paid-at-paymat',
        { details: { sessionId, source: record.source } },
      );
    }
    if (record.disputedAt) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_INVALID_TRANSITION,
        'The session was disputed; support will contact you',
        { details: { sessionId, reason: 'disputed' } },
      );
    }
    this.assertOpen(record);
    if (record.vehicleId) {
      const vehicle = await this.prisma.vehicle.findFirst({
        where: { id: record.vehicleId, deletedAt: null },
      });
      if (!vehicle || !vehicle.verified) {
        throw new DomainError(
          ParkingErrors.PC_PARKING_VEHICLE_NOT_VERIFIED,
          'Verify the vehicle with a talon or paymat code before paying in the app',
          { details: { vehicleId: record.vehicleId } },
        );
      }
    }

    // The amount comes from the operator's facts, re-read before paying (design brief 4.1).
    try {
      record = await this.sync.refresh(record);
    } catch (error) {
      throw DomainError.is(error)
        ? error
        : new DomainError(
            ParkingErrors.PC_PARKING_PROVIDER_UNAVAILABLE,
            'The parking operator is unavailable; pay at the paymat',
            { cause: error },
          );
    }
    this.assertOpen(record);

    const now = this.clock.now();
    const { config: tariff } = await this.tariffs.getActiveTariff(now);
    const view = buildSessionView(record, { now, tariff });
    const charge = payCharge(
      {
        amountDueKopecks: view.amountDueKopecks,
        currentHourEndsAt: view.currentHourEndsAt,
        breakdown: view.breakdown,
      },
      now,
      tariff,
      this.config.PARKING_PAY_MIN_MINUTES_LEFT,
    );
    if (!charge) {
      throw new DomainError(ParkingErrors.PC_PARKING_NOTHING_DUE, 'Nothing is due right now', {
        details: {
          sessionId,
          status: view.status,
          paidUntil: view.paidUntil ? view.paidUntil.toISOString() : null,
          freeUntil: view.freeUntil.toISOString(),
        },
      });
    }

    const paidUntil = charge.paidUntil;
    const plateDisplay = record.plate ? formatPlate(record.plate) : null;
    // Not inside a transaction: the payments module commits the attempt itself and calls the
    // provider outside any transaction; the link is written right after.
    const payment = await this.payments.createPayment({
      userId,
      purpose: 'parking',
      amountKopecks: charge.amountKopecks,
      idempotencyKey: `parking:${record.id}:${paidUntil.toISOString()}`,
      description: `Паркінг Порт City, ${plateDisplay ?? 'талон'}, виїзд до ${formatKyiv(paidUntil, 'HH:mm')}, ${formatUah(charge.amountKopecks, { fraction: 'auto' })}`,
      meta: {
        sessionId: record.id,
        paidUntil: paidUntil.toISOString(),
        plate: record.plate ?? null,
        plateDisplay,
        providerRef: record.providerRef ?? null,
        includesNextHour: charge.includesNextHour,
      },
      ...(this.config.PARKING_PAYMENT_RETURN_URL
        ? { returnUrl: this.config.PARKING_PAYMENT_RETURN_URL }
        : {}),
    });
    await this.linkPayment(record.id, payment.id, paidUntil);

    return {
      sessionId: record.id,
      amountKopecks: charge.amountKopecks,
      paidUntil,
      includesNextHour: charge.includesNextHour,
      breakdown: charge.breakdown,
      payment,
    };
  }

  /**
   * Consumer of `payment.succeeded` for parking payments (also replayed by the sweep).
   * Idempotent: the link's `outcome` is claimed under the session row lock, the paid period is
   * merged monotonically and the paid amount is recomputed from the kept payments, so a
   * redelivery changes nothing and publishes nothing. A payment the session cannot use (no
   * session, closed session, the same hour already paid by another attempt) is refunded through
   * PAYMENTS_PORT.requestRefund and reported as `parking.payment.ops_alert`; a payment for a
   * `closed_unpaid` session is kept (it settles the disputed amount) and reported for review.
   * When the operator cannot be told about the payment the session is still marked paid and the
   * error is rethrown, so the long retry policy and the sweep repeat the registration.
   */
  async applyPaymentSucceeded(payload: PaymentSucceededPayload): Promise<PaymentApplication> {
    if (payload.purpose !== 'parking') {
      return { action: 'ignored', reason: 'not_a_parking_payment', sessionId: null };
    }
    const meta = readMeta(payload.meta ?? {});
    if (!meta.sessionId) {
      this.logger.warn(`payment.succeeded ${payload.paymentId} has no sessionId in meta`);
      return { action: 'ignored', reason: 'no_session_in_meta', sessionId: null };
    }
    const record = await this.prisma.parkingSession.findUnique({ where: { id: meta.sessionId } });
    if (!record) {
      this.logger.warn(
        `payment.succeeded ${payload.paymentId}: session ${meta.sessionId} not found`,
      );
      return this.refundWithoutSession(payload, meta.sessionId, meta.paidUntil);
    }
    await this.linkPayment(record.id, payload.paymentId, meta.paidUntil);
    const paidUntil = meta.paidUntil ?? (await this.fallbackPaidUntil(record, payload.paidAt));

    const claim = await this.claimOutcome(record.id, payload, paidUntil);
    if (claim.outcome === LINK_OUTCOMES.refundQueued) {
      return this.queueRefund(payload, claim.record, claim.reason, paidUntil, claim.fresh);
    }
    if (claim.outcome === LINK_OUTCOMES.alerted) {
      return {
        action: 'alerted',
        reason: claim.reason ?? 'session_closed_unpaid',
        sessionId: record.id,
      };
    }

    let registrationError: Error | null = null;
    if (!claim.link.registeredAt) {
      registrationError = await this.registerWithOperator(claim.record, payload, paidUntil);
    }

    let current = claim.record;
    let changed = false;
    if (!isFinalStatus(current.status)) {
      const paidByApp = await this.sumPaidPayments(current.id);
      const result = await this.sync.updateFacts(
        current,
        (latest) => ({
          paidUntil:
            latest.paidUntil && latest.paidUntil.getTime() > paidUntil.getTime()
              ? latest.paidUntil
              : paidUntil,
          amountPaidKopecks: Math.max(latest.amountPaidKopecks, paidByApp),
        }),
        { paymentId: payload.paymentId },
      );
      current = result.record ?? current;
      changed = result.changed;
    }
    if (registrationError) {
      throw registrationError;
    }
    return {
      action: changed ? 'applied' : 'duplicate',
      sessionId: current.id,
      status: current.status,
      paidUntil: current.paidUntil,
    };
  }

  /**
   * Safety net for `payment.succeeded` (every 5 minutes): links of the last 48 h whose paid
   * payment was never applied, whose refund request was not confirmed, or that the operator has
   * not accepted yet are replayed through `applyPaymentSucceeded`. Also purges old operator
   * webhook ids.
   */
  async sweep(limit = 200): Promise<ParkingPaymentsSweepSummary> {
    const now = this.clock.now();
    const summary: ParkingPaymentsSweepSummary = {
      checked: 0,
      applied: 0,
      refunds: 0,
      alerts: 0,
      skipped: 0,
      failed: 0,
      webhookLogsPurged: 0,
    };
    const links = (await this.prisma.parkingPaymentLink.findMany({
      where: {
        createdAt: {
          gte: new Date(now.getTime() - PAYMENT_SWEEP_WINDOW_HOURS * HOUR_MS),
          lte: new Date(now.getTime() - PAYMENT_SWEEP_GRACE_MS),
        },
        OR: [
          { outcome: null },
          { outcome: LINK_OUTCOMES.applied, registeredAt: null },
          { outcome: LINK_OUTCOMES.refundQueued, outcomeAt: null },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    })) as LinkRow[];
    summary.checked = links.length;
    const payments = new Map(
      (await this.payments.getPayments(links.map((link) => link.paymentId))).map((payment) => [
        payment.id,
        payment,
      ]),
    );
    for (const link of links) {
      const payment = payments.get(link.paymentId);
      if (!payment || !PAID_PAYMENT_STATUSES.includes(payment.status)) {
        summary.skipped += 1;
        continue;
      }
      try {
        const outcome = await this.applyPaymentSucceeded({
          paymentId: payment.id,
          userId: payment.userId,
          purpose: payment.purpose,
          amountKopecks: payment.amountKopecks,
          provider: payment.provider,
          providerRef: payment.providerRef,
          status: payment.status,
          meta: payment.meta,
          paidAt: (payment.paidAt ?? now).toISOString(),
        });
        if (outcome.action === 'refund_queued') {
          summary.refunds += 1;
        } else if (outcome.action === 'alerted') {
          summary.alerts += 1;
        } else {
          summary.applied += 1;
        }
      } catch (error) {
        summary.failed += 1;
        this.logger.warn(
          `parking payments sweep: payment ${link.paymentId} of session ${link.sessionId} failed: ${messageOf(error)}`,
        );
      }
    }
    summary.webhookLogsPurged = await this.sync.purgeWebhookLogs();
    return summary;
  }

  /** Sum of the linked app payments the session keeps (refunded parts and refund-queued ones excluded). */
  async sumPaidPayments(sessionId: string): Promise<number> {
    const links = (await this.prisma.parkingPaymentLink.findMany({
      where: { sessionId },
    })) as LinkRow[];
    const kept = links.filter(
      (link) =>
        link.outcome !== LINK_OUTCOMES.refundQueued && link.outcome !== LINK_OUTCOMES.alerted,
    );
    const payments = await this.payments.getPayments(kept.map((link) => link.paymentId));
    return payments
      .filter((payment) => PAID_PAYMENT_STATUSES.includes(payment.status))
      .reduce(
        (total, payment) => total + payment.amountKopecks - (payment.refundedKopecks ?? 0),
        0,
      );
  }

  // --- internals --------------------------------------------------------------------------------

  /** Links a payment (attempt) to the session; keeps the paid period it buys. Idempotent. */
  private async linkPayment(
    sessionId: string,
    paymentId: string,
    paidUntil: Date | null,
  ): Promise<void> {
    await this.prisma.parkingPaymentLink.upsert({
      where: { sessionId_paymentId: { sessionId, paymentId } },
      create: { sessionId, paymentId, paidUntil, createdAt: this.clock.now() },
      update: {},
    });
    if (paidUntil) {
      await this.prisma.parkingPaymentLink.updateMany({
        where: { sessionId, paymentId, paidUntil: null },
        data: { paidUntil },
      });
    }
  }

  /**
   * Decides once per payment, under the session row lock, what the session does with it, so two
   * attempts for the same hour succeeding at the same time cannot both be applied.
   */
  private async claimOutcome(
    sessionId: string,
    payload: PaymentSucceededPayload,
    paidUntil: Date,
  ): Promise<{
    outcome: string;
    reason: UnusableReason | null;
    record: SessionRecord;
    link: LinkRow;
    /** True when this call made the decision (false for a redelivery). */
    fresh: boolean;
  }> {
    const paymentId = payload.paymentId;
    return this.prisma.withTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM parking_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`;
      const record = (await tx.parkingSession.findUnique({
        where: { id: sessionId },
      })) as SessionRecord;
      const link = (await tx.parkingPaymentLink.findUnique({
        where: { sessionId_paymentId: { sessionId, paymentId } },
      })) as LinkRow;
      if (link.outcome) {
        const reason =
          link.outcome === LINK_OUTCOMES.applied
            ? null
            : this.unusableReason(record, [], paidUntil);
        return { outcome: link.outcome, reason, record, link, fresh: false };
      }
      const others = (await tx.parkingPaymentLink.findMany({
        where: { sessionId, outcome: LINK_OUTCOMES.applied },
      })) as LinkRow[];
      const reason = this.unusableReason(
        record,
        others.filter((other) => other.paymentId !== paymentId),
        paidUntil,
      );
      const now = this.clock.now();
      if (!reason) {
        const updated = await this.setOutcome(tx, link, LINK_OUTCOMES.applied, now);
        return { outcome: LINK_OUTCOMES.applied, reason: null, record, link: updated, fresh: true };
      }
      if (reason === 'session_closed_unpaid') {
        // The money settles the disputed amount: kept, reported for the operator's reconciliation.
        const updated = await this.setOutcome(tx, link, LINK_OUTCOMES.alerted, now);
        await this.publishAlert(
          tx,
          this.alertPayload('manual_review', reason, record.id, record.userId, paidUntil, null, {
            paymentId,
            userId: payload.userId,
            amountKopecks: payload.amountKopecks,
            late: payload.late === true,
          }),
        );
        return { outcome: LINK_OUTCOMES.alerted, reason, record, link: updated, fresh: true };
      }
      // outcomeAt stays null until PAYMENTS_PORT confirms the refund request (the sweep retries).
      const updated = await this.setOutcome(tx, link, LINK_OUTCOMES.refundQueued, null);
      return { outcome: LINK_OUTCOMES.refundQueued, reason, record, link: updated, fresh: true };
    });
  }

  private unusableReason(
    record: SessionRecord,
    appliedOthers: LinkRow[],
    paidUntil: Date,
  ): UnusableReason | null {
    if (record.status === 'closed_unpaid') {
      return 'session_closed_unpaid';
    }
    if (isFinalStatus(record.status)) {
      return 'session_closed';
    }
    const covered = appliedOthers.some(
      (other) => other.paidUntil !== null && other.paidUntil.getTime() >= paidUntil.getTime(),
    );
    return covered ? 'already_paid' : null;
  }

  private async setOutcome(
    tx: Tx,
    link: LinkRow,
    outcome: string,
    outcomeAt: Date | null,
  ): Promise<LinkRow> {
    return tx.parkingPaymentLink.update({
      where: { sessionId_paymentId: { sessionId: link.sessionId, paymentId: link.paymentId } },
      data: { outcome, outcomeAt },
    });
  }

  /** Requests the automatic refund (idempotent) and reports it once. */
  private async queueRefund(
    payload: PaymentSucceededPayload,
    record: SessionRecord,
    reason: UnusableReason | null,
    paidUntil: Date,
    fresh: boolean,
  ): Promise<PaymentApplication> {
    const why = reason ?? 'already_paid';
    const refund = await this.payments.requestRefund({
      paymentId: payload.paymentId,
      reason: why,
      source: 'parking',
    });
    await this.prisma.withTx(async (tx) => {
      await tx.parkingPaymentLink.updateMany({
        where: { sessionId: record.id, paymentId: payload.paymentId, outcomeAt: null },
        data: { outcomeAt: this.clock.now() },
      });
      if (fresh || refund.outcome === 'queued') {
        await this.publishAlert(
          tx,
          this.alertPayload(
            'refund_queued',
            why,
            record.id,
            record.userId,
            paidUntil,
            refund.outcome,
            {
              paymentId: payload.paymentId,
              userId: payload.userId,
              amountKopecks: payload.amountKopecks,
              late: payload.late === true,
            },
          ),
        );
      }
    });
    return { action: 'refund_queued', reason: why, sessionId: record.id, refund: refund.outcome };
  }

  private async refundWithoutSession(
    payload: PaymentSucceededPayload,
    sessionId: string,
    paidUntil: Date | null,
  ): Promise<PaymentApplication> {
    const refund = await this.payments.requestRefund({
      paymentId: payload.paymentId,
      reason: 'session_not_found',
      source: 'parking',
    });
    if (refund.outcome === 'queued') {
      await this.prisma.withTx((tx) =>
        this.publishAlert(
          tx,
          this.alertPayload(
            'refund_queued',
            'session_not_found',
            null,
            null,
            paidUntil,
            refund.outcome,
            {
              paymentId: payload.paymentId,
              userId: payload.userId,
              amountKopecks: payload.amountKopecks,
              late: payload.late === true,
            },
          ),
        ),
      );
    }
    return {
      action: 'refund_queued',
      reason: 'session_not_found',
      sessionId,
      refund: refund.outcome,
    };
  }

  private alertPayload(
    alert: ParkingPaymentOpsAlertPayload['alert'],
    reason: UnusableReason,
    sessionId: string | null,
    sessionUserId: string | null,
    paidUntil: Date | null,
    refund: ParkingPaymentOpsAlertPayload['refund'],
    payment: { paymentId: string; userId?: string; amountKopecks?: number; late?: boolean },
  ): ParkingPaymentOpsAlertPayload {
    return {
      alert,
      reason,
      paymentId: payment.paymentId,
      sessionId,
      userId: payment.userId ?? sessionUserId ?? '',
      amountKopecks: payment.amountKopecks ?? 0,
      late: payment.late ?? false,
      paidUntil: paidUntil ? paidUntil.toISOString() : null,
      refund,
    };
  }

  /** Ops alert: outbox event + audit entry in the caller's transaction, and an error log. */
  private async publishAlert(tx: Tx, payload: ParkingPaymentOpsAlertPayload): Promise<void> {
    await this.outbox.publish(tx, paymentOpsAlertEvent(payload, this.clock.now()));
    await this.audit.audit(
      {
        actor: { type: 'system', id: 'parking-payments' },
        action: 'parking_payment.ops_alert',
        entityType: 'payment',
        entityId: payload.paymentId,
        after: payload,
        reason: `${payload.alert}: ${payload.reason}`,
      },
      tx,
    );
    this.logger.error(
      `Ops alert (${payload.alert}) for payment ${payload.paymentId}, session ${payload.sessionId ?? '-'}: ${payload.reason}${payload.late ? ' (late success)' : ''}`,
    );
  }

  /** Tells the operator (barrier until paidUntil); returns the error instead of throwing. */
  private async registerWithOperator(
    record: SessionRecord,
    payload: PaymentSucceededPayload,
    paidUntil: Date,
  ): Promise<Error | null> {
    if (record.source === 'provider' && record.providerRef) {
      try {
        await this.provider.registerPayment({
          providerRef: record.providerRef,
          paymentId: payload.paymentId,
          amountKopecks: payload.amountKopecks,
          paidUntil,
        });
      } catch (error) {
        this.logger.warn(
          `Operator did not accept payment ${payload.paymentId} for session ${record.id}: ${messageOf(error)}`,
        );
        return error instanceof Error ? error : new Error(String(error));
      }
    }
    // Nothing to register for sessions without an operator reference.
    await this.prisma.parkingPaymentLink.updateMany({
      where: { sessionId: record.id, paymentId: payload.paymentId, registeredAt: null },
      data: { registeredAt: this.clock.now() },
    });
    return null;
  }

  private async fallbackPaidUntil(record: SessionRecord, paidAtIso: string): Promise<Date> {
    const paidAt = new Date(paidAtIso);
    const at = Number.isNaN(paidAt.getTime()) ? this.clock.now() : paidAt;
    const { config } = await this.tariffs.getActiveTariff(at);
    return quote(record.enteredAt, at, config, record.paidUntil).currentHourEndsAt;
  }

  private assertOpen(record: SessionRecord): void {
    if (isFinalStatus(record.status)) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_INVALID_TRANSITION,
        'The parking session is already closed',
        { details: { sessionId: record.id, status: record.status } },
      );
    }
  }
}
