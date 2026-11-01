import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, SupportRequest } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import {
  ADMIN_AUDIT_PORT,
  type AdminAuditPort,
  SUPPORT_REQUESTS_PER_DAY,
  type SupportRelatedType,
  type SupportRequestStatus,
  type SupportRequestTopic,
} from '../../../common/contracts/admin';
import {
  ADMIN_EVENTS,
  OUTBOX_AGGREGATES,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import { DomainError } from '../../../common/errors/domain-error';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { PrismaService, type Tx } from '../../../common/prisma/prisma.service';
import {
  StoragePort,
  buildObjectKey,
  extensionForContentType,
} from '../../../common/storage/storage.port';
import { Clock } from '../../../common/time/clock';
import { addKyivDays, startOfKyivDay } from '../../../common/time/kyiv';
import { AdminErrors } from '../domain/errors';
import { LIST_ORDER, cursorOf, isListCursor, keysetWhere } from '../domain/list-cursor';
import {
  SUPPORT_PHOTO_MAX_BYTES,
  SUPPORT_PHOTO_UPLOAD_TTL_SECONDS,
  SUPPORT_PHOTO_VIEW_TTL_SECONDS,
  assertSupportStatusChange,
  isDecidedSupportStatus,
  isOwnSupportPhotoKey,
  isSupportPhotoContentType,
  supportPhotoPrefix,
} from '../domain/support-rules';
import type { AdminActor } from '../domain/views';
import type {
  AdminSupportRequestDto,
  SupportPhotoUploadDto,
  SupportRequestCreatedDto,
  SupportRequestDto,
} from '../dto/support.dto';

const ENTITY_TYPE = 'support_request';

export interface CreateSupportRequestInput {
  topic: SupportRequestTopic;
  relatedType?: SupportRelatedType;
  relatedId?: string;
  message: string;
  photoKey?: string;
}

export interface SupportListFilter {
  status?: SupportRequestStatus;
  userId?: string;
}

export interface SupportListQuery {
  cursor?: string;
  limit: number;
}

export interface UpdateSupportRequestInput {
  status: SupportRequestStatus;
  note?: string;
}

export function toSupportRequestDto(row: SupportRequest): SupportRequestDto {
  return {
    id: row.id,
    number: row.number,
    topic: row.topic,
    relatedType: row.relatedType,
    relatedId: row.relatedId,
    message: row.message,
    hasPhoto: row.photoKey !== null,
    status: row.status,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toAdminSupportRequestDto(
  row: SupportRequest,
  photoUrl: string | null = null,
): AdminSupportRequestDto {
  return {
    ...toSupportRequestDto(row),
    userId: row.userId,
    photoKey: row.photoKey,
    photoUrl,
    adminNote: row.adminNote,
    resolvedById: row.resolvedById,
  };
}

/**
 * Member support requests ("Звернення"): created by members (5 per Kyiv day, Idempotency-Key),
 * read and handled by support and managers in the back office (audited). Creating a request
 * publishes `support.request_created`; notifications e-mails SUPPORT_EMAIL and confirms to the
 * member in-app. The human `number` comes from the database sequence support_requests_number_seq.
 */
@Injectable()
export class SupportRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly storage: StoragePort,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  async create(
    userId: string,
    input: CreateSupportRequestInput,
  ): Promise<SupportRequestCreatedDto> {
    if (input.photoKey !== undefined && !isOwnSupportPhotoKey(userId, input.photoKey)) {
      throw new DomainError(
        AdminErrors.PC_SUPPORT_REQUEST_PHOTO_INVALID,
        'photoKey must be a key returned by POST /support/requests/photo-upload-url for this member',
      );
    }
    const now = this.clock.now();
    const message = input.message.trim();
    return this.prisma.withTx(async (tx) => {
      // One member at a time: the daily count and the insert cannot interleave.
      const lockKey = `support_request:user:${userId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const dayStart = startOfKyivDay(now);
      const sentToday = await tx.supportRequest.count({
        where: { userId, createdAt: { gte: dayStart } },
      });
      if (sentToday >= SUPPORT_REQUESTS_PER_DAY) {
        throw new DomainError(
          AdminErrors.PC_SUPPORT_REQUEST_DAILY_LIMIT,
          `At most ${SUPPORT_REQUESTS_PER_DAY} support requests per day; call the support line for anything urgent`,
          {
            details: {
              limit: SUPPORT_REQUESTS_PER_DAY,
              retryAfter: addKyivDays(dayStart, 1).toISOString(),
            },
          },
        );
      }
      const row = await tx.supportRequest.create({
        data: {
          id: uuidv7(),
          userId,
          topic: input.topic,
          relatedType: input.relatedType ?? null,
          relatedId: input.relatedId ?? null,
          message,
          photoKey: input.photoKey ?? null,
          status: 'new',
          createdAt: now,
          updatedAt: now,
        },
      });
      await this.outbox.publish(
        tx,
        buildOutboxEvent(
          ADMIN_EVENTS.supportRequestCreated,
          OUTBOX_AGGREGATES.supportRequest,
          row.id,
          {
            requestId: row.id,
            number: row.number,
            userId,
            topic: row.topic,
            relatedType: row.relatedType,
            relatedId: row.relatedId,
            message: row.message,
            photoKey: row.photoKey,
            createdAt: now.toISOString(),
          },
          now,
        ),
      );
      return { id: row.id, number: row.number };
    });
  }

  /** Presigned PUT for a photo under `support/<userId>/...` (pass the key as photoKey). */
  async createPhotoUpload(
    userId: string,
    request: { contentType: string; sizeBytes: number },
  ): Promise<SupportPhotoUploadDto> {
    const contentType = request.contentType.toLowerCase();
    const extension = extensionForContentType(contentType);
    if (!isSupportPhotoContentType(contentType) || !extension) {
      throw new DomainError(
        AdminErrors.PC_SUPPORT_REQUEST_PHOTO_INVALID,
        'Photo must be JPEG, PNG, WEBP or HEIC',
        { details: { contentType: request.contentType } },
      );
    }
    if (request.sizeBytes < 1 || request.sizeBytes > SUPPORT_PHOTO_MAX_BYTES) {
      throw new DomainError(
        AdminErrors.PC_SUPPORT_REQUEST_PHOTO_INVALID,
        `Photo must be at most ${SUPPORT_PHOTO_MAX_BYTES} bytes`,
        { details: { sizeBytes: request.sizeBytes, maxBytes: SUPPORT_PHOTO_MAX_BYTES } },
      );
    }
    const key = buildObjectKey(supportPhotoPrefix(userId), extension, this.clock.now());
    const upload = await this.storage.createPresignedUpload({
      key,
      contentType,
      sizeBytes: request.sizeBytes,
      expiresInSeconds: SUPPORT_PHOTO_UPLOAD_TTL_SECONDS,
    });
    return {
      url: upload.url,
      method: upload.method,
      headers: upload.headers,
      key: upload.key,
      expiresAt: upload.expiresAt,
    };
  }

  /** The member's own requests, newest first. */
  async listMine(userId: string, query: SupportListQuery): Promise<Page<SupportRequestDto>> {
    const page = await this.page({ userId }, query);
    return { items: page.items.map(toSupportRequestDto), nextCursor: page.nextCursor };
  }

  async listForAdmin(
    filter: SupportListFilter,
    query: SupportListQuery,
  ): Promise<Page<AdminSupportRequestDto>> {
    const page = await this.page(filter, query);
    return {
      items: page.items.map((row) => toAdminSupportRequestDto(row)),
      nextCursor: page.nextCursor,
    };
  }

  async getForAdmin(id: string): Promise<AdminSupportRequestDto> {
    const row = await this.requireRow(this.prisma, id);
    return toAdminSupportRequestDto(row, await this.photoUrl(row.photoKey));
  }

  /** Status change and/or note by support or a manager; audited in the same transaction. */
  async update(
    id: string,
    input: UpdateSupportRequestInput,
    actor: AdminActor,
  ): Promise<AdminSupportRequestDto> {
    const now = this.clock.now();
    const trimmedNote = input.note?.trim() ?? '';
    const note = trimmedNote === '' ? undefined : trimmedNote;
    const updated = await this.prisma.withTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM support_requests WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await this.requireRow(tx, id);
      assertSupportStatusChange(id, before.status, input.status);
      const changed = before.status !== input.status;
      const decided = isDecidedSupportStatus(input.status);
      const data: Prisma.SupportRequestUncheckedUpdateInput = {
        status: input.status,
        updatedAt: now,
        ...(note !== undefined ? { adminNote: note } : {}),
      };
      if (changed && decided) {
        data.resolvedById = actor.id;
        data.resolvedAt = now;
      } else if (changed && !decided) {
        // Reopened: no longer resolved.
        data.resolvedById = null;
        data.resolvedAt = null;
      }
      const row = await tx.supportRequest.update({ where: { id }, data });
      await this.audit.audit(
        {
          actor: { type: 'admin', id: actor.id },
          action: changed ? 'support_request.status_change' : 'support_request.note',
          entityType: ENTITY_TYPE,
          entityId: id,
          before: { status: before.status, adminNote: before.adminNote },
          after: { status: row.status, adminNote: row.adminNote },
          reason: note ?? null,
          ip: actor.ip ?? null,
        },
        tx,
      );
      return row;
    });
    return toAdminSupportRequestDto(updated, await this.photoUrl(updated.photoKey));
  }

  /** Distinct photo keys of a member's support requests (account erasure, admin-events). */
  async listPhotoKeysOfUser(userId: string): Promise<string[]> {
    const rows = await this.prisma.supportRequest.findMany({
      where: { userId, photoKey: { not: null } },
      select: { photoKey: true },
      distinct: ['photoKey'],
    });
    return rows.flatMap((row) => (row.photoKey ? [row.photoKey] : []));
  }

  /**
   * Account erasure (user.deleted): replaces the text and clears the photo key of every request
   * of the member. Number, topic, status and the staff note stay as the handling history.
   * Idempotent: rows already erased are not touched again. Returns the number of rows changed.
   */
  async eraseUserRequests(userId: string, placeholder: string): Promise<number> {
    const result = await this.prisma.supportRequest.updateMany({
      where: {
        userId,
        OR: [{ message: { not: placeholder } }, { photoKey: { not: null } }],
      },
      data: { message: placeholder, photoKey: null, updatedAt: this.clock.now() },
    });
    return result.count;
  }

  private async page(
    filter: SupportListFilter,
    query: SupportListQuery,
  ): Promise<Page<SupportRequest>> {
    const where: Prisma.SupportRequestWhereInput = {};
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
    const rows = await this.prisma.supportRequest.findMany({
      where,
      orderBy: [...LIST_ORDER],
      take: query.limit + 1,
    });
    return toPage(rows, query.limit, cursorOf);
  }

  private async requireRow(db: Tx | PrismaService, id: string): Promise<SupportRequest> {
    const row = await db.supportRequest.findUnique({ where: { id } });
    if (!row) {
      throw new DomainError(
        AdminErrors.PC_SUPPORT_REQUEST_NOT_FOUND,
        `Support request ${id} does not exist`,
        { details: { requestId: id } },
      );
    }
    return row;
  }

  private async photoUrl(key: string | null): Promise<string | null> {
    if (!key) {
      return null;
    }
    const download = await this.storage.createPresignedDownload(
      key,
      SUPPORT_PHOTO_VIEW_TTL_SECONDS,
    );
    return download.url;
  }
}
