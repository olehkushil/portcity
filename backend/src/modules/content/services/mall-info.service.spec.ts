import { type AppConfig, DEFAULT_MALL_ADDRESS } from '../../../common/config';
import { parseEnvSection } from '../../../common/config/env-section';
import type { AdminAuditPort, AuditEntry } from '../../../common/contracts/admin';
import { FakeClock } from '../../../common/time/clock';
import { EMPTY_MALL_INFO, type StoredMallInfo } from '../domain/mall-info';
import type { UpdateMallInfoDto } from '../dto/mall-info.dto';
import { contentEnvSchema } from './content.config';
import type { MallInfoRepository, StoredMallInfoRow } from './mall-info.repository';
import { MALL_INFO_CACHE_MS, MallInfoService, toStoredMallInfo } from './mall-info.service';

// 2026-01-15 is winter time: Kyiv = UTC+2.
const NOON_KYIV = '2026-01-15T10:00:00.000Z';
const ADMIN = { id: '0192f3a0-0000-7000-8000-00000000a001', ip: '10.0.0.1' };

/** In-memory mall_info row with a failure switch. */
class FakeMallInfoRepo {
  row: StoredMallInfoRow | null = null;
  fail = false;
  finds = 0;

  async find(): Promise<StoredMallInfoRow | null> {
    this.finds += 1;
    if (this.fail) {
      throw new Error('database unavailable');
    }
    return this.row;
  }

  async save(
    _tx: unknown,
    data: StoredMallInfo,
    updatedById: string,
    now: Date,
  ): Promise<StoredMallInfoRow> {
    this.row = { ...data, updatedById, updatedAt: now };
    return this.row;
  }

  transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    return fn({ fakeTx: true });
  }
}

function makeService(
  config: Partial<AppConfig> = {},
  env: Record<string, string> = {},
  now: string = NOON_KYIV,
) {
  const app = {
    MALL_NAME: 'Порт City',
    MALL_ADDRESS: DEFAULT_MALL_ADDRESS,
    MALL_HOURS: '10:00-22:00',
    SUPPORT_PHONE: '+380332000000',
    SUPPORT_EMAIL: 'support@portcity.com.ua',
    ...config,
  } as AppConfig;
  const repo = new FakeMallInfoRepo();
  const audits: Array<AuditEntry & { inTx: boolean }> = [];
  const audit: AdminAuditPort = {
    audit: async (entry, tx) => {
      audits.push({ ...entry, inTx: tx !== undefined });
      return 'audit-1';
    },
  };
  const clock = new FakeClock(now);
  const service = new MallInfoService(
    app,
    parseEnvSection(contentEnvSchema, 'content', env),
    clock,
    repo as unknown as MallInfoRepository,
    audit,
  );
  return { service, repo, audits, clock };
}

const FULL_UPDATE: UpdateMallInfoDto = {
  address: 'просп. Соборності, 43, м. Луцьк, 43000',
  hours: '09:00-21:00',
  telegramUrl: 'https://t.me/portcity_lutsk',
  infoDesk: { location: '1 поверх, центральний вхід', hours: '10:00-22:00' },
  parkingOperator: { name: 'ТОВ «Паркінг»', phone: '+380500000000', hours: 'цілодобово' },
  rulesPdfUrl: 'https://portcity.com.ua/rules.pdf',
  legalDocuments: [
    { key: 'privacy', title: 'Політика конфіденційності', url: 'https://portcity.com.ua/privacy' },
  ],
  floorMapUrls: [
    { floor: 2, url: 'https://cdn.example/mall/floor-2.png' },
    { floor: 1, url: 'https://cdn.example/mall/floor-1.png' },
  ],
  parkingMapUrl: 'https://cdn.example/mall/parking.png',
  support: { phone: '+380332111111', email: 'help@portcity.com.ua' },
};

