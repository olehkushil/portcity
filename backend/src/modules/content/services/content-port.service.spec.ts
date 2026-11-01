import type { Tenant } from '@prisma/client';
import type { ContentPort } from '../../../common/contracts/content';
import { ContentPortService } from './content-port.service';
import type { FiscalNumbersService } from './fiscal-numbers.service';
import type { MallInfoService } from './mall-info.service';
import type { TenantRulesService } from './tenant-rules.service';
import type { TenantsService } from './tenants.service';

const NOW = new Date('2026-11-01T10:00:00.000Z');

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 't-1',
    slug: 'intertop',
    name: 'INTERTOP',
    category: 'fashion',
    floor: 1,
    logoKey: 'tenants/intertop.png',
    website: 'https://intertop.ua',
    phone: null,
    description: 'Взуття',
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

function setup() {
  const tenants = { findById: jest.fn(), findByIds: jest.fn() };
  const fiscalNumbers = { lookup: jest.fn(), recordSeen: jest.fn() };
  const rules = { getEffectiveRule: jest.fn() };
  // 2026-11-01 12:00 Kyiv is a Sunday; the mall is open 10:00-22:00.
  const mallInfo = {
    tenantViewContext: jest.fn(async () => ({
      logoBase: 'https://cdn.example',
      mallHours: { from: '10:00', to: '22:00' },
      now: NOW,
    })),
  };
  const port: ContentPort = new ContentPortService(
    tenants as unknown as TenantsService,
    fiscalNumbers as unknown as FiscalNumbersService,
    rules as unknown as TenantRulesService,
    mallInfo as unknown as MallInfoService,
  );
  return { port, tenants, fiscalNumbers, rules };
}

describe('ContentPortService (CONTENT_PORT)', () => {
  it('getTenant maps the row to TenantSummary or returns null', async () => {
    const { port, tenants } = setup();
    tenants.findById.mockResolvedValueOnce(tenant());
    await expect(port.getTenant('t-1')).resolves.toEqual({
      id: 't-1',
      slug: 'intertop',
      name: 'INTERTOP',
      category: 'fashion',
      floor: 1,
      logoKey: 'tenants/intertop.png',
      participates: true,
      ratePercentOverride: null,
      excludedFromProgram: false,
      status: 'active',
    });
    tenants.findById.mockResolvedValueOnce(null);
    await expect(port.getTenant('missing')).resolves.toBeNull();
  });

  it('getTenantSummaryById adds the card fields: logo URL, location, map, open now', async () => {
    const { port, tenants } = setup();
    tenants.findById.mockResolvedValueOnce(
      tenant({
        locationText: '1 поверх',
        mapImageUrl: 'https://cdn.example/mall/floor-1.png',
        hours: { sun: [] },
      }),
    );
    await expect(port.getTenantSummaryById('t-1')).resolves.toEqual({
      id: 't-1',
      slug: 'intertop',
      name: 'INTERTOP',
      category: 'fashion',
      floor: 1,
      logoKey: 'tenants/intertop.png',
      participates: true,
      ratePercentOverride: null,
      excludedFromProgram: false,
      status: 'active',
      logoUrl: 'https://cdn.example/tenants/intertop.png',
      locationText: '1 поверх',
      mapImageUrl: 'https://cdn.example/mall/floor-1.png',
      // Closed on Sundays, although the mall is open.
      isOpenNow: false,
    });
    tenants.findById.mockResolvedValueOnce(tenant());
    await expect(port.getTenantSummaryById('t-1')).resolves.toMatchObject({ isOpenNow: true });
    tenants.findById.mockResolvedValueOnce(null);
    await expect(port.getTenantSummaryById('missing')).resolves.toBeNull();
  });

  it('getTenants returns summaries of the found tenants only', async () => {
    const { port, tenants } = setup();
    tenants.findByIds.mockResolvedValue([tenant(), tenant({ id: 't-2', slug: 'tamtam' })]);
    const result = await port.getTenants(['t-1', 't-2', 't-3']);
    expect(result.map((t) => t.id)).toEqual(['t-1', 't-2']);
  });

  it.each<[string, Partial<Tenant> | null, boolean]>([
    ['participating active tenant', {}, false],
    ['hidden tenant still earns', { status: 'hidden' }, false],
    ['excluded tenant', { excludedFromProgram: true }, true],
    ['non-participant', { participates: false }, true],
    ['closed tenant', { status: 'closed' }, true],
    ['unknown tenant', null, true],
  ])('isExcluded: %s -> %s', async (_name, overrides, expected) => {
    const { port, tenants } = setup();
    tenants.findById.mockResolvedValue(overrides === null ? null : tenant(overrides));
    await expect(port.isExcluded('t-1')).resolves.toBe(expected);
  });

  it('delegates fiscal number lookups and recording', async () => {
    const { port, fiscalNumbers } = setup();
    const lookup = { fn: '4000100011', status: 'pending' };
    fiscalNumbers.lookup.mockResolvedValue(lookup);
    fiscalNumbers.recordSeen.mockResolvedValue(lookup);
    await expect(port.findTenantByFiscalNumber('4000100011')).resolves.toBe(lookup);
    const tx = {} as never;
    await expect(port.recordSeenFiscalNumber('4000100011', tx)).resolves.toBe(lookup);
    expect(fiscalNumbers.recordSeen).toHaveBeenCalledWith('4000100011', tx, undefined);
  });

  it('delegates the effective rule', async () => {
    const { port, rules } = setup();
    const effective = {
      tenantId: 't-1',
      ratePercent: null,
      minTotalKopecks: 0,
      dailyCapPoints: null,
      source: 'none',
    };
    rules.getEffectiveRule.mockResolvedValue(effective);
    await expect(port.getTenantRule('t-1', NOW)).resolves.toBe(effective);
    expect(rules.getEffectiveRule).toHaveBeenCalledWith('t-1', NOW);
  });
});
