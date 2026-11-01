import { Injectable } from '@nestjs/common';
import type { NotificationKind } from '../../../common/contracts/notifications';
import { DomainError } from '../../../common/errors/domain-error';
import { PrismaService, type DbClient } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { NotificationErrors } from '../domain/errors';
import {
  NOTIFICATION_KIND_SPECS,
  type NotificationCategory,
  canOptOut,
  isNotificationKind,
} from '../domain/kinds';

export interface PreferenceView {
  kind: NotificationKind;
  category: NotificationCategory;
  enabled: boolean;
  /** True for service kinds that cannot be switched off. */
  locked: boolean;
}

export interface PreferenceUpdate {
  kind: string;
  enabled: boolean;
}

/** Per-kind opt-in/opt-out (table notification_preferences; a missing row means enabled). */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Stored flag for one kind, null when the member never changed it. */
  async getStored(db: DbClient, userId: string, kind: NotificationKind): Promise<boolean | null> {
    const row = await db.notificationPreference.findUnique({
      where: { userId_kind: { userId, kind } },
    });
    return row ? row.enabled : null;
  }

  /** Every registered kind with its effective flag, in registry order. */
  async getAll(userId: string): Promise<PreferenceView[]> {
    const rows = await this.prisma.notificationPreference.findMany({ where: { userId } });
    const stored = new Map(rows.map((row) => [row.kind, row.enabled]));
    return NOTIFICATION_KIND_SPECS.map((spec) => ({
      kind: spec.kind,
      category: spec.category,
      locked: !spec.optOut,
      enabled: spec.optOut ? (stored.get(spec.kind) ?? true) : true,
    }));
  }

  /**
   * Upserts the given kinds (last entry wins for duplicates) and returns the full list.
   * Unknown kinds -> PC_NOTIFICATION_KIND_UNKNOWN; disabling a locked kind ->
   * PC_NOTIFICATION_PREFERENCE_LOCKED.
   */
  async update(userId: string, updates: readonly PreferenceUpdate[]): Promise<PreferenceView[]> {
    const merged = new Map<NotificationKind, boolean>();
    for (const update of updates) {
      if (!isNotificationKind(update.kind)) {
        throw new DomainError(
          NotificationErrors.PC_NOTIFICATION_KIND_UNKNOWN,
          `Unknown notification kind "${update.kind}"`,
          { details: { kind: update.kind } },
        );
      }
      if (!update.enabled && !canOptOut(update.kind)) {
        throw new DomainError(
          NotificationErrors.PC_NOTIFICATION_PREFERENCE_LOCKED,
          `Notifications of kind "${update.kind}" cannot be switched off`,
          { details: { kind: update.kind } },
        );
      }
      merged.set(update.kind, update.enabled);
    }
    if (merged.size > 0) {
      const now = this.clock.now();
      await this.prisma.withTx(async (tx) => {
        for (const [kind, enabled] of merged) {
          await tx.notificationPreference.upsert({
            where: { userId_kind: { userId, kind } },
            create: { userId, kind, enabled, updatedAt: now },
            update: { enabled, updatedAt: now },
          });
        }
      });
    }
    return this.getAll(userId);
  }
}
