import request from 'supertest';
import { ADMIN_AUDIT_PORT } from '../../src/common/contracts/admin';
import { CONTENT_PORT } from '../../src/common/contracts/content';
import type { StoredMallInfo } from '../../src/modules/content/domain/mall-info';
import { ContentImportService } from '../../src/modules/content/services/content-import.service';
import { MallInfoRepository } from '../../src/modules/content/services/mall-info.repository';
import { ContentPortService } from '../../src/modules/content/services/content-port.service';
import { FiscalNumbersService } from '../../src/modules/content/services/fiscal-numbers.service';
import { TenantDirectoryService } from '../../src/modules/content/services/tenant-directory.service';
import { TenantRulesService } from '../../src/modules/content/services/tenant-rules.service';
import { TenantsService } from '../../src/modules/content/services/tenants.service';
import { createTestApp, type TestApp } from '../utils/app-factory';

/**
 * Routing, validation, guards and role checks of the content controllers against the full
 * AppModule. Services that touch PostgreSQL are replaced by fakes; MallInfoService is real.
 */

const ADMIN_ID = '0192f3a0-0000-7000-8000-00000000a001';
const TENANT_ID = '0192f3a0-0000-7000-8000-000000000001';
const FN_ID = '0192f3a0-0000-7000-8000-0000000000f1';
const RULE_ID = '0192f3a0-0000-7000-8000-0000000000e1';
const RUN_ID = '0192f3a0-0000-7000-8000-0000000000d1';
const NOW = new Date('2026-01-15T10:00:00.000Z');

const tenantRow = {
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
  ratePercentOverride: 5,
  excludedFromProgram: false,
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
  _count: { fiscalNumbers: 2, loyaltyRules: 1 },
};

const fnRow = {
  id: FN_ID,
  fn: '4000100011',
  tenantId: TENANT_ID,
  tenant: tenantRow,
  status: 'active',
  source: 'receipt',
  firstSeenAt: NOW,
  confirmedById: ADMIN_ID,
  confirmedAt: NOW,
  note: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const ruleRow = {
  id: RULE_ID,
  tenantId: TENANT_ID,
  ratePercent: 10,
  minTotalKopecks: 0,
  dailyCapPoints: null,
  validFrom: NOW,
  validTo: null,
  createdAt: NOW,
};

const runRow = {
  id: RUN_ID,
  source: 'wordpress',
  status: 'succeeded',
  startedAt: NOW,
  finishedAt: NOW,
  stats: { source: 'wordpress', dryRun: false, received: 1, created: 1 },
  error: null,
};

const directory = {
  list: jest.fn(),
  getBySlug: jest.fn(),
  getById: jest.fn(),
  categories: jest.fn(),
};
const tenants = {
  list: jest.fn(),
  getById: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  close: jest.fn(),
  findById: jest.fn(),
  findByIds: jest.fn(),
};
const fiscalNumbers = {
  list: jest.fn(),
  getById: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  confirm: jest.fn(),
  block: jest.fn(),
  remove: jest.fn(),
  lookup: jest.fn(),
  recordSeen: jest.fn(),
};
const rules = {
  list: jest.fn(),
  getById: jest.fn(),
  create: jest.fn(),
  updateById: jest.fn(),
  removeById: jest.fn(),
  getEffectiveRule: jest.fn(),
  getEffectiveRules: jest.fn(),
};
const imports = { run: jest.fn(), list: jest.fn(), getById: jest.fn() };
/** mall_info without PostgreSQL: one row in memory. */
const mallInfoRows: { row: (StoredMallInfo & { updatedById: string; updatedAt: Date }) | null } = {
  row: null,
};
const mallInfoRepo = {
  find: jest.fn(async () => mallInfoRows.row),
  save: jest.fn(async (_tx: unknown, data: StoredMallInfo, updatedById: string, now: Date) => {
    mallInfoRows.row = { ...data, updatedById, updatedAt: now };
    return mallInfoRows.row;
  }),
  transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ fakeTx: true })),
};
const audit = { audit: jest.fn(async () => 'audit-1') };

