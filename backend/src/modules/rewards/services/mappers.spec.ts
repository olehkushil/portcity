import type { Reward, ValidatorDevice, Voucher } from '@prisma/client';
import { TEST_VOUCHER_PEPPER, tenantSummary } from '../../../../test/rewards/support/fakes';
import { parseStaticVoucherQr, voucherDisplayNumber } from '../domain/static-qr';
import { publicMediaUrl } from './media-url';
import { toRewardDto, toRewardTenantDto } from './reward.mapper';
import type { RedemptionLogWithVoucher } from './rewards.repository';
import {
  toValidatorDeviceDto,
  toValidatorLogEntryDto,
  toValidatorLogPageDto,
} from './validator.mapper';
import { toVoucherSummary, toVoucherView, voucherMeta } from './voucher.mapper';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);

function voucher(overrides: Partial<Voucher> = {}): Voucher {
  return {
    id: 'v-1',
    userId: 'user-1',
    kind: 'reward',
    title: 'Кава з собою',
    subtitle: 'Aroma Kava, 1 поверх',
    tenantId: 't-1',
    code: 'K7M2PQ',
    tokenHash: 'secret-hash',
    status: 'active',
    activatedAt: at(-30),
    activationExpiresAt: at(90),
    redeemedAt: null,
    redeemedByDeviceId: 'd-1',
    redeemedByTenantId: null,
    expiresAt: at(86_400),
    sourceType: 'redemption',
    sourceId: 'r-1',
    meta: { rewardId: 'rw-1' },
    imageKey: null,
    createdAt: at(-3600),
    updatedAt: at(-30),
    ...overrides,
  };
}

describe('toVoucherSummary', () => {
  it('exposes the code while the activation is live and never the token hash', () => {
    const summary = toVoucherSummary(voucher(), NOW);
    expect(summary).toEqual({
      id: 'v-1',
      userId: 'user-1',
      kind: 'reward',
      title: 'Кава з собою',
      subtitle: 'Aroma Kava, 1 поверх',
      tenantId: 't-1',
      status: 'active',
      code: 'K7M2PQ',
      activatedAt: at(-30),
      activationExpiresAt: at(90),
      redeemedAt: null,
      redeemedByTenantId: null,
      expiresAt: at(86_400),
      sourceType: 'redemption',
      sourceId: 'r-1',
      meta: { rewardId: 'rw-1' },
      createdAt: at(-3600),
      displayNumber: voucherDisplayNumber('v-1'),
      qrPayload: null,
      imageKey: null,
    });
    expect(summary.displayNumber).toMatch(/^\d{8}$/);
    expect(JSON.stringify(summary)).not.toContain('secret-hash');
    expect(JSON.stringify(summary)).not.toContain('d-1');
  });

  it('gives live tickets and certificates a static QR bound to id and expiresAt', () => {
    const ticket = voucher({ kind: 'ticket', status: 'issued', code: null });
    const summary = toVoucherSummary(ticket, NOW, { pepper: TEST_VOUCHER_PEPPER });
    expect(summary.qrPayload).toMatch(/^PCV1:/);
    expect(parseStaticVoucherQr(summary.qrPayload ?? '', TEST_VOUCHER_PEPPER, NOW)).toEqual({
      ok: true,
      voucherId: 'v-1',
      exp: Math.floor(at(86_400).getTime() / 1000),
    });
    // Without the pepper (contract callers), for other kinds and for final vouchers: none.
    expect(toVoucherSummary(ticket, NOW).qrPayload).toBeNull();
    expect(toVoucherSummary(voucher(), NOW, { pepper: TEST_VOUCHER_PEPPER }).qrPayload).toBeNull();
    expect(
      toVoucherSummary(voucher({ kind: 'certificate', status: 'redeemed' }), NOW, {
        pepper: TEST_VOUCHER_PEPPER,
      }).qrPayload,
    ).toBeNull();
  });

  it('builds the HTTP view with the tenant card and public URLs', () => {
    const summary = toVoucherSummary(voucher({ imageKey: 'rewards/coffee.webp' }), NOW);
    const view = toVoucherView(
      summary,
      tenantSummary({ id: 't-1', slug: 'aroma-kava', logoKey: 'logos/aroma.png' }),
      'https://cdn.portcity.ua/media/',
    );
    expect(view).toMatchObject({
      imageUrl: 'https://cdn.portcity.ua/media/rewards/coffee.webp',
      tenant: {
        id: 't-1',
        slug: 'aroma-kava',
        name: 'Aroma Kava',
        floor: 1,
        logoUrl: 'https://cdn.portcity.ua/media/logos/aroma.png',
      },
    });
    const bare = toVoucherView(summary, null, undefined);
    expect(bare).toMatchObject({ imageUrl: null, tenant: null });
  });

  it.each([
    ['lapsed activation', { activationExpiresAt: at(-1) }, 'issued'],
    ['passed expiry', { expiresAt: at(-1) }, 'expired'],
    ['redeemed', { status: 'redeemed' as const, redeemedAt: at(-5) }, 'redeemed'],
    ['cancelled', { status: 'cancelled' as const }, 'cancelled'],
  ])('hides the code after a %s', (_name, overrides, status) => {
    const summary = toVoucherSummary(voucher(overrides), NOW);
    expect(summary).toMatchObject({
      status,
      code: null,
      activatedAt: null,
      activationExpiresAt: null,
    });
  });

  it.each([
    [{ a: 1 }, { a: 1 }],
    [null, {}],
    [[1, 2], {}],
    ['text', {}],
  ])('normalises meta %j to %j', (meta, expected) => {
    expect(voucherMeta({ meta })).toEqual(expected);
  });
});

