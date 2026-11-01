import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ADMIN_AUDIT_PORT,
  type AdminAuditPort,
  type FeatureFlagView,
} from '../../../common/contracts/admin';
import {
  ADMIN_EVENTS,
  OUTBOX_AGGREGATES,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import type { ActorRef } from '../../../common/contracts/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { FeatureFlagsService } from '../../../common/feature-flags/feature-flags.service';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { AdminErrors } from '../domain/errors';
import {
  type FeatureFlagSnapshot,
  type FeatureFlagUpdate,
  assertFeatureFlagKey,
  featureFlagChanged,
  nextFeatureFlagState,
  toFeatureFlagSnapshot,
  toFeatureFlagView,
} from '../domain/feature-flag-rules';
import type { AdminActor } from '../domain/views';

const ENTITY_TYPE = 'feature_flag';

export interface FeatureFlagWriteInput extends FeatureFlagUpdate {
  /** Stored in the audit row. */
  reason?: string;
}

function actorRef(actor: AdminActor): ActorRef {
  return { type: 'admin', id: actor.id };
}

function payloadColumn(
  snapshot: FeatureFlagSnapshot,
): Prisma.InputJsonObject | typeof Prisma.JsonNull {
  return snapshot.payload === null ? Prisma.JsonNull : (snapshot.payload as Prisma.InputJsonObject);
}

function cleanReason(reason: string | undefined): string | null {
  const trimmed = reason?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Write side of feature flags (table feature_flags in base.prisma; the admin module is the only
 * writer, see docs/FOUNDATION_SUMMARY.md section 3). Every change is audited, published as
 * `flag.updated` and evicted from the FeatureFlagsService cache of this process; other API
 * replicas pick it up within FEATURE_FLAG_CACHE_TTL_MS.
 */
@Injectable()
export class FeatureFlagsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly featureFlags: FeatureFlagsService,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  async list(): Promise<FeatureFlagView[]> {
    const rows = await this.prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
    return rows.map(toFeatureFlagView);
  }

  async get(key: string): Promise<FeatureFlagView> {
    assertFeatureFlagKey(key);
    const row = await this.prisma.featureFlag.findUnique({ where: { key } });
    if (!row) {
      throw this.notFound(key);
    }
    return toFeatureFlagView(row);
  }

  /** Creates or updates the flag; a write that changes nothing is a no-op (no audit, no event). */
  async upsert(
    key: string,
    input: FeatureFlagWriteInput,
    actor: AdminActor,
  ): Promise<FeatureFlagView> {
    assertFeatureFlagKey(key);
    const now = this.clock.now();
    const view = await this.prisma.withTx(async (tx) => {
      const existing = await tx.featureFlag.findUnique({ where: { key } });
      const before = existing ? toFeatureFlagSnapshot(existing) : null;
      const after = nextFeatureFlagState(before, key, input);
      if (existing && !featureFlagChanged(before, after)) {
        return toFeatureFlagView(existing);
      }
      const payload = payloadColumn(after);
      const row = existing
        ? await tx.featureFlag.update({
            where: { key },
            data: { enabled: after.enabled, payload, updatedAt: now },
          })
        : await tx.featureFlag.create({
            data: { key, enabled: after.enabled, payload, updatedAt: now },
          });
      await this.audit.audit(
        {
          actor: actorRef(actor),
          action: existing ? 'feature_flag.update' : 'feature_flag.create',
          entityType: ENTITY_TYPE,
          entityId: key,
          before,
          after,
          reason: cleanReason(input.reason),
          ip: actor.ip ?? null,
        },
        tx,
      );
      await this.outbox.publish(
        tx,
        buildOutboxEvent(
          ADMIN_EVENTS.flagUpdated,
          OUTBOX_AGGREGATES.featureFlag,
          key,
          { key, enabled: after.enabled, updatedById: actor.id },
          now,
        ),
      );
      return toFeatureFlagView(row);
    });
    this.featureFlags.invalidate(key);
    return view;
  }

  /** Deletes the flag; readers fall back to their defaults afterwards. */
  async remove(key: string, actor: AdminActor, reason?: string): Promise<void> {
    assertFeatureFlagKey(key);
    const now = this.clock.now();
    await this.prisma.withTx(async (tx) => {
      const existing = await tx.featureFlag.findUnique({ where: { key } });
      if (!existing) {
        throw this.notFound(key);
      }
      await tx.featureFlag.delete({ where: { key } });
      await this.audit.audit(
        {
          actor: actorRef(actor),
          action: 'feature_flag.delete',
          entityType: ENTITY_TYPE,
          entityId: key,
          before: toFeatureFlagSnapshot(existing),
          after: null,
          reason: cleanReason(reason),
          ip: actor.ip ?? null,
        },
        tx,
      );
      await this.outbox.publish(
        tx,
        buildOutboxEvent(
          ADMIN_EVENTS.flagUpdated,
          OUTBOX_AGGREGATES.featureFlag,
          key,
          { key, enabled: false, updatedById: actor.id },
          now,
        ),
      );
    });
    this.featureFlags.invalidate(key);
  }

  private notFound(key: string): DomainError {
    return new DomainError(
      AdminErrors.PC_FEATURE_FLAG_NOT_FOUND,
      `Feature flag "${key}" does not exist`,
      { details: { key } },
    );
  }
}