describe('content controllers (e2e)', () => {
  let testApp: TestApp;

  const admin = (roles: string[]): string => `Bearer ${testApp.adminToken(ADMIN_ID, roles)}`;

  beforeAll(async () => {
    testApp = await createTestApp({
      configure: (builder) =>
        builder
          .overrideProvider(TenantDirectoryService)
          .useValue(directory)
          .overrideProvider(TenantsService)
          .useValue(tenants)
          .overrideProvider(FiscalNumbersService)
          .useValue(fiscalNumbers)
          .overrideProvider(TenantRulesService)
          .useValue(rules)
          .overrideProvider(ContentImportService)
          .useValue(imports)
          .overrideProvider(MallInfoRepository)
          .useValue(mallInfoRepo)
          .overrideProvider(ADMIN_AUDIT_PORT)
          .useValue(audit),
    });
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    for (const mock of [
      ...Object.values(directory),
      ...Object.values(tenants),
      ...Object.values(fiscalNumbers),
      ...Object.values(rules),
      ...Object.values(imports),
    ]) {
      mock.mockReset();
    }
  });

  it('binds CONTENT_PORT to ContentPortService', () => {
    expect(testApp.moduleRef.get(CONTENT_PORT, { strict: false })).toBeInstanceOf(
      ContentPortService,
    );
  });

  describe('public', () => {
    it('GET /mall/info returns hours, address, parking hours and support', async () => {
      const response = await request(testApp.server).get('/api/v1/mall/info').expect(200);
      expect(response.body).toMatchObject({
        name: 'Порт City',
        address: 'просп. Соборності, 43, Луцьк',
        timezone: 'Europe/Kyiv',
        hours: { from: '10:00', to: '22:00', isOpenNow: true },
        parking: {
          underground: { from: '08:00', to: '21:00' },
          surface: { from: '05:00', to: '24:00' },
        },
        serverTime: NOW.toISOString(),
      });
      expect(Object.keys(response.body.support as object).sort()).toEqual(['email', 'phone']);
    });

    it('GET /tenants parses the filters', async () => {
      directory.list.mockResolvedValue({
        items: [
          {
            id: TENANT_ID,
            slug: 'aroma-kava',
            name: 'Aroma Kava',
            category: 'coffee',
            floor: 1,
            logoUrl: null,
            website: null,
            phone: null,
            description: null,
            participates: true,
            earnsPoints: true,
            effectiveRatePercent: 5,
            rateSource: 'override',
          },
        ],
        nextCursor: null,
      });
      const response = await request(testApp.server)
        .get('/api/v1/tenants?participates=true&category=coffee&q=aroma&limit=5')
        .expect(200);
      expect(response.body.items[0]).toMatchObject({ slug: 'aroma-kava', earnsPoints: true });
      expect(directory.list).toHaveBeenCalledWith(
        expect.objectContaining({ participates: true, category: 'coffee', q: 'aroma', limit: 5 }),
      );
    });

    it.each([
      ['participates=maybe'],
      ['category=casino'],
      ['limit=0'],
      ['floor=abc'],
      ['unknown=1'],
    ])('GET /tenants?%s answers 400 problem+json', async (query) => {
      const response = await request(testApp.server).get(`/api/v1/tenants?${query}`).expect(400);
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(directory.list).not.toHaveBeenCalled();
    });

    it('GET /tenants/categories is not shadowed by the slug route', async () => {
      directory.categories.mockResolvedValue([{ category: 'coffee', count: 2 }]);
      await request(testApp.server)
        .get('/api/v1/tenants/categories')
        .expect(200, [{ category: 'coffee', count: 2 }]);
      expect(directory.getBySlug).not.toHaveBeenCalled();
    });

    it('GET /tenants/:slug returns the card with the earning flag', async () => {
      directory.getBySlug.mockResolvedValue({
        slug: 'aroma-kava',
        earnsPoints: true,
        effectiveRatePercent: 5,
        rateSource: 'override',
        minTotalKopecks: 0,
        dailyCapPoints: null,
      });
      const response = await request(testApp.server).get('/api/v1/tenants/aroma-kava').expect(200);
      expect(response.body).toMatchObject({ earnsPoints: true, effectiveRatePercent: 5 });
      expect(directory.getBySlug).toHaveBeenCalledWith('aroma-kava');
    });

    it('GET /tenants/:slug rejects a malformed slug', async () => {
      await request(testApp.server).get('/api/v1/tenants/Aroma_Kava').expect(400);
      expect(directory.getBySlug).not.toHaveBeenCalled();
    });

    it('GET /mall/info carries the extended facts (empty until the back office fills them)', async () => {
      const response = await request(testApp.server).get('/api/v1/mall/info').expect(200);
      expect(response.body).toMatchObject({
        telegramUrl: null,
        infoDesk: null,
        parkingOperator: null,
        rulesPdfUrl: null,
        legalDocuments: [],
        floorMapUrls: [],
        parkingMapUrl: null,
      });
    });

    it('GET /tenants/by-id/:id is public and not shadowed by the slug route', async () => {
      directory.getById.mockResolvedValue({
        id: TENANT_ID,
        slug: 'aroma-kava',
        isOpenNow: true,
        locationText: '1 поверх',
        hours: null,
      });
      const response = await request(testApp.server)
        .get(`/api/v1/tenants/by-id/${TENANT_ID}`)
        .expect(200);
      expect(response.body).toMatchObject({ slug: 'aroma-kava', isOpenNow: true });
      expect(directory.getById).toHaveBeenCalledWith(TENANT_ID);
      expect(directory.getBySlug).not.toHaveBeenCalled();
    });

    it('GET /tenants/by-id/:id rejects a malformed id', async () => {
      await request(testApp.server).get('/api/v1/tenants/by-id/not-a-uuid').expect(400);
      expect(directory.getById).not.toHaveBeenCalled();
    });
  });

  describe('admin mall info', () => {
    it('PUT stores the facts as the authenticated manager; GET /mall/info serves them', async () => {
      const response = await request(testApp.server)
        .put('/api/v1/admin/content/mall-info')
        .set('Authorization', admin(['manager']))
        .send({
          telegramUrl: 'https://t.me/portcity_lutsk',
          infoDesk: { location: '1 поверх, центральний вхід', hours: '10:00-22:00' },
          parkingOperator: { name: 'ТОВ «Паркінг»', phone: '+380500000000', hours: 'цілодобово' },
          legalDocuments: [
            {
              key: 'privacy',
              title: 'Політика конфіденційності',
              url: 'https://portcity.com.ua/p',
            },
          ],
          floorMapUrls: [{ floor: 1, url: 'https://cdn.example/mall/floor-1.png' }],
          support: { phone: '+380332111111', email: 'help@portcity.com.ua' },
        })
        .expect(200);
      expect(response.body).toMatchObject({
        telegramUrl: 'https://t.me/portcity_lutsk',
        updatedById: ADMIN_ID,
        effective: { support: { phone: '+380332111111' } },
      });
      expect(audit.audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'mall_info.update', entityType: 'mall_info' }),
        expect.anything(),
      );

      const info = await request(testApp.server).get('/api/v1/mall/info').expect(200);
      expect(info.body).toMatchObject({
        telegramUrl: 'https://t.me/portcity_lutsk',
        infoDesk: { location: '1 поверх, центральний вхід' },
        floorMapUrls: [{ floor: 1 }],
      });
    });

    it('PUT validates the body', async () => {
      await request(testApp.server)
        .put('/api/v1/admin/content/mall-info')
        .set('Authorization', admin(['manager']))
        .send({ telegramUrl: 'not a url', hours: 'always' })
        .expect(400);
      await request(testApp.server)
        .put('/api/v1/admin/content/mall-info')
        .set('Authorization', admin(['manager']))
        .send({ legalDocuments: [{ key: 'privacy', title: 'x' }] })
        .expect(400);
      expect(mallInfoRepo.save).not.toHaveBeenCalled();
    });

    it('support may read but not write', async () => {
      await request(testApp.server)
        .get('/api/v1/admin/content/mall-info')
        .set('Authorization', admin(['support']))
        .expect(200);
      await request(testApp.server)
        .put('/api/v1/admin/content/mall-info')
        .set('Authorization', admin(['support']))
        .send({})
        .expect(403);
      expect(mallInfoRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('admin guards', () => {
    it('requires a bearer token', async () => {
      const response = await request(testApp.server).get('/api/v1/admin/tenants').expect(401);
      expect(response.body).toMatchObject({ code: 'PC_AUTH_UNAUTHORIZED' });
    });

    it('rejects member tokens', async () => {
      await request(testApp.server)
        .get('/api/v1/admin/tenants')
        .set('Authorization', `Bearer ${testApp.memberToken('user-1', 'device-1')}`)
        .expect(403);
    });

    it('rejects roles without content access', async () => {
      await request(testApp.server)
        .get('/api/v1/admin/fiscal-numbers')
        .set('Authorization', admin(['validator']))
        .expect(403);
    });

    it('lets support read but not write', async () => {
      tenants.list.mockResolvedValue({ items: [tenantRow], nextCursor: null });
      const list = await request(testApp.server)
        .get('/api/v1/admin/tenants?status=active')
        .set('Authorization', admin(['support']))
        .expect(200);
      expect(list.body.items[0]).toMatchObject({
        id: TENANT_ID,
        ratePercentOverride: 5,
        fiscalNumbersCount: 2,
        loyaltyRulesCount: 1,
      });
      await request(testApp.server)
        .post('/api/v1/admin/tenants')
        .set('Authorization', admin(['support']))
        .send({ name: 'Shop', category: 'other' })
        .expect(403);
      expect(tenants.create).not.toHaveBeenCalled();
    });
  });

  describe('admin tenants', () => {
    it('POST creates a tenant as the authenticated admin', async () => {
      tenants.create.mockResolvedValue(tenantRow);
      const response = await request(testApp.server)
        .post('/api/v1/admin/tenants')
        .set('Authorization', admin(['manager']))
        .send({ name: 'Aroma Kava', category: 'coffee', floor: 1, ratePercentOverride: 5 })
        .expect(201);
      expect(response.body).toMatchObject({ slug: 'aroma-kava', status: 'active' });
      expect(tenants.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Aroma Kava', category: 'coffee' }),
        expect.objectContaining({ id: ADMIN_ID }),
      );
    });

    it('POST validates the body', async () => {
      await request(testApp.server)
        .post('/api/v1/admin/tenants')
        .set('Authorization', admin(['manager']))
        .send({ name: 'X', category: 'coffee', ratePercentOverride: 101, extra: true })
        .expect(400);
      expect(tenants.create).not.toHaveBeenCalled();
    });

    it('PATCH rejects a non-uuid id', async () => {
      await request(testApp.server)
        .patch('/api/v1/admin/tenants/not-a-uuid')
        .set('Authorization', admin(['manager']))
        .send({ floor: 2 })
        .expect(400);
    });

    it('DELETE closes the tenant', async () => {
      tenants.close.mockResolvedValue({ ...tenantRow, status: 'closed' });
      const response = await request(testApp.server)
        .delete(`/api/v1/admin/tenants/${TENANT_ID}`)
        .set('Authorization', admin(['owner']))
        .expect(200);
      expect(response.body.status).toBe('closed');
      expect(tenants.close).toHaveBeenCalledWith(
        TENANT_ID,
        expect.objectContaining({ id: ADMIN_ID }),
      );
    });

    it('GET :id/effective-rule resolves at the given moment', async () => {
      rules.getEffectiveRule.mockResolvedValue({
        tenantId: TENANT_ID,
        ratePercent: 5,
        minTotalKopecks: 0,
        dailyCapPoints: null,
        source: 'override',
      });
      const response = await request(testApp.server)
        .get(`/api/v1/admin/tenants/${TENANT_ID}/effective-rule?at=2026-02-01T00:00:00.000Z`)
        .set('Authorization', admin(['support']))
        .expect(200);
      expect(response.body).toMatchObject({ source: 'override', at: '2026-02-01T00:00:00.000Z' });
      expect(rules.getEffectiveRule).toHaveBeenCalledWith(
        TENANT_ID,
        new Date('2026-02-01T00:00:00.000Z'),
      );
    });
  });

  describe('admin fiscal numbers', () => {
    it('moderator confirms a pending number', async () => {
      fiscalNumbers.confirm.mockResolvedValue(fnRow);
      const response = await request(testApp.server)
        .post(`/api/v1/admin/fiscal-numbers/${FN_ID}/confirm`)
        .set('Authorization', admin(['moderator']))
        .send({ tenantId: TENANT_ID, note: 'каса 1' })
        .expect(200);
      expect(response.body).toMatchObject({
        fn: '4000100011',
        status: 'active',
        tenant: { slug: 'aroma-kava' },
      });
      expect(fiscalNumbers.confirm).toHaveBeenCalledWith(
        FN_ID,
        expect.objectContaining({ tenantId: TENANT_ID, note: 'каса 1' }),
        expect.objectContaining({ id: ADMIN_ID }),
      );
    });

    it('moderator blocks a number', async () => {
      fiscalNumbers.block.mockResolvedValue({ ...fnRow, status: 'blocked' });
      await request(testApp.server)
        .post(`/api/v1/admin/fiscal-numbers/${FN_ID}/block`)
        .set('Authorization', admin(['moderator']))
        .send({})
        .expect(200);
    });

    it('lists the moderation queue', async () => {
      fiscalNumbers.list.mockResolvedValue({
        items: [{ ...fnRow, status: 'pending', tenantId: null, tenant: null }],
        nextCursor: null,
      });
      await request(testApp.server)
        .get('/api/v1/admin/fiscal-numbers?status=pending&unmapped=true')
        .set('Authorization', admin(['support']))
        .expect(200);
      expect(fiscalNumbers.list).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending', unmapped: true }),
      );
    });

    it('DELETE answers 204', async () => {
      fiscalNumbers.remove.mockResolvedValue(undefined);
      await request(testApp.server)
        .delete(`/api/v1/admin/fiscal-numbers/${FN_ID}`)
        .set('Authorization', admin(['manager']))
        .expect(204);
    });

    it('support cannot confirm', async () => {
      await request(testApp.server)
        .post(`/api/v1/admin/fiscal-numbers/${FN_ID}/confirm`)
        .set('Authorization', admin(['support']))
        .send({ tenantId: TENANT_ID })
        .expect(403);
    });
  });

  describe('admin tenant rules', () => {
    it('POST creates a rule for the tenant in the body', async () => {
      rules.create.mockResolvedValue(ruleRow);
      await request(testApp.server)
        .post('/api/v1/admin/tenant-rules')
        .set('Authorization', admin(['manager']))
        .send({ tenantId: TENANT_ID, ratePercent: 10, validFrom: '2026-01-15T10:00:00.000Z' })
        .expect(201);
      expect(rules.create).toHaveBeenCalledWith(
        TENANT_ID,
        expect.objectContaining({ ratePercent: 10, validFrom: '2026-01-15T10:00:00.000Z' }),
        expect.objectContaining({ id: ADMIN_ID }),
      );
    });

    it('GET validates the filters', async () => {
      await request(testApp.server)
        .get('/api/v1/admin/tenant-rules?tenantId=nope')
        .set('Authorization', admin(['manager']))
        .expect(400);
      rules.list.mockResolvedValue({ items: [ruleRow], nextCursor: null });
      await request(testApp.server)
        .get(`/api/v1/admin/tenant-rules?tenantId=${TENANT_ID}&activeAt=2026-01-15T10:00:00.000Z`)
        .set('Authorization', admin(['manager']))
        .expect(200);
      expect(rules.list).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          activeAt: new Date('2026-01-15T10:00:00.000Z'),
        }),
      );
    });

    it('PATCH and DELETE address the rule by id', async () => {
      rules.updateById.mockResolvedValue({ ...ruleRow, ratePercent: 7 });
      rules.removeById.mockResolvedValue(undefined);
      await request(testApp.server)
        .patch(`/api/v1/admin/tenant-rules/${RULE_ID}`)
        .set('Authorization', admin(['manager']))
        .send({ ratePercent: 7, validTo: null })
        .expect(200);
      expect(rules.updateById).toHaveBeenCalledWith(
        RULE_ID,
        expect.objectContaining({ ratePercent: 7, validTo: null }),
        expect.objectContaining({ id: ADMIN_ID }),
      );
      await request(testApp.server)
        .delete(`/api/v1/admin/tenant-rules/${RULE_ID}`)
        .set('Authorization', admin(['manager']))
        .expect(204);
    });
  });

  describe('admin content import', () => {
    it('POST /admin/content/import runs the stub', async () => {
      imports.run.mockResolvedValue(runRow);
      const response = await request(testApp.server)
        .post('/api/v1/admin/content/import')
        .set('Authorization', admin(['manager']))
        .send({ source: 'wordpress', posts: [{ id: 1, title: { rendered: 'Aroma Kava' } }] })
        .expect(201);
      expect(response.body).toMatchObject({
        id: RUN_ID,
        status: 'succeeded',
        stats: { created: 1 },
      });
    });

    it('POST with async: true answers 202 with the running run', async () => {
      imports.run.mockResolvedValue({
        ...runRow,
        status: 'running',
        finishedAt: null,
        stats: null,
      });
      const response = await request(testApp.server)
        .post('/api/v1/admin/content/import')
        .set('Authorization', admin(['manager']))
        .send({ source: 'manual', async: true, items: [{ name: 'Aroma Kava' }] })
        .expect(202);
      expect(response.body).toMatchObject({ id: RUN_ID, status: 'running', stats: null });
      expect(imports.run).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'manual', async: true }),
        expect.objectContaining({ id: ADMIN_ID }),
      );
    });

    it('registers the content-import queue', () => {
      expect(testApp.queues.getInMemory('content-import').name).toBe('content-import');
    });

    it('POST rejects an unknown source', async () => {
      await request(testApp.server)
        .post('/api/v1/admin/content/import')
        .set('Authorization', admin(['manager']))
        .send({ source: 'ftp', items: [] })
        .expect(400);
      expect(imports.run).not.toHaveBeenCalled();
    });

    it('GET /admin/content/import-runs lists runs', async () => {
      imports.list.mockResolvedValue({ items: [runRow], nextCursor: null });
      const response = await request(testApp.server)
        .get('/api/v1/admin/content/import-runs?status=succeeded')
        .set('Authorization', admin(['support']))
        .expect(200);
      expect(response.body.items).toHaveLength(1);
    });
  });
});