describe('toRewardDto', () => {
  const reward: Reward = {
    id: 'rw-1',
    title: 'Кава з собою',
    description: 'Будь-який напій до 0,4 л',
    costPoints: 60,
    kind: 'partner',
    tenantId: 't-1',
    stock: 3,
    perUserLimit: 2,
    active: true,
    validFrom: null,
    validTo: null,
    imageKey: 'rewards/coffee.webp',
    terms: 'Дійсна 2 хвилини після активації',
    sortOrder: 2,
    createdAt: at(-86_400),
    updatedAt: at(-3600),
  };

  it('adds member context: affordability, remaining limit and availability', () => {
    const tenant = tenantSummary({ id: 't-1' });
    const dto = toRewardDto(reward, {
      now: NOW,
      tenant,
      member: { userRedemptions: 1, availableBalance: 59 },
    });
    expect(dto).toMatchObject({
      id: 'rw-1',
      tenant: toRewardTenantDto(tenant),
      remainingForUser: 1,
      available: true,
      unavailableReason: null,
      affordable: false,
    });
  });

  it('reports the reason when the reward cannot be redeemed', () => {
    const dto = toRewardDto(reward, {
      now: NOW,
      tenant: null,
      member: { userRedemptions: 2, availableBalance: 600 },
    });
    expect(dto).toMatchObject({
      available: false,
      unavailableReason: 'limit_reached',
      affordable: true,
      tenant: null,
    });
  });

  it('leaves member fields null in back-office views', () => {
    const dto = toRewardDto({ ...reward, active: false }, { now: NOW, tenant: null });
    expect(dto).toMatchObject({
      remainingForUser: null,
      affordable: null,
      available: false,
      unavailableReason: 'inactive',
    });
  });

  it('maps the tenant card', () => {
    const tenant = tenantSummary({
      id: 't-9',
      slug: 'premier-city',
      name: 'Premier City',
      floor: 3,
      logoKey: 'logo.png',
    });
    expect(toRewardTenantDto(tenant)).toEqual({
      id: 't-9',
      slug: 'premier-city',
      name: 'Premier City',
      floor: 3,
      logoKey: 'logo.png',
      logoUrl: null,
    });
    expect(toRewardTenantDto(tenant, 'https://cdn.portcity.ua').logoUrl).toBe(
      'https://cdn.portcity.ua/logo.png',
    );
    // A logoUrl resolved by the content module wins over the local fallback.
    const resolved = { ...tenant, logoUrl: 'https://content.example/premier.png' };
    expect(toRewardTenantDto(resolved, 'https://cdn.portcity.ua').logoUrl).toBe(
      'https://content.example/premier.png',
    );
  });

  it('exposes imageUrl only when the public base URL is configured', () => {
    expect(toRewardDto(reward, { now: NOW, tenant: null }).imageUrl).toBeNull();
    expect(
      toRewardDto(reward, { now: NOW, tenant: null, publicBaseUrl: 'https://cdn.portcity.ua/' })
        .imageUrl,
    ).toBe('https://cdn.portcity.ua/rewards/coffee.webp');
  });
});

