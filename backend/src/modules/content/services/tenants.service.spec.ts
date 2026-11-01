import { Prisma, type Tenant } from '@prisma/client';
import type { AdminAuditPort } from '../../../common/contracts/admin';
import { CONTENT_EVENTS } from '../../../common/contracts/events';
import type { OutboxService } from '../../../common/outbox/outbox.service';
import { encodeCursor } from '../../../common/pagination/cursor';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { FakeClock } from '../../../common/time/clock';
import type { TenantWithCounts } from './mappers';
import { TenantsService } from './tenants.service';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const ACTOR = { id: '0192f3a0-0000-7000-8000-00000000a001', ip: '10.0.0.1' };

function tenantRow(overrides: Partial<Tenant> = {}): TenantWithCounts {
  return {
    id: '0192f3a0-0000-7000-8000-000000000001',
    slug: 'aroma-kava',
    name: 'Aroma Kava',
    category: 'coffee',
    floor: 1,
    logoKey: null,
    website: null,
    phone: null,
    description: null,
    participates: true,
    ratePercentOverride: null,
    excludedFromProgram: false,
    status: 'active',
    hours: null,
    locationText: null,
    mapImageUrl: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    _count: { fiscalNumbers: 2, loyaltyRules: 0 },
    ...overrides,
  };
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.0',
  });
}

function setup() {
  const tenant = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    groupBy: jest.fn(),
  };
  const tx = { tenant };
  const prisma = {
    ...tx,
    withTx: jest.fn(async (fn: (db: unknown) => Promise<unknown>) => fn(tx)),
  };
  const audit = { audit: jest.fn().mockResolvedValue('audit-1') } satisfies AdminAuditPort;
  const outbox = { publish: jest.fn().mockResolvedValue('event-1') };
  const service = new TenantsService(
    prisma as unknown as PrismaService,
    new FakeClock(NOW),
    outbox as unknown as OutboxService,
    audit,
  );
  return { service, prisma, tenant, audit, outbox };
}