describe('MallInfoService', () => {
  it('answers from configuration when nothing is stored', async () => {
    const { service } = makeService();
    await expect(service.getInfo()).resolves.toEqual({
      name: 'Порт City',
      address: 'просп. Соборності, 43, Луцьк',
      website: 'https://portcity.com.ua',
      timezone: 'Europe/Kyiv',
      hours: { from: '10:00', to: '22:00', isOpenNow: true },
      parking: {
        underground: { from: '08:00', to: '21:00' },
        surface: { from: '05:00', to: '24:00' },
      },
      support: { phone: '+380332000000', email: 'support@portcity.com.ua' },
      telegramUrl: null,
      infoDesk: null,
      parkingOperator: null,
      rulesPdfUrl: null,
      legalDocuments: [],
      floorMapUrls: [],
      parkingMapUrl: null,
      serverTime: new Date(NOON_KYIV),
    });
  });

  it.each([
    ['2026-01-15T07:59:00.000Z', false], // 09:59 Kyiv (winter, UTC+2)
    ['2026-01-15T08:00:00.000Z', true], // 10:00
    ['2026-01-15T19:59:00.000Z', true], // 21:59
    ['2026-01-15T20:00:00.000Z', false], // 22:00, end is exclusive
    ['2026-07-15T18:30:00.000Z', true], // 21:30 Kyiv (summer, UTC+3)
    ['2026-07-15T19:30:00.000Z', false], // 22:30 Kyiv
  ])('isOpenNow at %s -> %s', async (now, expected) => {
    const { service } = makeService({}, {}, now);
    expect((await service.getInfo()).hours.isOpenNow).toBe(expected);
  });

  it('uses configured address, hours, parking zones and missing support contacts', async () => {
    const { service } = makeService(
      {
        MALL_ADDRESS: 'просп. Соборності, 43, м. Луцьк, 43000',
        MALL_HOURS: '09:00 - 21:00',
        SUPPORT_PHONE: undefined,
        SUPPORT_EMAIL: undefined,
      },
      { MALL_PARKING_UNDERGROUND_HOURS: '07:00-23:00', MALL_WEBSITE: 'https://example.org' },
    );
    const info = await service.getInfo();
    expect(info.address).toBe('просп. Соборності, 43, м. Луцьк, 43000');
    expect(info.hours).toMatchObject({ from: '09:00', to: '21:00' });
    expect(info.parking.underground).toEqual({ from: '07:00', to: '23:00' });
    expect(info.parking.surface).toEqual({ from: '05:00', to: '24:00' });
    expect(info.support).toEqual({ phone: null, email: null });
    expect(info.website).toBe('https://example.org');
  });

  it('falls back to 10:00-22:00 when MALL_HOURS is malformed', async () => {
    const { service } = makeService({ MALL_HOURS: 'щодня' });
    expect((await service.getInfo()).hours).toMatchObject({ from: '10:00', to: '22:00' });
  });

  it('rejects malformed parking hours in the environment', () => {
    expect(() => makeService({}, { MALL_PARKING_SURFACE_HOURS: 'always' })).toThrow(
      /MALL_PARKING_SURFACE_HOURS/,
    );
  });

  it('prefers MALL_LOGO_BASE_URL over S3_PUBLIC_BASE_URL for logos', () => {
    expect(makeService({ S3_PUBLIC_BASE_URL: 'https://cdn.example/s3' }).service.logoBaseUrl).toBe(
      'https://cdn.example/s3',
    );
    expect(
      makeService(
        { S3_PUBLIC_BASE_URL: 'https://cdn.example/s3' },
        { MALL_LOGO_BASE_URL: 'https://img.example' },
      ).service.logoBaseUrl,
    ).toBe('https://img.example');
  });

  it('stores the back-office facts, audits the change and serves them publicly', async () => {
    const { service, audits } = makeService();
    const admin = await service.update(FULL_UPDATE, ADMIN);

    expect(admin).toMatchObject({
      address: 'просп. Соборності, 43, м. Луцьк, 43000',
      hours: '09:00-21:00',
      infoDesk: { location: '1 поверх, центральний вхід', hours: '10:00-22:00' },
      updatedById: ADMIN.id,
      updatedAt: new Date(NOON_KYIV),
    });
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'mall_info.update',
        entityType: 'mall_info',
        entityId: '1',
        actor: { type: 'admin', id: ADMIN.id },
        before: null,
        inTx: true,
        ip: ADMIN.ip,
      }),
    ]);

    const info = await service.getInfo();
    expect(info).toMatchObject({
      address: 'просп. Соборності, 43, м. Луцьк, 43000',
      hours: { from: '09:00', to: '21:00', isOpenNow: true },
      telegramUrl: 'https://t.me/portcity_lutsk',
      infoDesk: { location: '1 поверх, центральний вхід', hours: '10:00-22:00' },
      parkingOperator: { name: 'ТОВ «Паркінг»', phone: '+380500000000', hours: 'цілодобово' },
      rulesPdfUrl: 'https://portcity.com.ua/rules.pdf',
      legalDocuments: [
        {
          key: 'privacy',
          title: 'Політика конфіденційності',
          url: 'https://portcity.com.ua/privacy',
        },
      ],
      parkingMapUrl: 'https://cdn.example/mall/parking.png',
      support: { phone: '+380332111111', email: 'help@portcity.com.ua' },
    });
    // Floor maps are served in floor order.
    expect(info.floorMapUrls.map((map) => map.floor)).toEqual([1, 2]);
    // Tenant cards use the stored mall hours as their fallback.
    await expect(service.tenantViewContext()).resolves.toMatchObject({
      mallHours: { from: '09:00', to: '21:00' },
    });
  });

  it('PUT replaces everything: omitted fields fall back to configuration again', async () => {
    const { service, audits } = makeService();
    await service.update(FULL_UPDATE, ADMIN);
    await service.update({ telegramUrl: 'https://t.me/other' }, ADMIN);
    const info = await service.getInfo();
    expect(info).toMatchObject({
      address: 'просп. Соборності, 43, Луцьк',
      hours: { from: '10:00', to: '22:00' },
      telegramUrl: 'https://t.me/other',
      infoDesk: null,
      parkingOperator: null,
      support: { phone: '+380332000000', email: 'support@portcity.com.ua' },
    });
    expect(audits[1]).toMatchObject({
      before: expect.objectContaining({ hours: '09:00-21:00' }),
      after: expect.objectContaining({ hours: null, telegramUrl: 'https://t.me/other' }),
    });
  });

  it('caches the stored row for 30 s and answers from configuration when the database fails', async () => {
    const { service, repo, clock } = makeService();
    repo.row = {
      ...EMPTY_MALL_INFO,
      address: 'Збережена адреса',
      updatedById: null,
      updatedAt: new Date(),
    };
    expect((await service.getInfo()).address).toBe('Збережена адреса');
    await service.getInfo();
    expect(repo.finds).toBe(1);

    clock.advance(MALL_INFO_CACHE_MS);
    repo.fail = true;
    // The last good row is kept while the database is down.
    expect((await service.getInfo()).address).toBe('Збережена адреса');

    const cold = makeService();
    cold.repo.fail = true;
    await expect(cold.service.getInfo()).resolves.toMatchObject({
      address: 'просп. Соборності, 43, Луцьк',
    });
  });

  it('maps the PUT body to stored columns', () => {
    expect(toStoredMallInfo({})).toEqual(EMPTY_MALL_INFO);
    expect(toStoredMallInfo({ infoDesk: null, support: { email: 'a@b.ua' } })).toMatchObject({
      infoDeskLocation: null,
      supportPhone: null,
      supportEmail: 'a@b.ua',
    });
  });
});
