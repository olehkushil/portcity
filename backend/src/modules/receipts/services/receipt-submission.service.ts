import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Receipt } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import {
  FEATURE_FLAG_KEYS,
  FEATURE_FLAGS_PORT,
  type FeatureFlagsPort,
} from '../../../common/contracts/admin';
import {
  CLUB_LEDGER_PORT,
  type ClubLedgerPort,
  DEFAULT_LOYALTY_RULES,
  type LedgerEntry,
  type LoyaltyRules,
} from '../../../common/contracts/club';
import { CONTENT_PORT, type ContentPort } from '../../../common/contracts/content';
import {
  OUTBOX_AGGREGATES,
  RECEIPT_EVENTS,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import type { ReceiptSource } from '../../../common/contracts/receipts';
import { DomainError } from '../../../common/errors/domain-error';
import { CommonErrors } from '../../../common/errors/error-codes';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { clampLimit, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { isForeignKeyViolation, isUniqueViolation } from '../../../common/prisma/prisma.errors';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { ReceiptErrors } from '../domain/errors';
import { canonicalFiscalId, canonicalFn } from '../domain/fiscal-ids';
import { parseManualIssuedAt } from '../domain/manual-input';
import { parseTaxQr } from '../domain/qr-parser';
import { canAppealWith } from '../domain/state-machine';
import {
  APPEAL_NOT_ALLOWED_MESSAGE_UK,
  DUPLICATE_MESSAGE_UK,
  MANUAL_DISABLED_MESSAGE_UK,
  QR_ERROR_MESSAGES_UK,
  buildSubmissionView,
  moderationReasonTexts,
  parseModerationReasons,
  parseRejectionCode,
} from '../domain/submission-view';
import type {
  CreateAppealDto,
  CreatePhotoUploadUrlDto,
  ListReceiptsQueryDto,
  SubmitManualDto,
} from '../dto/receipt-requests.dto';
import type {
  PhotoUploadUrlDto,
  ReceiptBalanceDto,
  ReceiptDetailDto,
  ReceiptPageDto,
  ReceiptSubmissionResultDto,
} from '../dto/receipt-responses.dto';
import { ExpectedPointsService } from './expected-points.service';
import type { PipelineResult } from './receipt-pipeline.service';
import { ReceiptPipelineService } from './receipt-pipeline.service';
import { ReceiptPhotoService } from './receipt-photo.service';
import { ReceiptProcessQueue } from './receipt-process.queue';
import { iso, toPointsDto, toReceiptDetailDto, toReceiptDto, toTenantDto } from './receipt-view';
import { ReceiptsRepository, isReceiptCursor } from './receipts.repository';
import { loadTenant, loadTenantDtos } from './tenant-lookup';

/** The authenticated member and the device from the access token (`did`). */
export interface MemberContext {
  userId: string;
  deviceId: string | null;
}

interface NewSubmission {
  source: ReceiptSource;
  /** Canonical; null only for a manual receipt with a tenant and without the cash register. */
  fn: string | null;
  /** Canonical. */
  fiscalId: string;
  fnRaw: string | null;
  fiscalIdRaw: string;
  issuedAt: Date;
  totalKopecks: number;
  rawQr: string | null;
  photoKey: string | null;
  /** Tenant picked on the manual form (null for QR and for "Не знаю"). */
  tenantId: string | null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidField(field: string, message: string, reason?: string): DomainError {
  return new DomainError(CommonErrors.PC_COMMON_VALIDATION, message, {
    details: reason ? { field, reason } : { field },
  });
}

function notFound(receiptId: string): DomainError {
  return new DomainError(ReceiptErrors.PC_RECEIPT_NOT_FOUND, `Receipt ${receiptId} not found`);
}

/**
 * Member side of the receipts module: QR and manual submission (with photo), photo upload URLs,
 * own receipts and appeals. Submissions run the pipeline synchronously so the app can show the
 * result screen at once; when a step fails the receipt is handed to the `receipts-process` job.
 */
@Injectable()
export class ReceiptSubmissionService {
  private readonly logger = new Logger(ReceiptSubmissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: ReceiptsRepository,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly pipeline: ReceiptPipelineService,
    private readonly photos: ReceiptPhotoService,
    private readonly queue: ReceiptProcessQueue,
    @Inject(CONTENT_PORT) private readonly content: ContentPort,
    @Inject(CLUB_LEDGER_PORT) private readonly ledger: ClubLedgerPort,
    @Inject(FEATURE_FLAGS_PORT) private readonly flags: FeatureFlagsPort,
    private readonly expected: ExpectedPointsService,
  ) {}

  // -------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------

  /** POST /receipts/qr. Throws PC_RECEIPT_QR_INVALID (400) and PC_RECEIPT_DUPLICATE (409). */
  async submitQr(member: MemberContext, qrText: string): Promise<ReceiptSubmissionResultDto> {
    const parsed = parseTaxQr(qrText);
    if (!parsed.ok) {
      throw new DomainError(
        ReceiptErrors.PC_RECEIPT_QR_INVALID,
        QR_ERROR_MESSAGES_UK[parsed.error.code],
        {
          details: { reason: parsed.error.code, param: parsed.error.param },
        },
      );
    }
    const qr = parsed.value;
    return this.register(member, {
      source: 'qr',
      fn: qr.fn,
      fiscalId: qr.fiscalId,
      fnRaw: qr.fnRaw,
      fiscalIdRaw: qr.fiscalIdRaw,
      issuedAt: qr.issuedAt,
      totalKopecks: qr.totalKopecks,
      rawQr: qr.raw,
      photoKey: null,
      tenantId: null,
    });
  }

  /**
   * POST /receipts/manual: always moderated; requires an uploaded photo of the member. The
   * member may pick the shop (`tenantId`, null = "Не знаю"); with a shop the cash register
   * number may be left out and the moderator fills it in. Numbers are canonicalised exactly like
   * the QR parser does, so a manual copy of a QR receipt is caught as a duplicate.
   */
  async submitManual(
    member: MemberContext,
    dto: SubmitManualDto,
  ): Promise<ReceiptSubmissionResultDto> {
    const enabled = await this.flags.isEnabled(FEATURE_FLAG_KEYS.receiptsManualSubmission, true);
    if (!enabled) {
      throw new DomainError(ReceiptErrors.PC_RECEIPT_MANUAL_DISABLED, MANUAL_DISABLED_MESSAGE_UK);
    }
    const issuedAt = parseManualIssuedAt(dto.issuedAt);
    if (!issuedAt) {
      throw invalidField('issuedAt', 'issuedAt is not a valid date-time');
    }
    const tenantId = dto.tenantId ?? null;
    const fnRaw = dto.fn?.trim() || null;
    if (fnRaw === null && tenantId === null) {
      throw invalidField(
        'fn',
        'fn is required unless the shop (tenantId) is chosen',
        'required_without_tenant',
      );
    }
    const fn = fnRaw === null ? null : canonicalFn(fnRaw);
    if (fnRaw !== null && fn === null) {
      throw invalidField('fn', 'fn must be 6-20 digits');
    }
    const fiscalId = canonicalFiscalId(dto.fiscalId);
    if (fiscalId === null) {
      throw invalidField('fiscalId', 'fiscalId must be 1-64 letters or digits');
    }
    if (tenantId !== null && (await this.content.getTenant(tenantId)) === null) {
      throw invalidField('tenantId', `Tenant ${tenantId} not found`, 'not_found');
    }
    await this.photos.assertUploaded(member.userId, dto.photoKey);
    return this.register(member, {
      source: 'manual',
      fn,
      fiscalId,
      fnRaw,
      fiscalIdRaw: dto.fiscalId.trim(),
      issuedAt,
      totalKopecks: dto.totalKopecks,
      rawQr: null,
      photoKey: dto.photoKey,
      tenantId,
    });
  }

  /** POST /receipts/photo-upload-url */
  createPhotoUploadUrl(userId: string, dto: CreatePhotoUploadUrlDto): Promise<PhotoUploadUrlDto> {
    return this.photos.createUploadUrl(userId, dto);
  }

  private duplicateError(existing: Receipt | null, userId: string): DomainError {
    const own = existing !== null && existing.userId === userId;
    return new DomainError(ReceiptErrors.PC_RECEIPT_DUPLICATE, DUPLICATE_MESSAGE_UK, {
      // Only the owner learns which receipt it collides with.
      details: own ? { receiptId: existing.id, status: existing.status } : { receiptId: null },
    });
  }

  private async register(
    member: MemberContext,
    input: NewSubmission,
  ): Promise<ReceiptSubmissionResultDto> {
    // The key holds canonical values, so rewritten numbers (leading zeros, case, dashes) of an
    // already registered receipt are found here. A manual receipt without fn is checked when the
    // moderator fills fn in (unique violation on approval).
    if (input.fn !== null) {
      const existing = await this.repo.findByFnAndFiscalId(this.prisma, input.fn, input.fiscalId);
      if (existing) {
        throw this.duplicateError(existing, member.userId);
      }
    }

    const id = uuidv7();
    const now = this.clock.now();
    try {
      await this.persistSubmission(id, now, member, input, member.deviceId);
    } catch (error) {
      if (isUniqueViolation(error) && input.fn !== null) {
        const other = await this.repo.findByFnAndFiscalId(this.prisma, input.fn, input.fiscalId);
        throw this.duplicateError(other, member.userId);
      }
      if (isForeignKeyViolation(error) && member.deviceId !== null) {
        // The device from the access token is gone (removed since the token was issued):
        // keep the receipt, just without the device link.
        this.logger.warn(`Receipt ${id}: device ${member.deviceId} not found, stored without it`);
        await this.persistSubmission(id, now, member, input, null);
      } else {
        throw error;
      }
    }

    let result: PipelineResult | null = null;
    try {
      result = await this.pipeline.process(id);
    } catch (error) {
      this.logger.warn(`Receipt ${id}: synchronous processing failed (${describe(error)}); queued`);
      await this.queue.enqueueSafely(id, 'submit');
    }
    const receipt = result?.receipt ?? (await this.pipeline.load(id));
    return this.toSubmissionResult(receipt, result);
  }

  /** Inserts the receipt (status parsed), its first two trail events and receipt.submitted. */
  private async persistSubmission(
    id: string,
    now: Date,
    member: MemberContext,
    input: NewSubmission,
    deviceId: string | null,
  ): Promise<void> {
    await this.prisma.withTx(async (tx) => {
      await this.repo.create(tx, {
        id,
        userId: member.userId,
        deviceId,
        fn: input.fn,
        fiscalId: input.fiscalId,
        fnRaw: input.fnRaw,
        fiscalIdRaw: input.fiscalIdRaw,
        issuedAt: input.issuedAt,
        totalKopecks: input.totalKopecks,
        rawQr: input.rawQr,
        source: input.source,
        photoKey: input.photoKey,
        // The member's pick on the manual form; the rules replace it with the whitelist tenant
        // of a known cash register.
        tenantId: input.tenantId,
        // The QR or the manual form is validated before the row exists, so it starts parsed;
        // the trail still records both steps.
        status: 'parsed',
        riskFlags: [],
        riskScore: 0,
        submittedAt: now,
        createdAt: now,
      });
      await this.repo.addEvent(tx, {
        id: uuidv7(),
        receiptId: id,
        fromStatus: null,
        toStatus: 'uploaded',
        actorType: 'user',
        actorId: member.userId,
        note: input.source === 'qr' ? 'submitted by QR' : 'submitted manually with a photo',
        createdAt: now,
      });
      await this.repo.addEvent(tx, {
        id: uuidv7(),
        receiptId: id,
        fromStatus: 'uploaded',
        toStatus: 'parsed',
        actorType: 'system',
        actorId: null,
        note: `fn ${input.fn ?? '(not given)'}, fiscal id ${input.fiscalId}, total ${input.totalKopecks} kop.`,
        createdAt: now,
      });
      await this.outbox.publish(
        tx,
        buildOutboxEvent(RECEIPT_EVENTS.submitted, OUTBOX_AGGREGATES.receipt, id, {
          receiptId: id,
          userId: member.userId,
          deviceId,
          // The payload type keeps fn a string: '' when the member did not give the cash register.
          fn: input.fn ?? '',
          fiscalId: input.fiscalId,
          totalKopecks: input.totalKopecks,
          issuedAt: input.issuedAt.toISOString(),
          source: input.source,
        }),
      );
    });
  }

  private async toSubmissionResult(
    receipt: Receipt,
    result: PipelineResult | null,
  ): Promise<ReceiptSubmissionResultDto> {
    const credit = result?.credit ?? null;
    const rules = result?.rules ?? (await this.activeRules());
    // The decision details are persisted on the row (moderation_reasons, rejection_code), so the
    // same answer comes back whether this request or an earlier job run evaluated the rules.
    const moderationReasons = parseModerationReasons(receipt.moderationReasons);
    const rejectionCode = parseRejectionCode(receipt.rejectionCode);
    const entryState = credit?.entry?.state;
    const view = buildSubmissionView({
      status: receipt.status,
      pointsAwarded: receipt.pointsAwarded,
      pointsState: entryState === 'pending' ? 'pending' : entryState ? 'available' : null,
      pointsAvailableAt:
        entryState === 'pending'
          ? (credit?.entry?.availableAt ?? credit?.plan.availableAt ?? null)
          : null,
      rejectionCode,
      decisionReason: receipt.decisionReason,
      moderationReasons,
      rules,
    });
    const tenant =
      result?.tenant && result.tenant.id === receipt.tenantId
        ? result.tenant
        : await loadTenant(this.content, receipt.tenantId, this.logger);
    const balance = view.screen === 'credited' ? await this.balance(receipt.userId) : null;
    const expectedPoints = await this.expected.estimateOne(receipt);
    return {
      receipt: toReceiptDto(receipt, toTenantDto(tenant), 0, expectedPoints),
      outcome: view.outcome,
      screen: view.screen,
      title: view.title,
      message: view.message,
      pointsAwarded: view.pointsAwarded,
      pointsAvailableAt: iso(view.pointsAvailableAt),
      rejectionCode: view.rejectionCode,
      moderationReasons: view.moderationReasons,
      balance,
    };
  }

  private async activeRules(): Promise<LoyaltyRules> {
    try {
      return (await this.ledger.getActiveRules(this.clock.now())).rules;
    } catch (error) {
      this.logger.warn(`Active rules unavailable, using defaults: ${describe(error)}`);
      return DEFAULT_LOYALTY_RULES;
    }
  }

  private async balance(userId: string): Promise<ReceiptBalanceDto | null> {
    try {
      const balance = await this.ledger.getBalance(userId);
      return balance ? { available: balance.available, pending: balance.pending } : null;
    } catch (error) {
      this.logger.warn(`Balance unavailable for ${userId}: ${describe(error)}`);
      return null;
    }
  }

  private async ledgerEntry(txId: string | null): Promise<LedgerEntry | null> {
    if (txId === null) {
      return null;
    }
    try {
      return await this.ledger.getEntry(txId);
    } catch (error) {
      this.logger.warn(`Ledger entry ${txId} unavailable: ${describe(error)}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** GET /receipts: the member's receipts, newest first. */
  async list(userId: string, query: ListReceiptsQueryDto): Promise<ReceiptPageDto> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor, isReceiptCursor);
    const rows = await this.repo.list(
      this.prisma,
      {
        userId,
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
        ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
      },
      { ...(cursor ? { cursor } : {}), limit, order: 'desc' },
    );
    const page = toPage(rows, limit, (last) => ({
      s: last.submittedAt.toISOString(),
      id: last.id,
    }));
    const ids = page.items.map((row) => row.id);
    const [tenants, appeals, expected] = await Promise.all([
      loadTenantDtos(
        this.content,
        page.items.map((row) => row.tenantId),
        this.logger,
      ),
      this.repo.countAppealsByReceipt(this.prisma, ids),
      this.expected.estimate(page.items),
    ]);
    return {
      items: page.items.map((row) =>
        toReceiptDto(
          row,
          row.tenantId ? (tenants.get(row.tenantId) ?? null) : null,
          appeals.get(row.id) ?? 0,
          expected.get(row.id) ?? null,
        ),
      ),
      nextCursor: page.nextCursor,
    };
  }

  /** GET /receipts/:id: only the owner sees a receipt (others get 404). */
  async get(userId: string, receiptId: string): Promise<ReceiptDetailDto> {
    const row = await this.repo.findById(this.prisma, receiptId);
    if (!row || row.userId !== userId) {
      throw notFound(receiptId);
    }
    const [events, appeals, tenant, photoUrl, entry, expectedPoints] = await Promise.all([
      this.repo.listEvents(this.prisma, row.id),
      this.repo.listAppeals(this.prisma, row.id),
      loadTenant(this.content, row.tenantId, this.logger),
      this.photos.signedUrl(row.photoKey),
      this.ledgerEntry(row.pointsTxId),
      this.expected.estimateOne(row),
    ]);
    let moderationReasons: string[] = [];
    if (row.status === 'needs_moderation') {
      const reasons = parseModerationReasons(row.moderationReasons);
      if (reasons.length > 0) {
        moderationReasons = moderationReasonTexts(reasons, await this.activeRules());
      }
    }
    const rejectionCode = row.status === 'rejected' ? parseRejectionCode(row.rejectionCode) : null;
    return toReceiptDetailDto(row, {
      tenant: toTenantDto(tenant),
      photoUrl,
      points: toPointsDto(entry),
      events,
      appeals,
      moderationReasons,
      rejectionCode,
      expectedPoints,
    });
  }

  // -------------------------------------------------------------------------
  // Appeals
  // -------------------------------------------------------------------------

  /** POST /receipts/:id/appeal: rejected -> appealed, once per receipt. */
  async appeal(
    member: MemberContext,
    receiptId: string,
    dto: CreateAppealDto,
  ): Promise<ReceiptDetailDto> {
    const row = await this.repo.findById(this.prisma, receiptId);
    if (!row || row.userId !== member.userId) {
      throw notFound(receiptId);
    }
    const appealsSoFar = await this.repo.countAppeals(this.prisma, row.id);
    if (!canAppealWith(row.status, appealsSoFar)) {
      throw new DomainError(
        ReceiptErrors.PC_RECEIPT_APPEAL_NOT_ALLOWED,
        APPEAL_NOT_ALLOWED_MESSAGE_UK,
        {
          details: { status: row.status, appealsSoFar },
        },
      );
    }
    if (dto.photoKey !== undefined) {
      await this.photos.assertUploaded(member.userId, dto.photoKey);
    }
    const now = this.clock.now();
    const appealId = uuidv7();
    await this.prisma.withTx(async (tx) => {
      const moved = await this.repo.transitionStatus(tx, row.id, 'rejected', {
        status: 'appealed',
      });
      if (!moved) {
        throw new DomainError(
          ReceiptErrors.PC_RECEIPT_INVALID_TRANSITION,
          'Receipt status changed, reload it and try again',
        );
      }
      await this.repo.createAppeal(tx, {
        id: appealId,
        receiptId: row.id,
        message: dto.message.trim(),
        photoKey: dto.photoKey ?? null,
        createdAt: now,
      });
      await this.repo.addEvent(tx, {
        id: uuidv7(),
        receiptId: row.id,
        fromStatus: 'rejected',
        toStatus: 'appealed',
        actorType: 'user',
        actorId: member.userId,
        note: `appeal ${appealId}`,
        createdAt: now,
      });
      await this.outbox.publish(
        tx,
        buildOutboxEvent(RECEIPT_EVENTS.appealed, OUTBOX_AGGREGATES.receipt, row.id, {
          receiptId: row.id,
          userId: row.userId,
          appealId,
          previousStatus: 'rejected',
        }),
      );
    });
    return this.get(member.userId, row.id);
  }
}
