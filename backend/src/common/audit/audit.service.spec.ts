import { Prisma } from '@prisma/client';
import type { PrismaService, Tx } from '../prisma/prisma.service';
import { FakeClock } from '../time/clock';
import { AuditService } from './audit.service';

interface FakeDb {
  auditLog: { create: jest.Mock };
}

function fakeDb(): FakeDb {
  return { auditLog: { create: jest.fn().mockResolvedValue(undefined) } };
}

describe('AuditService', () => {
  const clock = new FakeClock('2026-02-01T12:00:00.000Z');

  it('writes an audit row with the actor, snapshots and the clock time', async () => {
    const prisma = fakeDb();
    const service = new AuditService(prisma as unknown as PrismaService, clock);

    const id = await service.audit({
      actor: { type: 'admin', id: 'admin-1' },
      action: 'tenant.update',
      entityType: 'tenant',
      entityId: 'tenant-1',
      before: { name: 'Old' },
      after: { name: 'New' },
      reason: 'rename',
      ip: '127.0.0.1',
    });

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = prisma.auditLog.create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data).toEqual({
      id,
      actorType: 'admin',
      actorId: 'admin-1',
      action: 'tenant.update',
      entityType: 'tenant',
      entityId: 'tenant-1',
      before: { name: 'Old' },
      after: { name: 'New' },
      reason: 'rename',
      ip: '127.0.0.1',
      createdAt: clock.now(),
    });
  });

  it('uses the caller transaction when given and leaves omitted snapshots unset', async () => {
    const prisma = fakeDb();
    const tx = fakeDb();
    const service = new AuditService(prisma as unknown as PrismaService, clock);

    await service.audit(
      {
        actor: { type: 'system', id: 'points-expire' },
        action: 'points.expire',
        entityType: 'loyalty_account',
      },
      tx as unknown as Tx,
    );

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    const call = tx.auditLog.create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data).toMatchObject({
      actorType: 'system',
      actorId: 'points-expire',
      entityId: null,
      reason: null,
      ip: null,
    });
    // undefined means "not set" for Prisma, so the columns stay NULL
    expect(call.data.before).toBeUndefined();
    expect(call.data.after).toBeUndefined();
  });

  it('stores explicit null snapshots as JSON null', async () => {
    const prisma = fakeDb();
    const service = new AuditService(prisma as unknown as PrismaService, clock);
    await service.audit({
      actor: { type: 'user', id: 'user-1' },
      action: 'vehicle.delete',
      entityType: 'vehicle',
      entityId: 'vehicle-1',
      after: null,
    });
    const call = prisma.auditLog.create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data.after).toBe(Prisma.JsonNull);
  });

  it('rejects actions that do not follow <entity>.<verb>', async () => {
    const service = new AuditService(fakeDb() as unknown as PrismaService, clock);
    await expect(
      service.audit({
        actor: { type: 'admin', id: 'a' },
        action: 'Update Tenant',
        entityType: 'tenant',
      }),
    ).rejects.toThrow(/Invalid audit action/);
  });
});
