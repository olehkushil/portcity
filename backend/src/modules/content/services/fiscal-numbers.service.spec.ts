import type { Tenant } from '@prisma/client';
import type { AdminAuditPort } from '../../../common/contracts/admin';
import { CONTENT_EVENTS } from '../../../common/contracts/events';
import type { OutboxService } from '../../../common/outbox/outbox.service';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { FakeClock } from '../../../common/time/clock';
import { FiscalNumbersService } from './fiscal-numbers.service';
import type { FiscalNumberWithTenant } from './mappers';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const ACTOR = { id: '0192f3a0-0000-7000-8000-00000000a001', ip: '10.0.0.1' };
const TENANT_ID = '0192f3a0-0000-7000-8000-000000000001';
const FN_ID = '0192f3a0-0000-7000-8000-0000000000f1';

const tenant: Tenant = {
  id: TENANT_ID,
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
  createdAt: NOW,
  updatedAt: NOW,
};

function fnRow(overrides: Partial<FiscalNumberWithTenant> = {}): FiscalNumberWithTenant {
  return {
    id: FN_ID,
    fn: '4000100011',
    tenantId: null,
    tenant: null,
    status: 'pending',
    source: 'receipt',
    firstSeenAt: NOW,
    confirmedById: null,
    confirmedAt: null,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function setup() {
  const tenantFiscalNumber = {
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const tenantModel = { findUnique: jest.fn().mockResolvedValue({ id: TENANT_ID }) };
  const tx = {
    tenantFiscalNumber,
    tenant: tenantModel,
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const prisma = {
    ...tx,
    withTx: jest.fn(async (fn: (db: unknown) => Promise<unknown>) => fn(tx)),
    runInTx: jest.fn(async (given: unknown, fn: (db: unknown) => Promise<unknown>) =>
      fn(given ?? tx),
    ),
  };
  const audit = { audit: jest.fn().mockResolvedValue('audit-1') } satisfies AdminAuditPort;
  const outbox = { publish: jest.fn().mockResolvedValue('event-1') };
  const service = new FiscalNumbersService(
    prisma as unknown as PrismaService,
    new FakeClock(NOW),
    outbox as unknown as OutboxService,
    audit,
  );
  return { service, prisma, tx, tenantFiscalNumber, tenantModel, audit, outbox };
}

describe('FiscalNumbersService', () => {
  describe('lookup (ContentPort.findTenantByFiscalNumber)', () => {
    it('returns null for malformed numbers without touching the database', async () => {
      const { service, tenantFiscalNumber } = setup();
      await expect(service.lookup('12ab')).resolves.toBeNull();
      expect(tenantFiscalNumber.findUnique).not.toHaveBeenCalled();
    });

    it('normalises inner spaces and maps the tenant summary', async () => {
      const { service, tenantFiscalNumber } = setup();
      tenantFiscalNumber.findUnique.mockResolvedValue(
        fnRow({ status: 'active', tenantId: TENANT_ID, tenant }),
      );
      const result = await service.lookup(' 4000 1000 11 ');
      expect(tenantFiscalNumber.findUnique.mock.calls[0][0].where).toEqual({ fn: '4000100011' });
      expect(result).toEqual({
        fn: '4000100011',
        status: 'active',
        source: 'receipt',
        tenantId: TENANT_ID,
        tenant: expect.objectContaining({
          id: TENANT_ID,
          slug: 'aroma-kava',
          excludedFromProgram: false,
        }),
        firstSeenAt: NOW,
      });
    });

    it('returns null for an unknown number', async () => {
      const { service, tenantFiscalNumber } = setup();
      tenantFiscalNumber.findUnique.mockResolvedValue(null);
      await expect(service.lookup('4000100011')).resolves.toBeNull();
    });
  });

  describe('recordSeen (ContentPort.recordSeenFiscalNumber)', () => {
    it('inserts a pending row and announces it once', async () => {
      const { service, tx, tenantFiscalNumber, outbox } = setup();
      tenantFiscalNumber.findUniqueOrThrow.mockResolvedValue(fnRow());

      const result = await service.recordSeen('4000100011', undefined, { receiptId: 'receipt-1' });

      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ fn: '4000100011', status: 'pending', source: 'receipt' });
      expect(outbox.publish).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          type: CONTENT_EVENTS.fiscalNumberSeen,
          aggregateId: FN_ID,
          payload: { fn: '4000100011', receiptId: 'receipt-1' },
        }),
      );
    });

    it('returns the existing row without an event when the number is known', async () => {
      const { service, tx, tenantFiscalNumber, outbox } = setup();
      tx.$executeRaw.mockResolvedValue(0);
      tenantFiscalNumber.findUniqueOrThrow.mockResolvedValue(
        fnRow({ status: 'active', tenantId: TENANT_ID, tenant, source: 'admin' }),
      );
      const result = await service.recordSeen('4000100011');
      expect(result).toMatchObject({ status: 'active', tenantId: TENANT_ID });
      expect(outbox.publish).not.toHaveBeenCalled();
    });

    it("joins the caller's transaction", async () => {
      const { service, prisma, tenantFiscalNumber } = setup();
      const callerTx = {
        tenantFiscalNumber,
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      tenantFiscalNumber.findUniqueOrThrow.mockResolvedValue(fnRow());
      await service.recordSeen('4000100011', callerTx as never);
      expect(prisma.runInTx).toHaveBeenCalledWith(callerTx, expect.any(Function));
      expect(callerTx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(prisma.withTx).not.toHaveBeenCalled();
    });

    it('rejects a malformed number with PC_FISCAL_NUMBER_INVALID', async () => {
      const { service } = setup();
      await expect(service.recordSeen('abc')).rejects.toMatchObject({
        code: 'PC_FISCAL_NUMBER_INVALID',
        status: 400,
      });
    });
  });

  describe('create', () => {
    it('creates an active mapped number, confirmed by the admin, and announces it', async () => {
      const { service, tenantFiscalNumber, audit, outbox } = setup();
      tenantFiscalNumber.findUnique.mockResolvedValue(null);
      tenantFiscalNumber.create.mockImplementation(
        async ({ data }: { data: FiscalNumberWithTenant }) => ({ ...data, tenant }),
      );

      const row = await service.create(
        { fn: '4000 1000 22', tenantId: TENANT_ID, note: 'каса 2' },
        ACTOR,
      );

      expect(row).toMatchObject({
        fn: '4000100022',
        status: 'active',
        source: 'admin',
        confirmedById: ACTOR.id,
        confirmedAt: NOW,
        note: 'каса 2',
      });
      expect(audit.audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'fiscal_number.create', reason: 'каса 2' }),
        expect.anything(),
      );
      expect(outbox.publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: CONTENT_EVENTS.fiscalNumberConfirmed,
          payload: {
            fn: '4000100022',
            tenantId: TENANT_ID,
            status: 'active',
            confirmedById: ACTOR.id,
          },
        }),
      );
    });

    it('defaults to pending without a tenant and does not announce it', async () => {
      const { service, tenantFiscalNumber, outbox } = setup();
      tenantFiscalNumber.findUnique.mockResolvedValue(null);
      tenantFiscalNumber.create.mockImplementation(
        async ({ data }: { data: FiscalNumberWithTenant }) => ({ ...data, tenant: null }),
      );
      const row = await service.create({ fn: '4000100033' }, ACTOR);
      expect(row).toMatchObject({ status: 'pending', confirmedById: null, confirmedAt: null });
      expect(outbox.publish).not.toHaveBeenCalled();
    });

    it('requires a tenant for an active number', async () => {
      const { service, tenantFiscalNumber } = setup();
      await expect(
        service.create({ fn: '4000100011', status: 'active' }, ACTOR),
      ).rejects.toMatchObject({
        code: 'PC_FISCAL_NUMBER_TENANT_REQUIRED',
        status: 422,
      });
      expect(tenantFiscalNumber.create).not.toHaveBeenCalled();
    });

    it('rejects a registered number with its current state', async () => {
      const { service, tenantFiscalNumber } = setup();
      tenantFiscalNumber.findUnique.mockResolvedValue({
        id: FN_ID,
        status: 'pending',
        tenantId: null,
      });
      await expect(service.create({ fn: '4000100011' }, ACTOR)).rejects.toMatchObject({
        code: 'PC_FISCAL_NUMBER_TAKEN',
        status: 409,
        details: { fn: '4000100011', id: FN_ID, status: 'pending', tenantId: null },
      });
    });

    it('rejects an unknown tenant', async () => {
      const { service, tenantModel } = setup();
      tenantModel.findUnique.mockResolvedValue(null);
      await expect(
        service.create({ fn: '4000100011', tenantId: TENANT_ID }, ACTOR),
      ).rejects.toMatchObject({
        code: 'PC_TENANT_NOT_FOUND',
      });
    });
  });

  describe('confirm / block / update', () => {
    it('confirms a pending number discovered from a receipt', async () => {
      const { service, tenantFiscalNumber, audit, outbox } = setup();
      tenantFiscalNumber.findUnique.mockResolvedValue(fnRow());
      tenantFiscalNumber.update.mockImplementation(
        async ({ data }: { data: Partial<FiscalNumberWithTenant> }) => ({
          ...fnRow(),
          ...data,
          tenant,
        }),
      );

      const row = await service.confirm(FN_ID, { tenantId: TENANT_ID, note: 'перевірено' }, ACTOR);

      expect(tenantFiscalNumber.update.mock.calls[0][0].data).toEqual({
        status: 'active',
        tenantId: TENANT_ID,
        note: 'перевірено',
        confirmedById: ACTOR.id,
        confirmedAt: NOW,
        updatedAt: NOW,
      });
      expect(row.status).toBe('active');
      expect(audit.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'fiscal_number.confirm',
          before: expect.objectContaining({ status: 'pending', tenantId: null }),
          after: expect.objectContaining({ status: 'active', tenantId: TENANT_ID }),
        }),
        expect.anything(),
      );
      expect(outbox.publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: CONTENT_EVENTS.fiscalNumberConfirmed }),
      );
    });

    it('refuses to confirm an unmapped number without tenantId', async () => {
      const { service, tenantFiscalNumber } = setup();
      tenantFiscalNumber.findUnique.mockResolvedValue(fnRow());
      await expect(service.confirm(FN_ID, {}, ACTOR)).rejects.toMatchObject({
        code: 'PC_FISCAL_NUMBER_TENANT_REQUIRED',
      });
      expect(tenantFiscalNumber.update).not.toHaveBeenCalled();
    });

    it('blocks an active number and announces the status change', async () => {
      const { service, tenantFiscalNumber, outbox } = setup();
      const active = fnRow({ status: 'active', tenantId: TENANT_ID, tenant, confirmedById: 'x' });
      tenantFiscalNumber.findUnique.mockResolvedValue(active);
      tenantFiscalNumber.update.mockImplementation(
        async ({ data }: { data: Partial<FiscalNumberWithTenant> }) => ({ ...active, ...data }),
      );
      const row = await service.block(FN_ID, { note: 'чужа каса' }, ACTOR);
      expect(row.status).toBe('blocked');
      expect(tenantFiscalNumber.update.mock.calls[0][0].data).toMatchObject({
        status: 'blocked',
        confirmedById: ACTOR.id,
      });
      expect(outbox.publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: CONTENT_EVENTS.fiscalNumberConfirmed,
          payload: expect.objectContaining({ status: 'blocked' }),
        }),
      );
    });

    it('does not allow active -> pending', async () => {
      const { service, tenantFiscalNumber } = setup();
      tenantFiscalNumber.findUnique.mockResolvedValue(
        fnRow({ status: 'active', tenantId: TENANT_ID, tenant }),
      );
      await expect(service.update(FN_ID, { status: 'pending' }, ACTOR)).rejects.toMatchObject({
        code: 'PC_FISCAL_NUMBER_INVALID_TRANSITION',
        status: 409,
      });
    });

    it('updates only the note without an event', async () => {
      const { service, tenantFiscalNumber, outbox, audit } = setup();
      tenantFiscalNumber.findUnique.mockResolvedValue(fnRow());
      tenantFiscalNumber.update.mockResolvedValue(fnRow({ note: 'дзвонили' }));
      await service.update(FN_ID, { note: 'дзвонили' }, ACTOR);
      expect(tenantFiscalNumber.update.mock.calls[0][0].data).toEqual({
        status: 'pending',
        tenantId: null,
        note: 'дзвонили',
        updatedAt: NOW,
      });
      expect(audit.audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'fiscal_number.update' }),
        expect.anything(),
      );
      expect(outbox.publish).not.toHaveBeenCalled();
    });

    it('re-announces a remap of an active number', async () => {
      const { service, tenantFiscalNumber, outbox } = setup();
      const active = fnRow({ status: 'active', tenantId: 'old-tenant', tenant });
      tenantFiscalNumber.findUnique.mockResolvedValue(active);
      tenantFiscalNumber.update.mockImplementation(
        async ({ data }: { data: Partial<FiscalNumberWithTenant> }) => ({ ...active, ...data }),
      );
      await service.update(FN_ID, { tenantId: TENANT_ID }, ACTOR);
      expect(outbox.publish).toHaveBeenCalledTimes(1);
    });

    it('is a no-op without changes', async () => {
      const { service, tenantFiscalNumber, audit } = setup();
      const current = fnRow();
      tenantFiscalNumber.findUnique.mockResolvedValue(current);
      await expect(service.update(FN_ID, { status: 'pending' }, ACTOR)).resolves.toBe(current);
      expect(tenantFiscalNumber.update).not.toHaveBeenCalled();
      expect(audit.audit).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown id', async () => {
      const { service, tenantFiscalNumber } = setup();
      tenantFiscalNumber.findUnique.mockResolvedValue(null);
      await expect(service.block(FN_ID, {}, ACTOR)).rejects.toMatchObject({
        code: 'PC_FISCAL_NUMBER_NOT_FOUND',
        status: 404,
      });
    });
  });

  describe('remove', () => {
    it('refuses to delete an active number', async () => {
      const { service, tenantFiscalNumber } = setup();
      tenantFiscalNumber.findUnique.mockResolvedValue(
        fnRow({ status: 'active', tenantId: TENANT_ID, tenant }),
      );
      await expect(service.remove(FN_ID, ACTOR)).rejects.toMatchObject({
        code: 'PC_FISCAL_NUMBER_INVALID_TRANSITION',
      });
      expect(tenantFiscalNumber.delete).not.toHaveBeenCalled();
    });

    it('deletes a pending number and audits it', async () => {
      const { service, tenantFiscalNumber, audit } = setup();
      tenantFiscalNumber.findUnique.mockResolvedValue(fnRow());
      await service.remove(FN_ID, ACTOR);
      expect(tenantFiscalNumber.delete).toHaveBeenCalledWith({ where: { id: FN_ID } });
      expect(audit.audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'fiscal_number.delete', entityId: FN_ID }),
        expect.anything(),
      );
    });
  });

  it('lists newest first with filters and a prefix search', async () => {
    const { service, tenantFiscalNumber } = setup();
    tenantFiscalNumber.findMany.mockResolvedValue([fnRow()]);
    const page = await service.list({ status: 'pending', unmapped: true, q: '4000 1', limit: 10 });
    expect(page).toEqual({ items: [fnRow()], nextCursor: null });
    expect(tenantFiscalNumber.findMany.mock.calls[0][0]).toMatchObject({
      where: { status: 'pending', tenantId: null, fn: { startsWith: '40001' } },
      orderBy: { id: 'desc' },
      take: 11,
    });
  });
});
