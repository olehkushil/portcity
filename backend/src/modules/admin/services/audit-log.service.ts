import { Injectable } from '@nestjs/common';
import type { AuditLog, Prisma } from '@prisma/client';
import { DomainError } from '../../../common/errors/domain-error';
import { CommonErrors } from '../../../common/errors/error-codes';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { AuditFilter } from '../domain/audit-filter';
import { LIST_ORDER, cursorOf, isListCursor, keysetWhere } from '../domain/list-cursor';
import type { AuditLogView } from '../domain/views';

export interface AuditListQuery {
  cursor?: string;
  limit: number;
}

export function toAuditLogView(row: AuditLog): AuditLogView {
  return {
    id: row.id,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    before: row.before,
    after: row.after,
    reason: row.reason,
    ip: row.ip,
    createdAt: row.createdAt,
  };
}

/**
 * Read side of the append-only audit trail (writes go through ADMIN_AUDIT_PORT in src/common/audit).
 * Lists are keyset-paginated newest first.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async list(filter: AuditFilter, query: AuditListQuery): Promise<Page<AuditLogView>> {
    const where: Prisma.AuditLogWhereInput = {};
    if (filter.entityType) {
      where.entityType = filter.entityType;
    }
    if (filter.entityId) {
      where.entityId = filter.entityId;
    }
    if (filter.actorType) {
      where.actorType = filter.actorType;
    }
    if (filter.actorId) {
      where.actorId = filter.actorId;
    }
    if (filter.action) {
      where.action =
        filter.action.kind === 'exact' ? filter.action.value : { startsWith: filter.action.value };
    }
    if (filter.from || filter.to) {
      where.createdAt = {
        ...(filter.from ? { gte: filter.from } : {}),
        ...(filter.to ? { lt: filter.to } : {}),
      };
    }
    const cursor = decodeCursor(query.cursor, isListCursor);
    if (cursor) {
      where.AND = [keysetWhere(cursor)];
    }
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [...LIST_ORDER],
      take: query.limit + 1,
    });
    return toPage(rows.map(toAuditLogView), query.limit, cursorOf);
  }

  async get(id: string): Promise<AuditLogView> {
    const row = await this.prisma.auditLog.findUnique({ where: { id } });
    if (!row) {
      throw new DomainError(CommonErrors.PC_COMMON_NOT_FOUND, `Audit entry ${id} does not exist`, {
        details: { auditLogId: id },
      });
    }
    return toAuditLogView(row);
  }
}
