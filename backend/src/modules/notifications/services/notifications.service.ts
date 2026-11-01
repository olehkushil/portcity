import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Notification, Prisma, PushDelivery } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import {
  NOTIFICATION_EVENTS,
  OUTBOX_AGGREGATES,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import { IDENTITY_PORT, type IdentityPort } from '../../../common/contracts/identity';
import type {
  NotificationKind,
  NotificationSummary,
  NotificationsPort,
  NotifyInput,
  PushDeliveryStatus,
} from '../../../common/contracts/notifications';
import { DomainError } from '../../../common/errors/domain-error';
import { toJsonValue } from '../../../common/idempotency/idempotency.service';
import { OutboxService } from '../../../common/outbox/outbox.service';
import {
  type CursorPayload,
  type Page,
  decodeCursor,
  toPage,
} from '../../../common/pagination/cursor';
import { PrismaService, type DbClient, type Tx } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { type DeliverySkipReason, decideDelivery, initialSentAt } from '../domain/delivery-policy';
import { NotificationErrors } from '../domain/errors';
import {
  MAX_DEDUPE_KEY_LENGTH,
  RESERVED_DATA_KEYS,
  isMarketingKind,
  isNotificationKind,
  isPlainRecord,
  publicData,
} from '../domain/kinds';
import { MAX_TITLE_LENGTH } from '../domain/templates';
import { NotificationPreferencesService } from './notification-preferences.service';

export interface ListNotificationsInput {
  cursor?: string;
  limit: number;
  /** Only unread rows when true. */
  unread?: boolean;
  kind?: NotificationKind;
}

export interface PushDeliverySummary {
  id: string;
  notificationId: string;
  deviceId: string;
  provider: string;
  status: PushDeliveryStatus;
  error: string | null;
  attempts: number;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Detailed outcome of `createNotification()`; `notify()` collapses it to summary-or-null. */
export type NotifyResult =
  | { status: 'created'; notification: NotificationSummary }
  | { status: 'replayed'; notification: NotificationSummary }
  | { status: 'skipped'; reason: DeliverySkipReason; notification: null };

interface NotificationCursor extends CursorPayload {
  createdAt: string;
  id: string;
}

function isNotificationCursor(value: unknown): value is NotificationCursor {
  return (
    isPlainRecord(value) &&
    typeof value.createdAt === 'string' &&
    !Number.isNaN(new Date(value.createdAt).getTime()) &&
    typeof value.id === 'string'
  );
}

export function toNotificationSummary(row: Notification): NotificationSummary {
  return {
    id: row.id,
    userId: row.userId,
    // Stored kinds come from NOTIFICATION_KINDS (notify() validates them); older rows written
    // by a newer registry are still returned rather than hidden.
    kind: row.kind as NotificationKind,
    title: row.title,
    body: row.body,
    data: publicData(row.data),
    channel: row.channel,
    sentAt: row.sentAt,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

export function toPushDeliverySummary(row: PushDelivery): PushDeliverySummary {
  return {
    id: row.id,
    notificationId: row.notificationId,
    deviceId: row.deviceId,
    provider: row.provider,
    status: row.status,
    error: row.error,
    attempts: row.attempts,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Builds the stored `data` column: caller data, JSON-normalised, without reserved keys. */
export function buildStoredData(data: Record<string, unknown> | undefined): Prisma.InputJsonObject {
  const normalised = toJsonValue(data ?? {});
  const base: Record<string, unknown> = isPlainRecord(normalised) ? { ...normalised } : {};
  delete base[RESERVED_DATA_KEYS.dedupeKey];
  return base as Prisma.InputJsonObject;
}

/** Empty keys mean "no dedupe"; longer keys are cut to the column width (VarChar(200)). */
export function normaliseDedupeKey(dedupeKey: string | undefined): string | null {
  const trimmed = dedupeKey?.trim() ?? '';
  return trimmed === '' ? null : trimmed.slice(0, MAX_DEDUPE_KEY_LENGTH);
}

export interface ErasedNotificationData {
  notifications: number;
  preferences: number;
}

/**
 * In-app inbox and the NOTIFICATIONS_PORT implementation (brief sections 4 and 8).
 * `notify()` is the single write path: outbox consumers, reminders and admin tools go through it.
 */
@Injectable()
export class NotificationsService implements NotificationsPort {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly preferences: NotificationPreferencesService,
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  async notify(input: NotifyInput, tx?: Tx): Promise<NotificationSummary | null> {
    const result = await this.createNotification(input, tx);
    return result.notification;
  }

  /**
   * Back-office send (POST /admin/notifications): the notification (or the decision to skip
   * it) and the `notification.send` audit row commit in one transaction.
   */
  async sendAsAdmin(
    input: NotifyInput,
    actor: { id: string; ip?: string | null },
    reason: string | null,
  ): Promise<NotifyResult> {
    return this.prisma.withTx(async (tx) => {
      const result = await this.createNotification(input, tx);
      await this.audit.audit(
        {
          actor: { type: 'admin', id: actor.id },
          action: 'notification.send',
          entityType: 'notification',
          entityId: result.notification?.id ?? null,
          after: {
            userId: input.userId,
            kind: input.kind,
            title: input.title,
            channel: result.notification?.channel ?? input.channel ?? null,
            status: result.status,
            skippedReason: result.status === 'skipped' ? result.reason : null,
          },
          reason,
          ip: actor.ip ?? null,
        },
        tx,
      );
      return result;
    });
  }

  /** Same as `notify()` but says why nothing was stored (admin tools, tests). */
  async createNotification(input: NotifyInput, tx?: Tx): Promise<NotifyResult> {
    if (!isNotificationKind(input.kind)) {
      throw new DomainError(
        NotificationErrors.PC_NOTIFICATION_KIND_UNKNOWN,
        `Unknown notification kind "${String(input.kind)}"`,
        { details: { kind: input.kind } },
      );
    }
    const kind = input.kind;
    const dedupeKey = normaliseDedupeKey(input.dedupeKey);
    const user = await this.identity.getUser(input.userId, tx);
    const hasMarketingConsent =
      user && isMarketingKind(kind)
        ? await this.identity.hasConsent(input.userId, 'marketing')
        : null;

    return this.prisma.runInTx(tx, async (db): Promise<NotifyResult> => {
      if (dedupeKey) {
        const existing = await this.findByDedupeKey(db, input.userId, dedupeKey);
        if (existing) {
          return { status: 'replayed', notification: toNotificationSummary(existing) };
        }
      }
      const preferenceEnabled = user
        ? await this.preferences.getStored(db, input.userId, kind)
        : null;
      const decision = decideDelivery({
        kind,
        userStatus: user?.status ?? null,
        preferenceEnabled,
        hasMarketingConsent,
        requestedChannel: input.channel ?? null,
      });
      if (!decision.deliver) {
        this.logger.debug(`notify(${kind}) skipped for user ${input.userId}: ${decision.reason}`);
        return { status: 'skipped', reason: decision.reason, notification: null };
      }

      const now = this.clock.now();
      const id = uuidv7();
      const data: Prisma.NotificationCreateManyInput = {
        id,
        userId: input.userId,
        kind,
        title: clampTitle(input.title),
        body: input.body,
        data: buildStoredData(input.data),
        channel: decision.channel,
        sentAt: initialSentAt(decision.channel, now),
        dedupeKey,
        createdAt: now,
      };
      let row: Notification;
      if (dedupeKey) {
        // ON CONFLICT DO NOTHING on (user_id, dedupe_key): a concurrent delivery of the same
        // event cannot create a duplicate, and losing the race does not abort the caller's
        // transaction the way a unique violation would.
        const inserted = await db.notification.createMany({ data: [data], skipDuplicates: true });
        if (inserted.count === 0) {
          const winner = await this.findByDedupeKey(db, input.userId, dedupeKey);
          if (!winner) {
            throw new Error(`Notification ${dedupeKey} conflicted but cannot be read back`);
          }
          return { status: 'replayed', notification: toNotificationSummary(winner) };
        }
        const created = await db.notification.findUnique({ where: { id } });
        if (!created) {
          throw new Error(`Notification ${id} was inserted but cannot be read back`);
        }
        row = created;
      } else {
        row = await db.notification.create({ data });
      }
      await this.outbox.publish(
        db,
        buildOutboxEvent(NOTIFICATION_EVENTS.created, OUTBOX_AGGREGATES.notification, id, {
          notificationId: id,
          userId: input.userId,
          kind,
          channel: decision.channel,
        }),
      );
      return { status: 'created', notification: toNotificationSummary(row) };
    });
  }

  async countUnread(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  /** Newest first; cursor = (createdAt, id) of the last row. */
  async list(userId: string, input: ListNotificationsInput): Promise<Page<NotificationSummary>> {
    const cursor = decodeCursor<NotificationCursor>(input.cursor, isNotificationCursor);
    const where: Prisma.NotificationWhereInput = { userId };
    if (input.unread) {
      where.readAt = null;
    }
    if (input.kind) {
      where.kind = input.kind;
    }
    if (cursor) {
      const createdAt = new Date(cursor.createdAt);
      where.AND = [
        { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }] },
      ];
    }
    const rows = await this.prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
    });
    return toPage(rows.map(toNotificationSummary), input.limit, (last) => ({
      createdAt: last.createdAt.toISOString(),
      id: last.id,
    }));
  }

  /** Throws PC_NOTIFICATION_NOT_FOUND when the row does not exist or belongs to someone else. */
  async getForUser(userId: string, notificationId: string): Promise<NotificationSummary> {
    const row = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
    });
    if (!row) {
      throw new DomainError(
        NotificationErrors.PC_NOTIFICATION_NOT_FOUND,
        'Notification not found',
        {
          details: { notificationId },
        },
      );
    }
    return toNotificationSummary(row);
  }

  /** Idempotent: an already read notification keeps its first readAt. */
  async markRead(userId: string, notificationId: string): Promise<NotificationSummary> {
    const current = await this.getForUser(userId, notificationId);
    if (current.readAt) {
      return current;
    }
    const updated = await this.prisma.notification.update({
      where: { id: notificationId },
      data: { readAt: this.clock.now() },
    });
    return toNotificationSummary(updated);
  }

  /** Returns the number of rows that were unread. */
  async markAllRead(userId: string): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: this.clock.now() },
    });
    return result.count;
  }

  async getById(notificationId: string): Promise<NotificationSummary | null> {
    const row = await this.prisma.notification.findUnique({ where: { id: notificationId } });
    return row ? toNotificationSummary(row) : null;
  }

  /**
   * user.deleted: the inbox and preferences are personal data of an anonymised member, so they
   * are deleted (push deliveries go with their notifications through ON DELETE CASCADE).
   * Idempotent: a second run finds nothing to delete.
   */
  async eraseUserData(userId: string): Promise<ErasedNotificationData> {
    return this.prisma.withTx(async (tx) => {
      const notifications = await tx.notification.deleteMany({ where: { userId } });
      const preferences = await tx.notificationPreference.deleteMany({ where: { userId } });
      this.logger.log(
        `Erased ${notifications.count} notifications and ${preferences.count} preferences of deleted user ${userId}`,
      );
      return { notifications: notifications.count, preferences: preferences.count };
    });
  }

  async listDeliveries(notificationId: string): Promise<PushDeliverySummary[]> {
    const rows = await this.prisma.pushDelivery.findMany({
      where: { notificationId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toPushDeliverySummary);
  }

  private findByDedupeKey(
    db: DbClient,
    userId: string,
    dedupeKey: string,
  ): Promise<Notification | null> {
    return db.notification.findFirst({ where: { userId, dedupeKey } });
  }
}

function clampTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length <= MAX_TITLE_LENGTH ? trimmed : trimmed.slice(0, MAX_TITLE_LENGTH);
}
