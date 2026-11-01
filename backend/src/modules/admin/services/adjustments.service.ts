import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ManualAdjustment, Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import {
  ADMIN_AUDIT_PORT,
  type AdminAuditPort,
  type ManualAdjustmentStatus,
} from '../../../common/contracts/admin';
import {
  CLUB_LEDGER_PORT,
  type ClubLedgerPort,
  type LedgerEntry,
} from '../../../common/contracts/club';
import {
  ADMIN_EVENTS,
  type AdjustmentPayload,
  OUTBOX_AGGREGATES,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import type { ActorRef } from '../../../common/contracts/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { type DbClient, PrismaService, type Tx } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { startOfKyivDay } from '../../../common/time/kyiv';
import {
  ACCOUNT_SELF_APPROVAL_WINDOW_MS,
  type AdjustmentRequestPlan,
  type SelfApprovedTotals,
  adjustmentIdempotencyKey,
  assertAdjustmentAmount,
  assertCanApply,
  assertCanApprove,
  assertCanReject,
  assertTransition,
  isSecondApprovalReason,
  ledgerOperationFor,
  needsSecondApproval,
  planAdjustmentRequest,
  sumAbsolutePoints,
} from '../domain/adjustment-rules';
import { AdminErrors } from '../domain/errors';
import { LIST_ORDER, cursorOf, isListCursor, keysetWhere } from '../domain/list-cursor';
import type { AdjustmentView, AdminActor } from '../domain/views';

const ENTITY_TYPE = 'manual_adjustment';

/**
 * `userId` is copied from CLUB_LEDGER_PORT.getBalance() when the adjustment is requested, so the
 * module never reads club's loyalty_accounts table (schema request admin-1).
 */
type AdjustmentRow = ManualAdjustment;

export interface RequestAdjustmentInput {
  userId: string;
  /** Signed points. */
  amount: number;
  reason: string;
}

export interface ListAdjustmentsFilter {
  status?: ManualAdjustmentStatus;
  userId?: string;
}

export interface ListQuery {
  cursor?: string;
  limit: number;
}

function actorRef(actor: AdminActor): ActorRef {
  return { type: 'admin', id: actor.id };
}

function payloadOf(row: AdjustmentRow): AdjustmentPayload {
  return {
    adjustmentId: row.id,
    accountId: row.accountId,
    userId: row.userId,
    amount: row.amount,
    reason: row.reason,
    requestedById: row.requestedById,
  };
}

function snapshot(row: AdjustmentRow): Record<string, unknown> {
  return {
    status: row.status,
    accountId: row.accountId,
    userId: row.userId,
    amount: row.amount,
    reason: row.reason,
    requestedById: row.requestedById,
    approvedById: row.approvedById,
    thresholdPoints: row.thresholdPoints,
    secondApprovalReason: row.secondApprovalReason,
    pointsTxId: row.pointsTxId,
  };
}

export function toAdjustmentView(row: AdjustmentRow): AdjustmentView {
  const stored = isSecondApprovalReason(row.secondApprovalReason) ? row.secondApprovalReason : null;
  // Rows written before second_approval_reason existed fall back to the single-amount rule.
  const reason = stored ?? (needsSecondApproval(row.amount, row.thresholdPoints) ? 'amount' : null);
  return {
    id: row.id,
    accountId: row.accountId,
    userId: row.userId,
    amount: row.amount,
    reason: row.reason,
    status: row.status,
    needsSecondApproval: reason !== null,
    secondApprovalReason: reason,
    thresholdPoints: row.thresholdPoints,
    requestedById: row.requestedById,
    approvedById: row.approvedById,
    pointsTxId: row.pointsTxId,
    rejectionReason: row.rejectionReason,
    decidedAt: row.decidedAt,
    appliedAt: row.appliedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Manual point adjustments with four-eyes approval (brief section 4).
 *
 * - `request`: the requester decides alone only while |amount| and the cumulative self-approved
 *   totals stay within the threshold: the requester's total of the current Kyiv day and the
 *   target account's total over the last 24 hours (any requester). Such a request is applied in
 *   the same transaction (rolled back entirely when the ledger refuses); everything else stays
 *   `pending` with `secondApprovalReason`. The totals are read under advisory locks per requester
 *   and per account, so parallel requests cannot both slip under the threshold.
 * - `approve`: a different admin approves (own transaction, audited, `adjustment.approved`),
 *   then the ledger write runs in a second transaction. When the ledger refuses (e.g.
 *   PC_POINTS_INSUFFICIENT for a debit) the row stays `approved` and `apply` retries later.
 * - Ledger writes are idempotent by `adjustment:<id>`; credits are `adjust` rows, debits go
 *   through `spend` and obey the club's balance and newcomer-lock rules.
 */
@Injectable()
export class AdjustmentsService {
  private readonly logger = new Logger(AdjustmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    @Inject(CLUB_LEDGER_PORT) private readonly ledger: ClubLedgerPort,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  async request(input: RequestAdjustmentInput, actor: AdminActor): Promise<AdjustmentView> {
    assertAdjustmentAmount(input.amount);
    const reason = input.reason.trim();
    const balance = await this.ledger.getBalance(input.userId);
    if (!balance) {
      throw new DomainError(
        AdminErrors.PC_ADJUSTMENT_ACCOUNT_NOT_FOUND,
        `User ${input.userId} has no loyalty account yet`,
        { details: { userId: input.userId } },
      );
    }
    const now = this.clock.now();
    const id = uuidv7();

    return this.prisma.withTx(async (tx) => {
      await this.lockSelfApprovalScope(tx, actor.id, balance.accountId);
      const selfApproved = await this.selfApprovedTotals(tx, actor.id, balance.accountId, now);
      const plan = planAdjustmentRequest({
        amount: input.amount,
        requestedById: actor.id,
        selfApproved,
      });
      this.reportEscalation(plan, input, actor, balance.accountId);
      const created = await tx.manualAdjustment.create({
        data: {
          id,
          accountId: balance.accountId,
          userId: input.userId,
          amount: input.amount,
          reason,
          requestedById: actor.id,
          approvedById: plan.approvedById,
          status: plan.initialStatus,
          thresholdPoints: plan.thresholdPoints,
          secondApprovalReason: plan.secondApprovalReason,
          decidedAt: plan.needsSecondApproval ? null : now,
          createdAt: now,
          updatedAt: now,
        },
      });
      await this.audit.audit(
        {
          actor: actorRef(actor),
          action: 'manual_adjustment.request',
          entityType: ENTITY_TYPE,
          entityId: id,
          after: { ...snapshot(created), selfApprovedTotals: plan.totals },
          reason,
          ip: actor.ip ?? null,
        },
        tx,
      );
      await this.outbox.publish(
        tx,
        buildOutboxEvent(
          ADMIN_EVENTS.adjustmentRequested,
          OUTBOX_AGGREGATES.manualAdjustment,
          id,
          { ...payloadOf(created), needsSecondApproval: plan.needsSecondApproval },
          now,
        ),
      );
      if (plan.needsSecondApproval) {
        return toAdjustmentView(created);
      }
      await this.outbox.publish(
        tx,
        buildOutboxEvent(
          ADMIN_EVENTS.adjustmentApproved,
          OUTBOX_AGGREGATES.manualAdjustment,
          id,
          { ...payloadOf(created), approvedById: actor.id },
          now,
        ),
      );
      const applied = await this.applyInTx(tx, created, actor, now);
      return toAdjustmentView(applied);
    });
  }

  async approve(id: string, actor: AdminActor): Promise<AdjustmentView> {
    const row = await this.findRow(this.prisma, id);
    let approved = row;
    if (row.status === 'pending') {
      assertCanApprove({
        adjustmentId: id,
        status: row.status,
        requestedById: row.requestedById,
        approverId: actor.id,
      });
      const now = this.clock.now();
      approved = await this.prisma.withTx(async (tx) => {
        const result = await tx.manualAdjustment.updateMany({
          where: { id, status: 'pending' },
          data: { status: 'approved', approvedById: actor.id, decidedAt: now, updatedAt: now },
        });
        const current = await this.findRow(tx, id);
        if (result.count === 0) {
          // Another admin decided in the meantime; report the real state.
          assertTransition(current.status, 'approved', id);
        }
        await this.audit.audit(
          {
            actor: actorRef(actor),
            action: 'manual_adjustment.approve',
            entityType: ENTITY_TYPE,
            entityId: id,
            before: { status: 'pending' },
            after: { status: 'approved', approvedById: actor.id },
            ip: actor.ip ?? null,
          },
          tx,
        );
        await this.outbox.publish(
          tx,
          buildOutboxEvent(
            ADMIN_EVENTS.adjustmentApproved,
            OUTBOX_AGGREGATES.manualAdjustment,
            id,
            { ...payloadOf(current), approvedById: actor.id },
            now,
          ),
        );
        return current;
      });
    } else {
      assertCanApply(id, row.status);
    }
    return this.applyApproved(approved, actor);
  }

  /** Retries the ledger write of an `approved` adjustment (after a refused first attempt). */
  async apply(id: string, actor: AdminActor): Promise<AdjustmentView> {
    const row = await this.findRow(this.prisma, id);
    assertCanApply(id, row.status);
    return this.applyApproved(row, actor);
  }

  async reject(id: string, reason: string, actor: AdminActor): Promise<AdjustmentView> {
    const row = await this.findRow(this.prisma, id);
    assertCanReject(id, row.status);
    const trimmed = reason.trim();
    const now = this.clock.now();
    const rejected = await this.prisma.withTx(async (tx) => {
      const result = await tx.manualAdjustment.updateMany({
        where: { id, status: { in: ['pending', 'approved'] } },
        data: { status: 'rejected', rejectionReason: trimmed, decidedAt: now, updatedAt: now },
      });
      const current = await this.findRow(tx, id);
      if (result.count === 0) {
        assertTransition(current.status, 'rejected', id);
      }
      await this.audit.audit(
        {
          actor: actorRef(actor),
          action: 'manual_adjustment.reject',
          entityType: ENTITY_TYPE,
          entityId: id,
          before: { status: row.status },
          after: { status: 'rejected', rejectionReason: trimmed },
          reason: trimmed,
          ip: actor.ip ?? null,
        },
        tx,
      );
      await this.outbox.publish(
        tx,
        buildOutboxEvent(
          ADMIN_EVENTS.adjustmentRejected,
          OUTBOX_AGGREGATES.manualAdjustment,
          id,
          { ...payloadOf(current), rejectedById: actor.id, rejectionReason: trimmed },
          now,
        ),
      );
      return current;
    });
    return toAdjustmentView(rejected);
  }

  async get(id: string): Promise<AdjustmentView> {
    return toAdjustmentView(await this.findRow(this.prisma, id));
  }

  async list(filter: ListAdjustmentsFilter, query: ListQuery): Promise<Page<AdjustmentView>> {
    const where: Prisma.ManualAdjustmentWhereInput = {};
    if (filter.status) {
      where.status = filter.status;
    }
    if (filter.userId) {
      where.userId = filter.userId;
    }
    const cursor = decodeCursor(query.cursor, isListCursor);
    if (cursor) {
      where.AND = [keysetWhere(cursor)];
    }
    const rows = await this.prisma.manualAdjustment.findMany({
      where,
      orderBy: [...LIST_ORDER],
      take: query.limit + 1,
    });
    return toPage(rows.map(toAdjustmentView), query.limit, cursorOf);
  }

  /**
   * Serialises requests of the same requester and of the same target account until commit
   * (transaction-scoped advisory locks, always taken in this order, so no lock cycle exists).
   */
  private async lockSelfApprovalScope(
    tx: Tx,
    requesterId: string,
    accountId: string,
  ): Promise<void> {
    const requesterLock = `manual_adjustment:requester:${requesterId}`;
    const accountLock = `manual_adjustment:account:${accountId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${requesterLock}, 0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${accountLock}, 0))`;
  }

  /** Absolute self-approved points of the requester today (Kyiv) and of the account in 24 h. */
  private async selfApprovedTotals(
    tx: Tx,
    requesterId: string,
    accountId: string,
    now: Date,
  ): Promise<SelfApprovedTotals> {
    const selfApproved: Prisma.ManualAdjustmentWhereInput = {
      status: { in: ['approved', 'applied'] },
      secondApprovalReason: null,
    };
    const byRequester = await tx.manualAdjustment.findMany({
      where: {
        ...selfApproved,
        requestedById: requesterId,
        createdAt: { gte: startOfKyivDay(now) },
      },
      select: { amount: true },
    });
    const byAccount = await tx.manualAdjustment.findMany({
      where: {
        ...selfApproved,
        accountId,
        createdAt: { gte: new Date(now.getTime() - ACCOUNT_SELF_APPROVAL_WINDOW_MS) },
      },
      select: { amount: true },
    });
    return {
      requesterKyivDay: sumAbsolutePoints(byRequester),
      account24h: sumAbsolutePoints(byAccount),
    };
  }

  /**
   * A small request that needs a second admin only because of the cumulative totals looks like a
   * split of a large correction: warn so monitoring can alert on repeats (the audit row carries
   * the totals as well).
   */
  private reportEscalation(
    plan: AdjustmentRequestPlan,
    input: RequestAdjustmentInput,
    actor: AdminActor,
    accountId: string,
  ): void {
    if (plan.secondApprovalReason === null || plan.secondApprovalReason === 'amount') {
      return;
    }
    this.logger.warn(
      `FOUR_EYES_CUMULATIVE: adjustment of ${input.amount} points by admin ${actor.id} for account ${accountId} needs a second approval (${plan.secondApprovalReason}; requester today ${plan.totals.requesterKyivDay}, account 24 h ${plan.totals.account24h}, threshold ${plan.thresholdPoints})`,
    );
  }

  private async findRow(db: DbClient, id: string): Promise<AdjustmentRow> {
    const row = await db.manualAdjustment.findUnique({
      where: { id },
    });
    if (!row) {
      throw new DomainError(
        AdminErrors.PC_ADJUSTMENT_NOT_FOUND,
        `Manual adjustment ${id} does not exist`,
        { details: { adjustmentId: id } },
      );
    }
    return row;
  }

  private async applyApproved(row: AdjustmentRow, actor: AdminActor): Promise<AdjustmentView> {
    const now = this.clock.now();
    try {
      const applied = await this.prisma.withTx((tx) => this.applyInTx(tx, row, actor, now));
      return toAdjustmentView(applied);
    } catch (error) {
      if (DomainError.is(error) && error.code !== AdminErrors.PC_ADJUSTMENT_INVALID_TRANSITION) {
        this.logger.warn(
          `Manual adjustment ${row.id} is approved but could not be applied: ${error.code}`,
        );
        throw new DomainError(
          error.code,
          `Manual adjustment ${row.id} is approved but was not applied: ${error.message}. Retry with POST /admin/adjustments/${row.id}/apply or reject it.`,
          {
            status: error.status,
            title: error.title,
            details: {
              adjustmentId: row.id,
              adjustmentStatus: 'approved',
              cause: error.details ?? null,
            },
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  /** approved -> applied inside `tx`: ledger row, status, audit, `adjustment.applied`. */
  private async applyInTx(
    tx: Tx,
    row: AdjustmentRow,
    actor: AdminActor,
    now: Date,
  ): Promise<AdjustmentRow> {
    // Serialises concurrent approve/apply calls on the same adjustment.
    await tx.$queryRaw`SELECT id FROM manual_adjustments WHERE id = ${row.id}::uuid FOR UPDATE`;
    const fresh = await this.findRow(tx, row.id);
    if (fresh.status === 'applied') {
      return fresh;
    }
    assertCanApply(fresh.id, fresh.status);
    const entry = await this.writeLedger(fresh, actor, tx);
    const applied = await tx.manualAdjustment.update({
      where: { id: fresh.id },
      data: { status: 'applied', pointsTxId: entry.id, appliedAt: now, updatedAt: now },
    });
    await this.audit.audit(
      {
        actor: actorRef(actor),
        action: 'manual_adjustment.apply',
        entityType: ENTITY_TYPE,
        entityId: fresh.id,
        before: { status: fresh.status },
        after: { status: 'applied', pointsTxId: entry.id, appliedAt: now.toISOString() },
        ip: actor.ip ?? null,
      },
      tx,
    );
    await this.outbox.publish(
      tx,
      buildOutboxEvent(
        ADMIN_EVENTS.adjustmentApplied,
        OUTBOX_AGGREGATES.manualAdjustment,
        fresh.id,
        { ...payloadOf(fresh), pointsTxId: entry.id },
        now,
      ),
    );
    return applied;
  }

  private writeLedger(row: AdjustmentRow, actor: AdminActor, tx: Tx): Promise<LedgerEntry> {
    const operation = ledgerOperationFor(row.amount);
    const base = {
      userId: row.userId,
      amount: operation.amount,
      sourceType: 'manual' as const,
      sourceId: row.id,
      idempotencyKey: adjustmentIdempotencyKey(row.id),
      reason: row.reason,
      createdById: actor.id,
    };
    return operation.kind === 'credit'
      ? this.ledger.credit({ ...base, type: 'adjust' }, tx)
      : this.ledger.spend(base, tx);
  }
}
