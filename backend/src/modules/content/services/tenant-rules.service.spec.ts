import type { TenantLoyaltyRule } from '@prisma/client';
import type { AdminAuditPort } from '../../../common/contracts/admin';
import { CONTENT_EVENTS } from '../../../common/contracts/events';
import type { OutboxService } from '../../../common/outbox/outbox.service';
import { encodeCursor } from '../../../common/pagination/cursor';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { FakeClock } from '../../../common/time/clock';
import { TenantRulesService, isRuleOverlapViolation } from './tenant-rules.service';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const ACTOR = { id: '0192f3a0-0000-7000-8000-00000000a001', ip: null };
const TENANT_ID = '0192f3a0-0000-7000-8000-000000000001';
const RULE_ID = '0192f3a0-0000-7000-8000-0000000000r1';

function rule(overrides: Partial<TenantLoyaltyRule> = {}): TenantLoyaltyRule {
  return {
    id: RULE_ID,
    tenantId: TENANT_ID,
    ratePercent: 5,
    minTotalKopecks: 0,
    dailyCapPoints: null,
    validFrom: new Date('2026-11-01T00:00:00.000Z'),
    validTo: new Date('2026-12-01T00:00:00.000Z'),
    createdAt: NOW,
    ...overrides,
  };
}

function setup() {
  const tenantLoyaltyRule = {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(async ({ data }: { data: TenantLoyaltyRule }) => data),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const tenant = { findUnique: jest.fn() };
  const tx = {
    tenantLoyaltyRule,
    tenant,
    $queryRaw: jest.fn().mockResolvedValue([{ id: TENANT_ID, slug: 'aroma-kava' }]),
  };
  const prisma = {
    ...tx,
    withTx: jest.fn(async (fn: (db: unknown) => Promise<unknown>) => fn(tx)),
  };
  const audit = { audit: jest.fn().mockResolvedValue('audit-1') } satisfies AdminAuditPort;
  const outbox = { publish: jest.fn().mockResolvedValue('event-1') };
  const service = new TenantRulesService(
    prisma as unknown as PrismaService,
    new FakeClock(NOW),
    outbox as unknown as OutboxService,
    audit,
  );
  return { service, tx, tenantLoyaltyRule, tenant, audit, outbox };
}

describe('TenantRulesService', () => {
  describe('getEffectiveRule (ContentPort.getTenantRule)', () => {
    it('answers 404 for an unknown tenant', async () => {
      const { service, tenant } = setup();
      tenant.findUnique.mockResolvedValue(null);
      await expect(service.getEffectiveRule(TENANT_ID, NOW)).rejects.toMatchObject({
        code: 'PC_TENANT_NOT_FOUND',
      });
    });

    it('prefers an active rule over the override', async () => {
      const { service, tenant, tenantLoyaltyRule } = setup();
      tenant.findUnique.mockResolvedValue({ id: TENANT_ID, ratePercentOverride: 4 });
      tenantLoyaltyRule.findMany.mockResolvedValue([
        rule({ minTotalKopecks: 10_000, dailyCapPoints: 50 }),
      ]);
      await expect(service.getEffectiveRule(TENANT_ID, NOW)).resolves.toEqual({
        tenantId: TENANT_ID,
        ratePercent: 5,
        minTotalKopecks: 10_000,
        dailyCapPoints: 50,
        source: 'rule',
      });
      expect(tenantLoyaltyRule.findMany.mock.calls[0][0].where).toEqual({
        tenantId: TENANT_ID,
        validFrom: { lte: NOW },
        OR: [{ validTo: null }, { validTo: { gt: NOW } }],
      });
    });

    it('falls back to the override, then to none', async () => {
      const { service, tenant } = setup();
      tenant.findUnique.mockResolvedValueOnce({ id: TENANT_ID, ratePercentOverride: 4 });
      await expect(service.getEffectiveRule(TENANT_ID, NOW)).resolves.toMatchObject({
        ratePercent: 4,
        source: 'override',
      });
      tenant.findUnique.mockResolvedValueOnce({ id: TENANT_ID, ratePercentOverride: null });
      await expect(service.getEffectiveRule(TENANT_ID, NOW)).resolves.toMatchObject({
        ratePercent: null,
        source: 'none',
      });
    });
  });

  it('getEffectiveRules resolves a page of tenants with one query', async () => {
    const { service, tenantLoyaltyRule } = setup();
    tenantLoyaltyRule.findMany.mockResolvedValue([rule({ tenantId: 'a', ratePercent: 7 })]);
    const result = await service.getEffectiveRules(
      [
        { id: 'a', ratePercentOverride: null },
        { id: 'b', ratePercentOverride: 2 },
        { id: 'c', ratePercentOverride: null },
      ],
      NOW,
    );
    expect(tenantLoyaltyRule.findMany).toHaveBeenCalledTimes(1);
    expect(tenantLoyaltyRule.findMany.mock.calls[0][0].where.tenantId).toEqual({
      in: ['a', 'b', 'c'],
    });
    expect(result.get('a')).toMatchObject({ ratePercent: 7, source: 'rule' });
    expect(result.get('b')).toMatchObject({ ratePercent: 2, source: 'override' });
    expect(result.get('c')).toMatchObject({ ratePercent: null, source: 'none' });
  });

  it('getEffectiveRules skips the query for an empty page', async () => {
    const { service, tenantLoyaltyRule } = setup();
    await expect(service.getEffectiveRules([], NOW)).resolves.toEqual(new Map());
    expect(tenantLoyaltyRule.findMany).not.toHaveBeenCalled();
  });

  describe('create', () => {
    const input = {
      ratePercent: 10,
      validFrom: '2026-12-01T00:00:00.000Z',
      validTo: '2027-01-01T00:00:00.000Z',
    };

    it('locks the tenant, checks overlaps, audits and announces the change', async () => {
      const { service, tx, tenantLoyaltyRule, audit, outbox } = setup();
      tenantLoyaltyRule.findMany.mockResolvedValue([rule()]);

      const row = await service.create(TENANT_ID, input, ACTOR);

      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(row).toMatchObject({
        tenantId: TENANT_ID,
        ratePercent: 10,
        minTotalKopecks: 0,
        dailyCapPoints: null,
        validFrom: new Date(input.validFrom),
        validTo: new Date(input.validTo),
        createdAt: NOW,
      });
      expect(audit.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'tenant_rule.create',
          entityType: 'tenant_loyalty_rule',
          after: expect.objectContaining({ tenantId: TENANT_ID, ratePercent: 10 }),
        }),
        tx,
      );
      expect(outbox.publish).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          type: CONTENT_EVENTS.tenantUpdated,
          payload: { tenantId: TENANT_ID, slug: 'aroma-kava', changedFields: ['loyaltyRules'] },
        }),
      );
    });

    it('rejects an overlapping period', async () => {
      const { service, tenantLoyaltyRule } = setup();
      tenantLoyaltyRule.findMany.mockResolvedValue([rule()]);
      await expect(
        service.create(TENANT_ID, { ratePercent: 8, validFrom: '2026-11-15T00:00:00.000Z' }, ACTOR),
      ).rejects.toMatchObject({ code: 'PC_TENANT_RULE_OVERLAP', status: 409 });
      expect(tenantLoyaltyRule.create).not.toHaveBeenCalled();
    });

    it('rejects an empty period before opening a transaction', async () => {
      const { service, tx } = setup();
      await expect(
        service.create(
          TENANT_ID,
          {
            ratePercent: 8,
            validFrom: '2026-12-01T00:00:00.000Z',
            validTo: '2026-12-01T00:00:00.000Z',
          },
          ACTOR,
        ),
      ).rejects.toMatchObject({ code: 'PC_TENANT_RULE_INVALID_PERIOD', status: 422 });
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('answers 404 when the tenant does not exist', async () => {
      const { service, tx } = setup();
      tx.$queryRaw.mockResolvedValue([]);
      await expect(service.create(TENANT_ID, input, ACTOR)).rejects.toMatchObject({
        code: 'PC_TENANT_NOT_FOUND',
      });
    });
  });

  describe('update / remove by id', () => {
    it('updates the changed fields of a rule found by id', async () => {
      const { service, tenantLoyaltyRule, audit, outbox } = setup();
      tenantLoyaltyRule.findUnique.mockResolvedValue(rule());
      tenantLoyaltyRule.findFirst.mockResolvedValue(rule());
      tenantLoyaltyRule.findMany.mockResolvedValue([rule()]);
      tenantLoyaltyRule.update.mockImplementation(
        async ({ data }: { data: Partial<TenantLoyaltyRule> }) => ({
          ...rule(),
          ...data,
        }),
      );

      const row = await service.updateById(RULE_ID, { ratePercent: 6, validTo: null }, ACTOR);

      expect(row).toMatchObject({ ratePercent: 6, validTo: null });
      expect(audit.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'tenant_rule.update',
          before: { ratePercent: 5, validTo: rule().validTo },
          after: { ratePercent: 6, validTo: null },
        }),
        expect.anything(),
      );
      expect(outbox.publish).toHaveBeenCalledTimes(1);
    });

    it('does not count the rule itself as an overlap', async () => {
      const { service, tenantLoyaltyRule } = setup();
      tenantLoyaltyRule.findUnique.mockResolvedValue(rule());
      tenantLoyaltyRule.findFirst.mockResolvedValue(rule());
      tenantLoyaltyRule.findMany.mockResolvedValue([rule()]);
      tenantLoyaltyRule.update.mockResolvedValue(rule());
      await expect(
        service.updateById(RULE_ID, { validFrom: '2026-11-10T00:00:00.000Z' }, ACTOR),
      ).resolves.toBeDefined();
    });

    it('returns the current rule when nothing changes', async () => {
      const { service, tenantLoyaltyRule, audit } = setup();
      tenantLoyaltyRule.findUnique.mockResolvedValue(rule());
      tenantLoyaltyRule.findFirst.mockResolvedValue(rule());
      await service.updateById(
        RULE_ID,
        { ratePercent: 5, validFrom: '2026-11-01T00:00:00.000Z' },
        ACTOR,
      );
      expect(tenantLoyaltyRule.update).not.toHaveBeenCalled();
      expect(audit.audit).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown rule', async () => {
      const { service, tenantLoyaltyRule } = setup();
      tenantLoyaltyRule.findUnique.mockResolvedValue(null);
      await expect(service.updateById(RULE_ID, { ratePercent: 6 }, ACTOR)).rejects.toMatchObject({
        code: 'PC_TENANT_RULE_NOT_FOUND',
        status: 404,
      });
      await expect(service.removeById(RULE_ID, ACTOR)).rejects.toMatchObject({
        code: 'PC_TENANT_RULE_NOT_FOUND',
      });
    });

    it('deletes a rule, audits and announces it', async () => {
      const { service, tenantLoyaltyRule, audit, outbox } = setup();
      tenantLoyaltyRule.findUnique.mockResolvedValue(rule());
      tenantLoyaltyRule.findFirst.mockResolvedValue(rule());
      await service.removeById(RULE_ID, ACTOR);
      expect(tenantLoyaltyRule.delete).toHaveBeenCalledWith({ where: { id: RULE_ID } });
      expect(audit.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'tenant_rule.delete',
          before: expect.objectContaining({ tenantId: TENANT_ID, ratePercent: 5 }),
        }),
        expect.anything(),
      );
      expect(outbox.publish).toHaveBeenCalledTimes(1);
    });
  });

  it('lists rules newest first with tenant, activeAt and cursor filters', async () => {
    const { service, tenantLoyaltyRule } = setup();
    tenantLoyaltyRule.findMany.mockResolvedValue([rule({ id: 'r3' }), rule({ id: 'r2' })]);
    const page = await service.list({
      tenantId: TENANT_ID,
      activeAt: NOW,
      cursor: encodeCursor({ id: 'r9' }),
      limit: 1,
    });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(encodeCursor({ id: 'r3' }));
    expect(tenantLoyaltyRule.findMany.mock.calls[0][0]).toEqual({
      where: {
        tenantId: TENANT_ID,
        validFrom: { lte: NOW },
        OR: [{ validTo: null }, { validTo: { gt: NOW } }],
        id: { lt: 'r9' },
      },
      orderBy: { id: 'desc' },
      take: 2,
    });
  });
  describe('database exclusion constraint (tenant_loyalty_rules_no_overlap)', () => {
    const exclusion = Object.assign(
      new Error(
        'Error occurred during query execution: ConnectorError(... code: "23P01", message: "conflicting key value violates exclusion constraint \\"tenant_loyalty_rules_no_overlap\\"")',
      ),
      { name: 'PrismaClientUnknownRequestError' },
    );

    it('recognises the violation by constraint name, SQLSTATE or meta', () => {
      expect(isRuleOverlapViolation(exclusion)).toBe(true);
      expect(
        isRuleOverlapViolation({
          code: 'P2004',
          message: 'A constraint failed',
          meta: { database_error: '23P01' },
        }),
      ).toBe(true);
      expect(isRuleOverlapViolation(new Error('connection reset'))).toBe(false);
      expect(isRuleOverlapViolation(null)).toBe(false);
    });

    it('maps the violation on create to PC_TENANT_RULE_OVERLAP', async () => {
      const { service, tenantLoyaltyRule } = setup();
      tenantLoyaltyRule.create.mockRejectedValue(exclusion);
      await expect(
        service.create(TENANT_ID, { ratePercent: 5, validFrom: '2026-11-01T00:00:00.000Z' }, ACTOR),
      ).rejects.toMatchObject({
        code: 'PC_TENANT_RULE_OVERLAP',
        status: 409,
        details: { constraint: 'tenant_loyalty_rules_no_overlap' },
      });
    });

    it('maps the violation on update and keeps other errors as they are', async () => {
      const { service, tenantLoyaltyRule } = setup();
      tenantLoyaltyRule.findFirst.mockResolvedValue(rule());
      tenantLoyaltyRule.findUnique.mockResolvedValue(rule());
      tenantLoyaltyRule.update.mockRejectedValueOnce(exclusion);
      await expect(
        service.update(TENANT_ID, RULE_ID, { ratePercent: 7 }, ACTOR),
      ).rejects.toMatchObject({ code: 'PC_TENANT_RULE_OVERLAP' });

      tenantLoyaltyRule.update.mockRejectedValueOnce(new Error('connection reset'));
      await expect(service.update(TENANT_ID, RULE_ID, { ratePercent: 7 }, ACTOR)).rejects.toThrow(
        'connection reset',
      );
    });
  });
});
