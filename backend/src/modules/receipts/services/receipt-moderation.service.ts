import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Receipt } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import { CONTENT_PORT, type ContentPort } from '../../../common/contracts/content';
import {
  OUTBOX_AGGREGATES,
  RECEIPT_EVENTS,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import type { ReceiptStatus } from '../../../common/contracts/receipts';
import type { ActorRef } from '../../../common/contracts/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { CommonErrors } from '../../../common/errors/error-codes';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { clampLimit, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { isUniqueViolation } from '../../../common/prisma/prisma.errors';
import { PrismaService, type Tx } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { ReceiptErrors } from '../domain/errors';
import { canonicalFn } from '../domain/fiscal-ids';
import { MODERATION_QUEUE_STATUSES, assertTransition } from '../domain/state-machine';
import { DUPLICATE_MESSAGE_UK } from '../domain/submission-view';
import type {
  AdminListReceiptsQueryDto,
  ApproveReceiptDto,
  RejectReceiptDto,
} from '../dto/receipt-requests.dto';
import type { AdminReceiptDetailDto, AdminReceiptPageDto } from '../dto/receipt-responses.dto';
import { ExpectedPointsService } from './expected-points.service';
import { ReceiptPipelineService } from './receipt-pipeline.service';
import { ReceiptPhotoService } from './receipt-photo.service';
import { ReceiptProcessQueue } from './receipt-process.queue';
import { toAdminReceiptDetailDto, toAdminReceiptDto, toTenantDto } from './receipt-view';
import { ReceiptsRepository, isReceiptCursor } from './receipts.repository';
import { loadTenant, loadTenantDtos } from './tenant-lookup';

/** The back-office user acting on a receipt (audited). */
export interface AdminContext {
  adminId: string;
  ip: string | null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the audit log keeps of a receipt before and after a decision. */
export function auditSnapshot(row: Receipt): Record<string, unknown> {
  return {
    status: row.status,
    moderatorId: row.moderatorId,
    decisionReason: row.decisionReason,
    rejectionCode: row.rejectionCode,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    pointsAwarded: row.pointsAwarded,
    totalKopecks: row.totalKopecks,
    fn: row.fn,
    fiscalId: row.fiscalId,
  };
}

/**
 * Back-office moderation (/admin/receipts): queue listing, audited detail view with a signed
 * photo URL, approve (then credit through the pipeline) and reject with a reason. Appealed
 * receipts are reviewed the same way: appealed -> needs_moderation -> approved | rejected, and
 * open appeals are resolved in the same transaction.
 */
@Injectable()
export class ReceiptModerationService {
  private readonly logger = new Logger(ReceiptModerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: ReceiptsRepository,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly pipeline: ReceiptPipelineService,
    private readonly photos: ReceiptPhotoService,
    private readonly queue: ReceiptProcessQueue,
    @Inject(CONTENT_PORT) private readonly content: ContentPort,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
    private readonly expected: ExpectedPointsService,
  ) {}

  /** GET /admin/receipts?status= ; the moderation queue is served oldest first. */
  async list(query: AdminListReceiptsQueryDto): Promise<AdminReceiptPageDto> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor, isReceiptCursor);
    const order =
      query.order ??
      (query.status !== undefined && MODERATION_QUEUE_STATUSES.includes(query.status)
        ? 'asc'
        : 'desc');
    const rows = await this.repo.list(
      this.prisma,
      {
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.userId !== undefined ? { userId: query.userId } : {}),
        ...(query.fn !== undefined ? { fn: canonicalFn(query.fn) ?? query.fn } : {}),
        ...(query.reason !== undefined ? { moderationReason: query.reason } : {}),
        ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
        ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
      },
      { ...(cursor ? { cursor } : {}), limit, order },
    );
    const page = toPage(rows, limit, (last) => ({
      s: last.submittedAt.toISOString(),
      id: last.id,
    }));
    const [tenants, appeals, expected] = await Promise.all([
      loadTenantDtos(
        this.content,
        page.items.map((row) => row.tenantId),
        this.logger,
      ),
      this.repo.countAppealsByReceipt(
        this.prisma,
        page.items.map((row) => row.id),
      ),
      this.expected.estimate(page.items),
    ]);
    return {
      items: page.items.map((row) =>
        toAdminReceiptDto(
          row,
          row.tenantId ? (tenants.get(row.tenantId) ?? null) : null,
          appeals.get(row.id) ?? 0,
          expected.get(row.id) ?? null,
        ),
      ),
      nextCursor: page.nextCursor,
    };
  }

  /** GET /admin/receipts/:id: the view itself is audited (photo and personal data exposure). */
  async view(admin: AdminContext, receiptId: string): Promise<AdminReceiptDetailDto> {
    const detail = await this.detail(receiptId);
    await this.audit.audit({
      actor: this.actor(admin),
      action: 'receipt.view',
      entityType: 'receipt',
      entityId: receiptId,
      ip: admin.ip,
    });
    return detail;
  }

  /** POST /admin/receipts/:id/approve: approve, then credit (job fallback on failure). */
  async approve(
    admin: AdminContext,
    receiptId: string,
    dto: ApproveReceiptDto,
  ): Promise<AdminReceiptDetailDto> {
    const row = await this.loadForDecision(receiptId);
    const note = dto.reason?.trim() || null;
    const now = this.clock.now();
    const fill = await this.resolveFnFill(row, dto.fn);
    try {
      await this.prisma.withTx(async (tx) => {
        await this.reopenAppeal(tx, row, admin, now);
        assertTransition('needs_moderation', 'approved', 'admin');
        if (fill !== null && fill.lookupMissing) {
          await this.content.recordSeenFiscalNumber(fill.fn, tx, { receiptId: row.id });
        }
        const approved = await this.repo.transitionStatus(tx, row.id, 'needs_moderation', {
          status: 'approved',
          moderatorId: admin.adminId,
          decidedAt: now,
          // decisionReason is the member-facing rejection reason; an approval clears it, and the
          // rule code of an appealed rule rejection with it. moderationReasons stay as history.
          decisionReason: null,
          rejectionCode: null,
          ...(fill !== null
            ? {
                fn: fill.fn,
                fnRaw: fill.fnRaw,
                ...(fill.tenantId !== null ? { tenantId: fill.tenantId } : {}),
              }
            : {}),
        });
        if (!approved) {
          throw this.concurrentChange(row.id);
        }
        await this.finishApproval(tx, row, approved, admin, note, now, fill);
      });
    } catch (error) {
      if (fill !== null && isUniqueViolation(error)) {
        throw new DomainError(ReceiptErrors.PC_RECEIPT_DUPLICATE, DUPLICATE_MESSAGE_UK, {
          details: { fn: fill.fn, fiscalId: row.fiscalId },
          cause: error,
        });
      }
      throw error;
    }

    try {
      await this.pipeline.process(row.id);
    } catch (error) {
      this.logger.warn(
        `Receipt ${row.id}: credit after approval failed (${describe(error)}); queued`,
      );
      await this.queue.enqueueSafely(row.id, `approve-${now.getTime()}`);
    }
    return this.detail(row.id);
  }

  /**
   * A manual receipt submitted without the cash register number needs the moderator to read it
   * from the photo; the canonical value completes the (fn, fiscal_id) key (a duplicate fails
   * with PC_RECEIPT_DUPLICATE) and maps the tenant through the whitelist.
   */
  private async resolveFnFill(
    row: Receipt,
    fnInput: string | undefined,
  ): Promise<{
    fn: string;
    fnRaw: string;
    tenantId: string | null;
    lookupMissing: boolean;
  } | null> {
    const raw = fnInput?.trim() || null;
    const fn = raw === null ? null : canonicalFn(raw);
    if (raw !== null && fn === null) {
      throw new DomainError(CommonErrors.PC_COMMON_VALIDATION, 'fn must be 6-20 digits', {
        details: { field: 'fn' },
      });
    }
    if (row.fn !== null) {
      if (fn !== null && fn !== row.fn) {
        throw new DomainError(
          CommonErrors.PC_COMMON_VALIDATION,
          `The receipt already has fn ${row.fn}`,
          { details: { field: 'fn', reason: 'already_set' } },
        );
      }
      return null;
    }
    if (fn === null || raw === null) {
      throw new DomainError(
        CommonErrors.PC_COMMON_VALIDATION,
        'The member did not give the cash register number: pass fn read from the photo',
        { details: { field: 'fn', reason: 'required_for_approval' } },
      );
    }
    const lookup = await this.content.findTenantByFiscalNumber(fn);
    return {
      fn,
      fnRaw: raw,
      tenantId: lookup?.status === 'active' ? lookup.tenantId : null,
      lookupMissing: lookup === null,
    };
  }

  private async finishApproval(
    tx: Tx,
    row: Receipt,
    approved: Receipt,
    admin: AdminContext,
    note: string | null,
    now: Date,
    fill: { fn: string } | null,
  ): Promise<void> {
    await this.repo.resolveOpenAppeals(tx, row.id, {
      resolvedById: admin.adminId,
      resolution: note ? `approved: ${note}` : 'approved',
      resolvedAt: now,
    });
    const fnNote = fill !== null ? `fn ${fill.fn} filled in by the moderator` : null;
    await this.addEvent(
      tx,
      row.id,
      'needs_moderation',
      'approved',
      admin,
      [note ?? 'approved', fnNote].filter((part): part is string => part !== null).join('; '),
      now,
    );
    await this.outbox.publish(
      tx,
      buildOutboxEvent(RECEIPT_EVENTS.approved, OUTBOX_AGGREGATES.receipt, row.id, {
        receiptId: row.id,
        userId: row.userId,
        moderatorId: admin.adminId,
      }),
    );
    await this.audit.audit(
      {
        actor: this.actor(admin),
        action: 'receipt.approve',
        entityType: 'receipt',
        entityId: row.id,
        before: auditSnapshot(row),
        after: auditSnapshot(approved),
        reason: note,
        ip: admin.ip,
      },
      tx,
    );
  }

  /** POST /admin/receipts/:id/reject {reason}: the reason is shown to the member. */
  async reject(
    admin: AdminContext,
    receiptId: string,
    dto: RejectReceiptDto,
  ): Promise<AdminReceiptDetailDto> {
    const row = await this.loadForDecision(receiptId);
    const reason = dto.reason.trim();
    const now = this.clock.now();
    await this.prisma.withTx(async (tx) => {
      await this.reopenAppeal(tx, row, admin, now);
      assertTransition('needs_moderation', 'rejected', 'admin');
      const rejected = await this.repo.transitionStatus(tx, row.id, 'needs_moderation', {
        status: 'rejected',
        moderatorId: admin.adminId,
        decidedAt: now,
        decisionReason: reason,
        // A moderator rejection carries a reason, not a rule code.
        rejectionCode: null,
      });
      if (!rejected) {
        throw this.concurrentChange(row.id);
      }
      await this.repo.resolveOpenAppeals(tx, row.id, {
        resolvedById: admin.adminId,
        resolution: `rejected: ${reason}`,
        resolvedAt: now,
      });
      await this.addEvent(
        tx,
        row.id,
        'needs_moderation',
        'rejected',
        admin,
        `moderator: ${reason}`,
        now,
      );
      await this.outbox.publish(
        tx,
        buildOutboxEvent(RECEIPT_EVENTS.rejected, OUTBOX_AGGREGATES.receipt, row.id, {
          receiptId: row.id,
          userId: row.userId,
          moderatorId: admin.adminId,
          reason,
          code: null,
        }),
      );
      await this.audit.audit(
        {
          actor: this.actor(admin),
          action: 'receipt.reject',
          entityType: 'receipt',
          entityId: row.id,
          before: auditSnapshot(row),
          after: auditSnapshot(rejected),
          reason,
          ip: admin.ip,
        },
        tx,
      );
    });
    return this.detail(row.id);
  }

  private actor(admin: AdminContext): ActorRef {
    return { type: 'admin', id: admin.adminId };
  }

  private concurrentChange(receiptId: string): DomainError {
    return new DomainError(
      ReceiptErrors.PC_RECEIPT_INVALID_TRANSITION,
      `Receipt ${receiptId} was changed by someone else; reload it`,
    );
  }

  private async loadForDecision(receiptId: string): Promise<Receipt> {
    const row = await this.repo.findById(this.prisma, receiptId);
    if (!row) {
      throw new DomainError(ReceiptErrors.PC_RECEIPT_NOT_FOUND, `Receipt ${receiptId} not found`);
    }
    if (!MODERATION_QUEUE_STATUSES.includes(row.status)) {
      throw new DomainError(
        ReceiptErrors.PC_RECEIPT_INVALID_TRANSITION,
        `Receipt is ${row.status}; only needs_moderation or appealed receipts can be decided`,
        { details: { status: row.status, allowed: MODERATION_QUEUE_STATUSES } },
      );
    }
    return row;
  }

  /** appealed -> needs_moderation (admin) so the decision follows the normal path. */
  private async reopenAppeal(tx: Tx, row: Receipt, admin: AdminContext, now: Date): Promise<void> {
    if (row.status !== 'appealed') {
      return;
    }
    assertTransition('appealed', 'needs_moderation', 'admin');
    const reopened = await this.repo.transitionStatus(tx, row.id, 'appealed', {
      status: 'needs_moderation',
    });
    if (!reopened) {
      throw this.concurrentChange(row.id);
    }
    await this.addEvent(tx, row.id, 'appealed', 'needs_moderation', admin, 'appeal review', now);
  }

  private async addEvent(
    tx: Tx,
    receiptId: string,
    fromStatus: ReceiptStatus,
    toStatus: ReceiptStatus,
    admin: AdminContext,
    note: string,
    createdAt: Date,
  ): Promise<void> {
    await this.repo.addEvent(tx, {
      id: uuidv7(),
      receiptId,
      fromStatus,
      toStatus,
      actorType: 'admin',
      actorId: admin.adminId,
      note,
      createdAt,
    });
  }

  private async detail(receiptId: string): Promise<AdminReceiptDetailDto> {
    const row = await this.repo.findById(this.prisma, receiptId);
    if (!row) {
      throw new DomainError(ReceiptErrors.PC_RECEIPT_NOT_FOUND, `Receipt ${receiptId} not found`);
    }
    const [events, appeals, tenant, photoUrl, expectedPoints] = await Promise.all([
      this.repo.listEvents(this.prisma, row.id),
      this.repo.listAppeals(this.prisma, row.id),
      loadTenant(this.content, row.tenantId, this.logger),
      this.photos.signedUrl(row.photoKey),
      this.expected.estimateOne(row),
    ]);
    const appealParts = await Promise.all(
      appeals.map(async (appeal) => ({
        appeal,
        photoUrl: await this.photos.signedUrl(appeal.photoKey),
      })),
    );
    return toAdminReceiptDetailDto(row, {
      tenant: toTenantDto(tenant),
      photoUrl,
      events,
      appeals: appealParts,
      expectedPoints,
    });
  }
}