describe('publicMediaUrl', () => {
  it.each([
    ['https://cdn.x', 'a/b.png', 'https://cdn.x/a/b.png'],
    ['https://cdn.x/', '/a/b.png', 'https://cdn.x/a/b.png'],
    [undefined, 'a/b.png', null],
    ['', 'a/b.png', null],
    ['https://cdn.x', null, null],
    ['https://cdn.x', '  ', null],
    [undefined, 'https://elsewhere/a.png', 'https://elsewhere/a.png'],
  ])('base %j + key %j -> %j', (base, key, expected) => {
    expect(publicMediaUrl(base, key)).toBe(expected);
  });
});

describe('validator mappers', () => {
  const device: ValidatorDevice = {
    id: 'd-1',
    tenantId: null,
    name: 'Інфостійка',
    pinHash: '$scrypt$secret',
    deviceKeyHash: 'f'.repeat(64),
    active: true,
    lastSeenAt: at(-60),
    revokedAt: null,
    failedPinAttempts: 2,
    pinLockedUntil: null,
    createdAt: at(-86_400),
    updatedAt: at(-60),
  };

  it('never exposes the PIN or key hashes', () => {
    const dto = toValidatorDeviceDto(device);
    expect(dto).toEqual({
      id: 'd-1',
      tenantId: null,
      name: 'Інфостійка',
      active: true,
      lastSeenAt: at(-60),
      revokedAt: null,
      failedPinAttempts: 2,
      pinLockedUntil: null,
      createdAt: at(-86_400),
      updatedAt: at(-60),
    });
  });

  const log: RedemptionLogWithVoucher = {
    id: 'l-1',
    voucherId: 'v-1',
    validatorDeviceId: 'd-1',
    method: 'code',
    codeTried: 'K7M2PQ',
    outcome: 'redeemed',
    message: null,
    ip: '10.0.0.1',
    createdAt: NOW,
    voucher: { id: 'v-1', title: 'Кава з собою', kind: 'reward' },
  };

  it('maps log entries without the client IP', () => {
    expect(toValidatorLogEntryDto(log)).toEqual({
      id: 'l-1',
      voucherId: 'v-1',
      voucher: { id: 'v-1', title: 'Кава з собою', kind: 'reward' },
      method: 'code',
      codeTried: 'K7M2PQ',
      outcome: 'redeemed',
      message: null,
      createdAt: NOW,
    });
    expect(toValidatorLogEntryDto({ ...log, voucherId: null, voucher: null }).voucher).toBeNull();
  });

  it('maps pages', () => {
    expect(toValidatorLogPageDto({ items: [log], nextCursor: 'abc' })).toEqual({
      items: [toValidatorLogEntryDto(log)],
      nextCursor: 'abc',
    });
  });

  it("hides another tenant's voucher on the device's own log, not in the back office", () => {
    const foreign: RedemptionLogWithVoucher = { ...log, outcome: 'wrong_tenant' };
    expect(toValidatorLogEntryDto(foreign, { forDevice: true })).toMatchObject({
      voucherId: null,
      voucher: null,
      outcome: 'wrong_tenant',
    });
    expect(toValidatorLogEntryDto(foreign)).toMatchObject({ voucherId: 'v-1' });
    expect(toValidatorLogEntryDto(log, { forDevice: true }).voucherId).toBe('v-1');
  });
});
