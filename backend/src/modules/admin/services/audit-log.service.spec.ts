import type { AuditLog } from '@prisma/client';
import { decodeCursor } from '../../../common/pagination/cursor';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { normaliseAuditFilter } from '../domain/audit-filter';
import { AuditLogService } from './audit-log.service';

function row(index: number): AuditLog {
  return {
    id: `01900000-0000-7000-8000-00000000000${index}`,
    actorType: 'admin',
    actorId: 'admin-1',
    action: 'tenant.update',
    entityType: 'tenant',
    entityId: 'tenant-1',
    before: { name: 'Old' },
    after: { name: 'New' },
    reason: null,
    ip: '10.0.0.1',
    createdAt: new Date(Date.UTC(2026, 0, 15, 10, 0, 10 - index)),
  };
}

function setup(rows: AuditLog[]) {
  const findMany = jest.fn(async (args: { take: number }) => rows.slice(0, args.take));
  const findUnique = jest.fn(
    async (args: { where: { id: string } }) =>
      rows.find((entry) => entry.id === args.where.id) ?? null,
  );
  const prisma = { auditLog: { findMany, findUnique } };
  return { service: new AuditLogService(prisma as unknown as PrismaService), findMany };
}

describe('AuditLogService', () => {
  it('maps the normalised filter to a Prisma where clause', async () => {
    const { service, findMany } = setup([]);
    const filter = normaliseAuditFilter({
      entityType: 'manual_adjustment',
      entityId: 'adj-1',
      actorType: 'admin',
      actorId: 'admin-1',
      action: 'manual_adjustment.*',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-02-01T00:00:00.000Z'),
    });

    await service.list(filter, { limit: 20 });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        entityType: 'manual_adjustment',
        entityId: 'adj-1',
        actorType: 'admin',
        actorId: 'admin-1',
        action: { startsWith: 'manual_adjustment.' },
        createdAt: {
          gte: new Date('2026-01-01T00:00:00.000Z'),
          lt: new Date('2026-02-01T00:00:00.000Z'),
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21,
    });
  });

  it('pages newest first with a keyset cursor', async () => {
    const rows = [row(1), row(2), row(3)];
    const { service, findMany } = setup(rows);

    const first = await service.list(
      { action: { kind: 'exact', value: 'tenant.update' } },
      { limit: 2 },
    );

    expect(first.items.map((item) => item.id)).toEqual([rows[0]?.id, rows[1]?.id]);
    expect(first.nextCursor).not.toBeNull();
    expect(decodeCursor(first.nextCursor)).toEqual({
      createdAt: rows[1]?.createdAt.toISOString(),
      id: rows[1]?.id,
    });

    await service.list({}, { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(findMany.mock.calls[1]?.[0]).toMatchObject({
      where: {
        AND: [
          {
            OR: [
              { createdAt: { lt: rows[1]?.createdAt } },
              { createdAt: rows[1]?.createdAt, id: { lt: rows[1]?.id } },
            ],
          },
        ],
      },
    });
  });

  it('rejects a cursor from another list', async () => {
    const { service } = setup([]);
    const foreign = Buffer.from(JSON.stringify({ priority: 1 }), 'utf8').toString('base64url');
    await expect(service.list({}, { limit: 20, cursor: foreign })).rejects.toMatchObject({
      code: 'PC_COMMON_CURSOR_INVALID',
    });
  });

  it('returns one entry or 404', async () => {
    const rows = [row(1)];
    const { service } = setup(rows);
    await expect(service.get(rows[0]!.id)).resolves.toMatchObject({ action: 'tenant.update' });
    await expect(service.get('01900000-0000-7000-8000-00000000dead')).rejects.toMatchObject({
      code: 'PC_COMMON_NOT_FOUND',
      status: 404,
    });
  });
});