describe('TenantsService', () => {
  describe('list', () => {
    it('restricts the public list to active tenants and builds the filters', async () => {
      const { service, tenant } = setup();
      tenant.findMany.mockResolvedValue([tenantRow()]);

      const page = await service.listPublic({
        participates: true,
        category: 'coffee',
        q: ' Арома ',
        limit: 20,
      });

      expect(page).toEqual({ items: [tenantRow()], nextCursor: null });
      const args = tenant.findMany.mock.calls[0][0];
      expect(args.take).toBe(21);
      expect(args.orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }]);
      expect(args.where.AND).toEqual([
        { status: 'active' },
        { participates: true },
        { category: 'coffee' },
        {
          OR: [
            { name: { contains: 'Арома', mode: 'insensitive' } },
            { slug: { contains: 'aroma' } },
          ],
        },
      ]);
    });

    it('continues after the (name, id) cursor and returns the next cursor', async () => {
      const { service, tenant } = setup();
      const rows = [
        tenantRow({ id: 'id-1', name: 'A' }),
        tenantRow({ id: 'id-2', name: 'B' }),
        tenantRow({ id: 'id-3', name: 'C' }),
      ];
      tenant.findMany.mockResolvedValue(rows);
      const cursor = encodeCursor({ name: 'Start', id: 'id-0' });

      const page = await service.list({ cursor, limit: 2 });

      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBe(encodeCursor({ name: 'B', id: 'id-2' }));
      expect(tenant.findMany.mock.calls[0][0].where.AND).toEqual([
        { OR: [{ name: { gt: 'Start' } }, { name: 'Start', id: { gt: 'id-0' } }] },
      ]);
    });

    it('rejects a cursor from another list', async () => {
      const { service } = setup();
      await expect(
        service.list({ cursor: encodeCursor({ id: 'x' }), limit: 5 }),
      ).rejects.toMatchObject({ code: 'PC_COMMON_CURSOR_INVALID' });
    });

    it('summarises categories of active tenants', async () => {
      const { service, tenant } = setup();
      tenant.groupBy.mockResolvedValue([
        { category: 'coffee', _count: { _all: 2 } },
        { category: 'fashion', _count: { _all: 1 } },
      ]);
      await expect(service.categoriesSummary()).resolves.toEqual([
        { category: 'coffee', count: 2 },
        { category: 'fashion', count: 1 },
      ]);
      expect(tenant.groupBy.mock.calls[0][0].where).toEqual({ status: 'active' });
    });
  });

  describe('getPublicBySlug', () => {
    it('returns an active tenant', async () => {
      const { service, tenant } = setup();
      tenant.findUnique.mockResolvedValue(tenantRow());
      await expect(service.getPublicBySlug('aroma-kava')).resolves.toMatchObject({
        slug: 'aroma-kava',
      });
    });

    it.each(['hidden', 'closed'] as const)('answers 404 for a %s tenant', async (status) => {
      const { service, tenant } = setup();
      tenant.findUnique.mockResolvedValue(tenantRow({ status }));
      await expect(service.getPublicBySlug('aroma-kava')).rejects.toMatchObject({
        code: 'PC_TENANT_NOT_FOUND',
        status: 404,
      });
    });

    it('answers 404 for an unknown slug', async () => {
      const { service, tenant } = setup();
      tenant.findUnique.mockResolvedValue(null);
      await expect(service.getPublicBySlug('nope')).rejects.toMatchObject({
        code: 'PC_TENANT_NOT_FOUND',
      });
    });
  });

  describe('create', () => {
    it('derives the slug from a Cyrillic name and audits the creation', async () => {
      const { service, tenant, audit, outbox } = setup();
      tenant.findUnique.mockResolvedValue(null);
      tenant.create.mockImplementation(async ({ data }: { data: Tenant }) => data);

      const row = await service.create(
        { name: 'ТамТам', category: 'hypermarket', excludedFromProgram: true },
        ACTOR,
      );

      expect(row).toMatchObject({
        slug: 'tamtam',
        name: 'ТамТам',
        participates: true,
        excludedFromProgram: true,
        status: 'active',
        createdAt: NOW,
        _count: { fiscalNumbers: 0, loyaltyRules: 0 },
      });
      expect(audit.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: { type: 'admin', id: ACTOR.id },
          action: 'tenant.create',
          entityType: 'tenant',
          entityId: row.id,
          ip: ACTOR.ip,
          after: expect.objectContaining({ slug: 'tamtam', excludedFromProgram: true }),
        }),
        expect.anything(),
      );
      expect(outbox.publish).not.toHaveBeenCalled();
    });

    it('rejects a taken slug before writing', async () => {
      const { service, tenant, audit } = setup();
      tenant.findUnique.mockResolvedValue({ id: 'other' });
      await expect(
        service.create({ slug: 'aroma-kava', name: 'Aroma Kava', category: 'coffee' }, ACTOR),
      ).rejects.toMatchObject({ code: 'PC_TENANT_SLUG_TAKEN', status: 409 });
      expect(tenant.create).not.toHaveBeenCalled();
      expect(audit.audit).not.toHaveBeenCalled();
    });

    it('maps a unique violation from a concurrent create to PC_TENANT_SLUG_TAKEN', async () => {
      const { service, tenant } = setup();
      tenant.findUnique.mockResolvedValue(null);
      tenant.create.mockRejectedValue(uniqueViolation());
      await expect(
        service.create({ name: 'Aroma Kava', category: 'coffee' }, ACTOR),
      ).rejects.toMatchObject({
        code: 'PC_TENANT_SLUG_TAKEN',
      });
    });

    it('asks for an explicit slug when the name has no usable characters', async () => {
      const { service, tenant } = setup();
      await expect(service.create({ name: '!!!', category: 'other' }, ACTOR)).rejects.toMatchObject(
        {
          code: 'PC_COMMON_VALIDATION',
        },
      );
      expect(tenant.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('is a no-op when nothing changes', async () => {
      const { service, tenant, audit, outbox } = setup();
      const current = tenantRow();
      tenant.findUnique.mockResolvedValue(current);

      const result = await service.update(current.id, { name: 'Aroma Kava', floor: 1 }, ACTOR);

      expect(result).toBe(current);
      expect(tenant.update).not.toHaveBeenCalled();
      expect(audit.audit).not.toHaveBeenCalled();
      expect(outbox.publish).not.toHaveBeenCalled();
    });

    it('writes, audits and announces only the changed fields', async () => {
      const { service, tenant, audit, outbox } = setup();
      const current = tenantRow();
      tenant.findUnique.mockResolvedValue(current);
      tenant.update.mockImplementation(async ({ data }: { data: Partial<Tenant> }) => ({
        ...current,
        ...data,
      }));

      await service.update(
        current.id,
        { name: 'Aroma Kava', ratePercentOverride: 5, floor: 2 },
        ACTOR,
      );

      expect(tenant.update.mock.calls[0][0].data).toEqual({
        ratePercentOverride: 5,
        floor: 2,
        updatedAt: NOW,
      });
      expect(audit.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'tenant.update',
          before: { floor: 1, ratePercentOverride: null },
          after: { floor: 2, ratePercentOverride: 5 },
        }),
        expect.anything(),
      );
      expect(outbox.publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: CONTENT_EVENTS.tenantUpdated,
          aggregateId: current.id,
          payload: {
            tenantId: current.id,
            slug: 'aroma-kava',
            changedFields: ['floor', 'ratePercentOverride'],
          },
        }),
      );
    });

    it('clears nullable fields with null', async () => {
      const { service, tenant } = setup();
      const current = tenantRow({ website: 'https://aromakava.ua' });
      tenant.findUnique.mockResolvedValue(current);
      tenant.update.mockResolvedValue({ ...current, website: null });
      await service.update(current.id, { website: null }, ACTOR);
      expect(tenant.update.mock.calls[0][0].data).toEqual({ website: null, updatedAt: NOW });
    });

    it('enforces the tenant status machine', async () => {
      const { service, tenant } = setup();
      tenant.findUnique.mockResolvedValue(tenantRow({ status: 'closed' }));
      await expect(service.update('id', { status: 'hidden' }, ACTOR)).rejects.toMatchObject({
        code: 'PC_TENANT_INVALID_TRANSITION',
        status: 409,
      });
      expect(tenant.update).not.toHaveBeenCalled();
    });

    it('rejects a slug used by another tenant', async () => {
      const { service, tenant } = setup();
      tenant.findUnique
        .mockResolvedValueOnce(tenantRow())
        .mockResolvedValueOnce({ id: 'someone-else' });
      await expect(
        service.update(tenantRow().id, { slug: 'intertop' }, ACTOR),
      ).rejects.toMatchObject({
        code: 'PC_TENANT_SLUG_TAKEN',
      });
    });

    it('answers 404 for an unknown tenant', async () => {
      const { service, tenant } = setup();
      tenant.findUnique.mockResolvedValue(null);
      await expect(service.update('missing', { name: 'X' }, ACTOR)).rejects.toMatchObject({
        code: 'PC_TENANT_NOT_FOUND',
      });
    });
  });

  describe('hours, location and map', () => {
    it('stores normalised hours, location and map on create', async () => {
      const { service, tenant } = setup();
      tenant.findUnique.mockResolvedValue(null);
      tenant.create.mockImplementation(async ({ data }: { data: Partial<Tenant> }) => ({
        ...tenantRow(),
        ...data,
      }));
      await service.create(
        {
          name: 'Aroma Kava',
          category: 'coffee',
          hours: { mon: ['9:00-21:00'], sun: [] },
          locationText: '1 поверх',
          mapImageUrl: 'https://cdn.example/mall/floor-1.png',
        },
        ACTOR,
      );
      expect(tenant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          hours: { mon: ['09:00-21:00'], sun: [] },
          locationText: '1 поверх',
          mapImageUrl: 'https://cdn.example/mall/floor-1.png',
        }),
      });
    });

    it('refuses malformed hours with PC_COMMON_VALIDATION before writing', async () => {
      const { service, tenant } = setup();
      await expect(
        service.create({ name: 'Aroma Kava', category: 'coffee', hours: { mon: ['late'] } }, ACTOR),
      ).rejects.toMatchObject({
        code: 'PC_COMMON_VALIDATION',
        details: { field: 'hours' },
      });
      await expect(
        service.update(tenantRow().id, { hours: { monday: ['10:00-20:00'] } }, ACTOR),
      ).rejects.toMatchObject({ code: 'PC_COMMON_VALIDATION' });
      expect(tenant.create).not.toHaveBeenCalled();
      expect(tenant.update).not.toHaveBeenCalled();
    });

    it('updates hours only when they really change and clears them with DbNull', async () => {
      const { service, tenant, audit } = setup();
      const current = tenantRow({ hours: { mon: ['10:00-20:00'] } });
      tenant.findUnique.mockResolvedValue(current);
      tenant.update.mockImplementation(async ({ data }: { data: Partial<Tenant> }) => ({
        ...current,
        ...data,
      }));

      // Same schedule written differently: nothing to do.
      await service.update(current.id, { hours: { mon: ['10:00 - 20:00'] } }, ACTOR);
      expect(tenant.update).not.toHaveBeenCalled();

      await service.update(current.id, { hours: null, locationText: '2 поверх' }, ACTOR);
      expect(tenant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ hours: Prisma.DbNull, locationText: '2 поверх' }),
        }),
      );
      expect(audit.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          before: { hours: { mon: ['10:00-20:00'] }, locationText: null },
        }),
        expect.anything(),
      );
    });
  });

  describe('getPublicById', () => {
    it('returns active tenants and hides hidden or unknown ones', async () => {
      const { service, tenant } = setup();
      tenant.findUnique.mockResolvedValueOnce(tenantRow());
      await expect(service.getPublicById(tenantRow().id)).resolves.toMatchObject({
        slug: 'aroma-kava',
      });
      tenant.findUnique.mockResolvedValueOnce(tenantRow({ status: 'hidden' }));
      await expect(service.getPublicById(tenantRow().id)).rejects.toMatchObject({
        code: 'PC_TENANT_NOT_FOUND',
        status: 404,
      });
      tenant.findUnique.mockResolvedValueOnce(null);
      await expect(service.getPublicById(tenantRow().id)).rejects.toMatchObject({
        code: 'PC_TENANT_NOT_FOUND',
      });
    });
  });

  describe('close', () => {
    it('sets status closed with the tenant.close audit action', async () => {
      const { service, tenant, audit } = setup();
      const current = tenantRow();
      tenant.findUnique.mockResolvedValue(current);
      tenant.update.mockResolvedValue({ ...current, status: 'closed' });

      const row = await service.close(current.id, ACTOR);

      expect(row.status).toBe('closed');
      expect(tenant.update.mock.calls[0][0].data).toEqual({ status: 'closed', updatedAt: NOW });
      expect(audit.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'tenant.close',
          before: { status: 'active' },
          after: { status: 'closed' },
        }),
        expect.anything(),
      );
    });

    it('is idempotent for an already closed tenant', async () => {
      const { service, tenant, audit } = setup();
      tenant.findUnique.mockResolvedValue(tenantRow({ status: 'closed' }));
      await service.close('id', ACTOR);
      expect(tenant.update).not.toHaveBeenCalled();
      expect(audit.audit).not.toHaveBeenCalled();
    });
  });

  it('findByIds skips the query for an empty list and de-duplicates ids', async () => {
    const { service, tenant } = setup();
    await expect(service.findByIds([])).resolves.toEqual([]);
    expect(tenant.findMany).not.toHaveBeenCalled();
    tenant.findMany.mockResolvedValue([]);
    await service.findByIds(['a', 'a', 'b']);
    expect(tenant.findMany.mock.calls[0][0]).toEqual({ where: { id: { in: ['a', 'b'] } } });
  });
});
