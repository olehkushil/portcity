import { uuidv7 } from 'uuidv7';
import { CONTENT_PORT, type ContentPort } from '../../src/common/contracts/content';
import { CONTENT_EVENTS } from '../../src/common/contracts/events';
import { FiscalNumbersService } from '../../src/modules/content/services/fiscal-numbers.service';
import { MallInfoService } from '../../src/modules/content/services/mall-info.service';
import { TenantDirectoryService } from '../../src/modules/content/services/tenant-directory.service';
import { TenantRulesService } from '../../src/modules/content/services/tenant-rules.service';
import { TenantsService } from '../../src/modules/content/services/tenants.service';
import { createTestApp, type TestApp } from '../utils/app-factory';
import { describeWithDb, resetDatabase } from '../utils/int';

/** Content services against PostgreSQL (self-skips without DATABASE_URL; CI runs it). */
describeWithDb('content module (integration)', () => {
  let testApp: TestApp;
  let tenants: TenantsService;
  let fiscalNumbers: FiscalNumbersService;
  let rules: TenantRulesService;
  let directory: TenantDirectoryService;
  let port: ContentPort;
  let actor: { id: string; ip: string };

  beforeAll(async () => {
    testApp = await createTestApp();
    tenants = testApp.app.get(TenantsService);
    fiscalNumbers = testApp.app.get(FiscalNumbersService);
    rules = testApp.app.get(TenantRulesService);
    directory = testApp.app.get(TenantDirectoryService);
    port = testApp.app.get<ContentPort>(CONTENT_PORT);
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await resetDatabase(testApp.prisma);
    // confirmedById references admin_users, so a real admin row is needed (test fixture).
    const adminId = uuidv7();
    await testApp.prisma.adminUser.create({
      data: {
        id: adminId,
        email: `content-int-${adminId}@portcity.local`,
        passwordHash: 'not-a-real-hash',
        role: 'owner',
      },
    });
    actor = { id: adminId, ip: '127.0.0.1' };
  });

  it('records a fiscal number seen on receipts once, even under concurrency', async () => {
    const [a, b] = await Promise.all([
      port.recordSeenFiscalNumber('4000 1000 99'),
      port.recordSeenFiscalNumber('4000100099'),
    ]);
    expect(a).toMatchObject({
      fn: '4000100099',
      status: 'pending',
      source: 'receipt',
      tenantId: null,
    });
    expect(b.fn).toBe('4000100099');
    expect(await testApp.prisma.tenantFiscalNumber.count()).toBe(1);
    const events = await testApp.prisma.outboxEvent.findMany({
      where: { type: CONTENT_EVENTS.fiscalNumberSeen },
    });
    expect(events).toHaveLength(1);
  });

  it('confirms a pending number and exposes the mapping through CONTENT_PORT', async () => {
    const tenant = await tenants.create(
      { name: 'Aroma Kava', category: 'coffee', floor: 1 },
      actor,
    );
    await port.recordSeenFiscalNumber('4000100011');
    const pending = await testApp.prisma.tenantFiscalNumber.findUniqueOrThrow({
      where: { fn: '4000100011' },
    });

    const confirmed = await fiscalNumbers.confirm(pending.id, { tenantId: tenant.id }, actor);

    expect(confirmed).toMatchObject({
      status: 'active',
      tenantId: tenant.id,
      confirmedById: actor.id,
    });
    await expect(port.findTenantByFiscalNumber('4000100011')).resolves.toMatchObject({
      status: 'active',
      tenant: { slug: 'aroma-kava' },
    });
    await expect(port.isExcluded(tenant.id)).resolves.toBe(false);
    const audit = await testApp.prisma.auditLog.findMany({
      where: { entityType: 'tenant_fiscal_number', entityId: pending.id },
    });
    expect(audit.map((row) => row.action)).toEqual(['fiscal_number.confirm']);
  });

  it('applies tenant rules: overlap check, effective rule and the directory rate', async () => {
    const tenant = await tenants.create(
      { name: 'Premier City', category: 'cinema', floor: 3, ratePercentOverride: 4 },
      actor,
    );
    const now = testApp.clock?.now() ?? new Date();
    const from = new Date(now.getTime() - 86_400_000).toISOString();
    await rules.create(
      tenant.id,
      { ratePercent: 10, minTotalKopecks: 20_000, validFrom: from },
      actor,
    );
    await expect(
      rules.create(tenant.id, { ratePercent: 6, validFrom: now.toISOString() }, actor),
    ).rejects.toMatchObject({ code: 'PC_TENANT_RULE_OVERLAP' });

    await expect(port.getTenantRule(tenant.id, now)).resolves.toMatchObject({
      ratePercent: 10,
      minTotalKopecks: 20_000,
      source: 'rule',
    });
    await expect(directory.getBySlug('premier-city')).resolves.toMatchObject({
      earnsPoints: true,
      effectiveRatePercent: 10,
      rateSource: 'rule',
      minTotalKopecks: 20_000,
    });
  });

  it('canonicalises fiscal numbers: leading zeros and dashes name the same register', async () => {
    const seen = await port.recordSeenFiscalNumber('0004000-100-077');
    expect(seen.fn).toBe('4000100077');
    await expect(port.findTenantByFiscalNumber('04000100077')).resolves.toMatchObject({
      fn: '4000100077',
    });
  });

  it('stores tenant hours, location and map and serves them by id', async () => {
    const created = await tenants.create(
      {
        name: 'Beauty Room',
        category: 'beauty',
        hours: { sun: [], mon: ['10:00-21:00'] },
        locationText: '1 поверх, праве крило',
        mapImageUrl: 'https://cdn.portcity.com.ua/mall/floor-1.png',
      },
      actor,
    );
    await expect(directory.getById(created.id)).resolves.toMatchObject({
      hours: { mon: ['10:00-21:00'], sun: [] },
      locationText: '1 поверх, праве крило',
      mapImageUrl: 'https://cdn.portcity.com.ua/mall/floor-1.png',
    });
    const cleared = await tenants.update(created.id, { hours: null }, actor);
    expect(cleared.hours).toBeNull();
    await expect(port.getTenantSummaryById(created.id)).resolves.toMatchObject({
      slug: 'beauty-room',
      locationText: '1 поверх, праве крило',
    });
  });

  it('keeps one mall_info row and serves it through GET /mall/info', async () => {
    const mallInfo = testApp.app.get(MallInfoService);
    await mallInfo.update(
      { telegramUrl: 'https://t.me/portcity_lutsk', hours: '09:00-21:00' },
      actor,
    );
    await mallInfo.update({ telegramUrl: 'https://t.me/portcity' }, actor);
    expect(await testApp.prisma.mallInfo.count()).toBe(1);
    await expect(mallInfo.getInfo()).resolves.toMatchObject({
      telegramUrl: 'https://t.me/portcity',
      hours: { from: '10:00', to: '22:00' },
    });
  });

  it('hides hidden and closed tenants from the public directory', async () => {
    const visible = await tenants.create({ name: 'INTERTOP', category: 'fashion' }, actor);
    const hidden = await tenants.create({ name: 'Strike City', category: 'bowling' }, actor);
    const closed = await tenants.create(
      { name: 'Generator City', category: 'entertainment' },
      actor,
    );
    await tenants.update(hidden.id, { status: 'hidden' }, actor);
    await tenants.close(closed.id, actor);

    const page = await directory.list({ limit: 20 });

    expect(page.items.map((item) => item.slug)).toEqual([visible.slug]);
    await expect(directory.getBySlug('strike-city')).rejects.toMatchObject({
      code: 'PC_TENANT_NOT_FOUND',
    });
    await expect(port.isExcluded(closed.id)).resolves.toBe(true);
  });
});
