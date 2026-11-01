import { Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { AUDIT_ACTION_PATTERN, type AdminAuditPort, type AuditEntry } from '../contracts/admin';
import { toJsonValue } from '../idempotency/idempotency.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { Clock } from '../time/clock';

/**
 * Append-only audit trail (table audit_logs in base.prisma, protected by a trigger).
 * Implements ADMIN_AUDIT_PORT for every module; the admin module reads the log.
 */
@Injectable()
export class AuditService implements AdminAuditPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async audit(entry: AuditEntry, tx?: Tx): Promise<string> {
    if (!AUDIT_ACTION_PATTERN.test(entry.action)) {
      throw new Error(
        `Invalid audit action "${entry.action}": expected "<entity>.<verb>" in lowercase`,
      );
    }
    const id = uuidv7();
    const db = tx ?? this.prisma;
    await db.auditLog.create({
      data: {
        id,
        actorType: entry.actor.type,
        actorId: entry.actor.id ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId:
          entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
        before: entry.before === undefined ? undefined : toJsonValue(entry.before),
        after: entry.after === undefined ? undefined : toJsonValue(entry.after),
        reason: entry.reason ?? null,
        ip: entry.ip ?? null,
        createdAt: this.clock.now(),
      },
    });
    return id;
  }
}
