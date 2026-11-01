import type { Tenant } from '@prisma/client';
import type { EffectiveTenantRule } from '../../../common/contracts/content';
import { FakeClock } from '../../../common/time/clock';
import type { BaseRateService } from './base-rate.service';
import type { MallInfoService } from './mall-info.service';
import { TenantDirectoryService } from './tenant-directory.service';
import type { TenantRulesService } from './tenant-rules.service';
import type { TenantsService } from './tenants.service';

const NOW = new Date('2026-11-01T10:00:00.000Z');

function tenant(overrides: Partial<Tenant>): Tenant {
  return {
    id: 't',
    slug: 't',
    name: 'T',
    category: 'other',
    floor: null,
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
    ...overrides,
  };
}

function effective(
  tenantId: string,
  overrides: Partial<EffectiveTenantRule> = {},
): EffectiveTenantRule {
  return {
    tenantId,
    ratePercent: null,
    minTotalKopecks: 0,
    dailyCapPoints: null,
    source: 'none',
    ...overrides,
  };
}

function setup(logoBaseUrl: string | undefined = 'https://cdn.example/') {
  const tenants = {
    listPublic: jest.fn(),
    getPublicBySlug: jest.fn(),
    getPublicById: jest.fn(),
    categoriesSummary: jest.fn(),
  };
  const rules = { getEffectiveRules: jest.fn() };
  const baseRate = { getBaseRatePercent: jest.fn().mockResolvedValue(3) };
  // 2026-11-01 12:00 Kyiv (Sunday); the mall is open 10:00-22:00.
  const mallInfo = {
    logoBaseUrl,
    tenantViewContext: jest.fn(async () => ({
      logoBase: logoBaseUrl,
      mallHours: { from: '10:00', to: '22:00' },
      now: NOW,
    })),
  };
  const service = new TenantDirectoryService(
    tenants as unknown as TenantsService,
    rules as unknown as TenantRulesService,
    baseRate as unknown as BaseRateService,
    mallInfo as unknown as MallInfoService,
    new FakeClock(NOW),
  );
  return { service, tenants, rules, baseRate };
}

describe('TenantDirectoryService', () => {
  it('lists active tenants with the earning badge and effective rate', async () => {
    const { service, tenants, rules, baseRate } = setup();
    const intertop = tenant({
      id: 'a',
      slug: 'intertop',
      name: 'INTERTOP',
      logoKey: 'tenants/intertop.png',
    });
    const aroma = tenant({
      id: 'b',
      slug: 'aroma-kava',
      name: 'Aroma Kava',
      ratePercentOverride: 5,
    });
    const tamtam = tenant({ id: 'c', slug: 'tamtam', name: 'ТамТам', excludedFromProgram: true });
    tenants.listPublic.mockResolvedValue({ items: [intertop, aroma, tamtam], nextCursor: 'next' });
    rules.getEffectiveRules.mockResolvedValue(
      new Map([
        ['a', effective('a')],
        ['b', effective('b', { ratePercent: 5, source: 'override' })],
        ['c', effective('c')],
      ]),
    );

    const page = await service.list({ participates: true, limit: 3 });

    expect(tenants.listPublic).toHaveBeenCalledWith({
      participates: true,
      category: undefined,
      floor: undefined,
      q: undefined,
      cursor: undefined,
      limit: 3,
    });
    expect(rules.getEffectiveRules).toHaveBeenCalledWith([intertop, aroma, tamtam], NOW);
    expect(baseRate.getBaseRatePercent).toHaveBeenCalledTimes(1);
    expect(page.nextCursor).toBe('next');
    expect(page.items).toEqual([
      expect.objectContaining({
        slug: 'intertop',
        logoUrl: 'https://cdn.example/tenants/intertop.png',
        earnsPoints: true,
        effectiveRatePercent: 3,
        rateSource: 'base',
      }),
      expect.objectContaining({
        slug: 'aroma-kava',
        logoUrl: null,
        earnsPoints: true,
        effectiveRatePercent: 5,
        rateSource: 'override',
      }),
      expect.objectContaining({
        slug: 'tamtam',
        earnsPoints: false,
        effectiveRatePercent: 0,
        rateSource: 'none',
      }),
    ]);
    expect(page.items[0]).not.toHaveProperty('minTotalKopecks');
    expect(page.items[0]).not.toHaveProperty('excludedFromProgram');
  });

  it('does not read the base rate when every tenant has its own rate', async () => {
    const { service, tenants, rules, baseRate } = setup();
    tenants.listPublic.mockResolvedValue({
      items: [tenant({ id: 'b', ratePercentOverride: 5 })],
      nextCursor: null,
    });
    rules.getEffectiveRules.mockResolvedValue(
      new Map([['b', effective('b', { ratePercent: 5, source: 'override' })]]),
    );
    await service.list({ limit: 20 });
    expect(baseRate.getBaseRatePercent).not.toHaveBeenCalled();
  });

  it('returns an empty page without querying rules', async () => {
    const { service, tenants, rules } = setup();
    tenants.listPublic.mockResolvedValue({ items: [], nextCursor: null });
    await expect(service.list({ limit: 20 })).resolves.toEqual({ items: [], nextCursor: null });
    expect(rules.getEffectiveRules).not.toHaveBeenCalled();
  });

  it('getBySlug returns the card with minimum total and daily cap of the active rule', async () => {
    const { service, tenants, rules } = setup(undefined);
    const premier = tenant({
      id: 'p',
      slug: 'premier-city',
      name: 'Premier City',
      category: 'cinema',
      floor: 3,
    });
    tenants.getPublicBySlug.mockResolvedValue(premier);
    rules.getEffectiveRules.mockResolvedValue(
      new Map([
        [
          'p',
          effective('p', {
            ratePercent: 10,
            minTotalKopecks: 20_000,
            dailyCapPoints: 200,
            source: 'rule',
          }),
        ],
      ]),
    );

    await expect(service.getBySlug('premier-city')).resolves.toEqual({
      id: 'p',
      slug: 'premier-city',
      name: 'Premier City',
      category: 'cinema',
      floor: 3,
      logoUrl: null,
      website: null,
      phone: null,
      description: null,
      participates: true,
      hours: null,
      isOpenNow: true,
      locationText: null,
      mapImageUrl: null,
      earnsPoints: true,
      effectiveRatePercent: 10,
      rateSource: 'rule',
      minTotalKopecks: 20_000,
      dailyCapPoints: 200,
    });
  });

  it('getById serves the same card with own hours, location and map', async () => {
    const { service, tenants, rules } = setup();
    const kids = tenant({
      id: 'k',
      slug: 'figli-migli',
      name: 'Figli Migli',
      hours: { sun: [], sat: ['11:00-20:00'] },
      locationText: '3 поверх, біля кінотеатру',
      mapImageUrl: 'https://cdn.example/mall/floor-3.png',
    });
    tenants.getPublicById.mockResolvedValue(kids);
    rules.getEffectiveRules.mockResolvedValue(new Map([['k', effective('k')]]));

    // Sunday: the tenant is closed while the mall is open.
    await expect(service.getById('k')).resolves.toMatchObject({
      slug: 'figli-migli',
      hours: { sat: ['11:00-20:00'], sun: [] },
      isOpenNow: false,
      locationText: '3 поверх, біля кінотеатру',
      mapImageUrl: 'https://cdn.example/mall/floor-3.png',
    });
    expect(tenants.getPublicById).toHaveBeenCalledWith('k');
  });

  it('falls back to the mall hours and ignores malformed stored hours', async () => {
    const { service, tenants, rules } = setup();
    tenants.listPublic.mockResolvedValue({
      items: [tenant({ id: 'x', hours: { mon: 'always' } })],
      nextCursor: null,
    });
    rules.getEffectiveRules.mockResolvedValue(new Map([['x', effective('x')]]));
    const page = await service.list({ limit: 20 });
    expect(page.items[0]).toMatchObject({ hours: null, isOpenNow: true });
  });

  it('propagates 404 from the tenant lookup', async () => {
    const { service, tenants } = setup();
    tenants.getPublicBySlug.mockRejectedValue(
      Object.assign(new Error('nf'), { code: 'PC_TENANT_NOT_FOUND' }),
    );
    await expect(service.getBySlug('nope')).rejects.toMatchObject({ code: 'PC_TENANT_NOT_FOUND' });
  });

  it('categories come from the tenants service', async () => {
    const { service, tenants } = setup();
    tenants.categoriesSummary.mockResolvedValue([{ category: 'coffee', count: 2 }]);
    await expect(service.categories()).resolves.toEqual([{ category: 'coffee', count: 2 }]);
  });
});
