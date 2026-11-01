import type { CouponClaim, CouponTemplate, Promo } from '@prisma/client';
import type { FeatureFlagsPort } from '../../../common/contracts/admin';
import type { ContentPort, TenantSummary } from '../../../common/contracts/content';
import type {
  IssueVoucherInput,
  VoucherIssuerPort,
  VoucherSourceType,
  VoucherSummary,
} from '../../../common/contracts/rewards';
import type { OutboxEventInput } from '../../../common/outbox/outbox.types';
import type { OutboxService } from '../../../common/outbox/outbox.service';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { FakeClock } from '../../../common/time/clock';
import { PromosPresenter } from './promos-presenter.service';
import { PromosService } from './promos.service';

const NOW = '2026-11-01T10:00:00.000Z';
const USER = '01900000-0000-7000-8000-000000000001';
const OTHER_USER = '01900000-0000-7000-8000-000000000002';
const PROMO = '01900000-0000-7000-8000-0000000000b1';
const TEMPLATE = '01900000-0000-7000-8000-0000000000b2';
const TENANT = '01900000-0000-7000-8000-0000000000b3';

type PromoRow = Promo & { couponTemplate: CouponTemplate | null };

function template(overrides: Partial<CouponTemplate> = {}): CouponTemplate {
  return {
    id: TEMPLATE,
    discountText: '-20 % на взуття',
    perUserLimit: 1,
    totalLimit: 100,
    claimedCount: 0,
    requiresActivation: true,
    validityHoursAfterClaim: 72,
    terms: 'Не сумується з іншими знижками',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

function promo(overrides: Partial<Promo> = {}): Promo {
  return {
    id: PROMO,
    tenantId: TENANT,
    title: '-20 % INTERTOP до 15.11',
    body: 'Знижка на нову колекцію',
    kind: 'coupon',
    category: 'fashion',
    validFrom: new Date('2026-10-25T00:00:00.000Z'),
    validTo: new Date('2026-11-15T21:59:59.000Z'),
    imageKey: 'promos/2026/10/intertop.jpg',
    status: 'published',
    couponTemplateId: TEMPLATE,
    priority: 10,
    createdAt: new Date('2026-10-20T00:00:00.000Z'),
    updatedAt: new Date('2026-10-20T00:00:00.000Z'),
    ...overrides,
  };
}

class FakePrisma {
  promos = new Map<string, Promo>();
  templates = new Map<string, CouponTemplate>();
  claims: CouponClaim[] = [];

  private withTemplate(row: Promo): PromoRow {
    return {
      ...row,
      couponTemplate: row.couponTemplateId
        ? (this.templates.get(row.couponTemplateId) ?? null)
        : null,
    };
  }

  readonly promo = {
    findUnique: async (args: { where: { id: string } }) => {
      const row = this.promos.get(args.where.id);
      return row ? this.withTemplate(row) : null;
    },
    findMany: jest.fn(async () => [...this.promos.values()].map((row) => this.withTemplate(row))),
  };

  readonly couponTemplate = {
    update: async (args: {
      where: { id: string };
      data: { claimedCount: { increment: number } };
    }) => {
      const row = this.templates.get(args.where.id);
      if (!row) {
        throw new Error('template missing');
      }
      row.claimedCount += args.data.claimedCount.increment;
      return { ...row };
    },
    updateMany: async (args: {
      where: { id: string; claimedCount: { gt: number } };
      data: { claimedCount: { decrement: number } };
    }) => {
      const row = this.templates.get(args.where.id);
      if (!row || row.claimedCount <= args.where.claimedCount.gt) {
        return { count: 0 };
      }
      row.claimedCount -= args.data.claimedCount.decrement;
      return { count: 1 };
    },
  };

  readonly couponClaim = {
    create: async (args: { data: Omit<CouponClaim, 'cancelledAt'> & { cancelledAt?: Date } }) => {
      const row: CouponClaim = { cancelledAt: null, ...args.data };
      this.claims.push(row);
      return { ...row };
    },
    count: async (args: { where: { promoId: string; userId: string; status: string } }) =>
      this.claims.filter(
        (row) =>
          row.promoId === args.where.promoId &&
          row.userId === args.where.userId &&
          row.status === args.where.status,
      ).length,
    findUnique: async (args: { where: { id: string } }) =>
      this.claims.find((row) => row.id === args.where.id) ?? null,
    updateMany: async (args: {
      where: { id: string; status: CouponClaim['status'] };
      data: { status: CouponClaim['status']; cancelledAt: Date };
    }) => {
      const row = this.claims.find(
        (claim) => claim.id === args.where.id && claim.status === args.where.status,
      );
      if (!row) {
        return { count: 0 };
      }
      Object.assign(row, args.data);
      return { count: 1 };
    },
  };

  readonly $queryRaw = jest.fn(async () => []);

  withTx<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

/** Contract-level fake of VOUCHER_ISSUER_PORT: idempotent per (sourceType, sourceId, kind). */
class FakeVoucherIssuer implements VoucherIssuerPort {
  readonly vouchers: VoucherSummary[] = [];
  readonly issueCalls: IssueVoucherInput[] = [];

  issue = jest.fn(async (input: IssueVoucherInput, _tx?: unknown): Promise<VoucherSummary> => {
    this.issueCalls.push(input);
    const existing = this.vouchers.find(
      (voucher) =>
        voucher.sourceType === input.sourceType &&
        voucher.sourceId === input.sourceId &&
        voucher.kind === input.kind,
    );
    if (existing) {
      return existing;
    }
    const voucher: VoucherSummary = {
      id: `voucher-${this.vouchers.length + 1}`,
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      subtitle: input.subtitle ?? null,
      tenantId: input.tenantId ?? null,
      status: 'issued',
      code: null,
      activatedAt: null,
      activationExpiresAt: null,
      redeemedAt: null,
      redeemedByTenantId: null,
      expiresAt: input.expiresAt ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      meta: input.meta ?? {},
      createdAt: new Date(NOW),
    };
    this.vouchers.push(voucher);
    return voucher;
  });

  cancel = jest.fn();
  getVoucher = jest.fn(
    async (id: string) => this.vouchers.find((voucher) => voucher.id === id) ?? null,
  );
  listBySource = jest.fn(async (sourceType: VoucherSourceType, sourceId: string) =>
    this.vouchers.filter(
      (voucher) => voucher.sourceType === sourceType && voucher.sourceId === sourceId,
    ),
  );
  getDailyStats = jest.fn();
}

const tenant: TenantSummary = {
  id: TENANT,
  slug: 'intertop',
  name: 'INTERTOP',
  category: 'fashion',
  floor: 1,
  logoKey: null,
  participates: true,
  ratePercentOverride: null,
  excludedFromProgram: false,
  status: 'active',
};

function setup(
  options: {
    promo?: Partial<Promo>;
    template?: Partial<CouponTemplate> | null;
    imageBaseUrl?: string;
  } = {},
) {
  const prisma = new FakePrisma();
  const clock = new FakeClock(NOW);
  const vouchers = new FakeVoucherIssuer();
  const events: OutboxEventInput[] = [];
  const outbox = {
    publish: jest.fn(async (_tx: unknown, event: OutboxEventInput) => {
      events.push(event);
      return 'evt';
    }),
  };
  const content = {
    getTenant: jest.fn(async () => tenant),
    getTenants: jest.fn(async () => [tenant]),
  } as unknown as ContentPort;
  prisma.promos.set(PROMO, promo(options.promo));
  if (options.template !== null) {
    prisma.templates.set(TEMPLATE, template(options.template ?? {}));
  }
  const flags: FeatureFlagsPort = { isEnabled: jest.fn(), get: jest.fn(async () => null) };
  const presenter = new PromosPresenter(
    { S3_PUBLIC_BASE_URL: options.imageBaseUrl },
    content,
    flags,
  );
  const service = new PromosService(
    prisma as unknown as PrismaService,
    clock,
    outbox as unknown as OutboxService,
    vouchers,
    presenter,
  );
  return { service, prisma, vouchers, events, clock };
}

describe('PromosService.claim', () => {
  it('records a claim, issues its coupon through VOUCHER_ISSUER_PORT and counts it', async () => {
    const { service, vouchers, prisma, events } = setup();

    const result = await service.claim(PROMO, USER);

    expect(prisma.claims).toHaveLength(1);
    const claimId = prisma.claims[0]!.id;
    expect(prisma.claims[0]).toMatchObject({
      promoId: PROMO,
      couponTemplateId: TEMPLATE,
      userId: USER,
      voucherId: 'voucher-1',
      status: 'active',
      cancelledAt: null,
    });
    expect(vouchers.issue).toHaveBeenCalledTimes(1);
    expect(vouchers.issueCalls[0]).toEqual({
      userId: USER,
      kind: 'coupon',
      title: '-20 % INTERTOP до 15.11',
      subtitle: '-20 % на взуття',
      tenantId: TENANT,
      // 72 hours after the claim, inside the promo window.
      expiresAt: new Date('2026-11-04T10:00:00.000Z'),
      sourceType: 'promo',
      sourceId: claimId,
      meta: expect.objectContaining({
        promoId: PROMO,
        couponTemplateId: TEMPLATE,
        claimId,
        requiresActivation: true,
      }),
    });
    expect(vouchers.issue.mock.calls[0]?.[1]).toBe(prisma);
    expect(prisma.templates.get(TEMPLATE)?.claimedCount).toBe(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'promo.coupon_claimed',
        aggregateId: PROMO,
        payload: {
          promoId: PROMO,
          couponTemplateId: TEMPLATE,
          userId: USER,
          voucherId: 'voucher-1',
        },
      }),
    ]);
    expect(result).toMatchObject({
      promoId: PROMO,
      couponTemplateId: TEMPLATE,
      claimedByMe: 1,
      remainingForMe: 0,
      remainingInPool: 99,
      voucher: { id: 'voucher-1', kind: 'coupon', sourceType: 'promo' },
    });
  });

  it('caps the coupon expiry at the end of the promo window', async () => {
    const { service, vouchers } = setup({ template: { validityHoursAfterClaim: 24 * 30 } });
    await service.claim(PROMO, USER);
    expect(vouchers.issueCalls[0]?.expiresAt).toEqual(new Date('2026-11-15T21:59:59.000Z'));
  });

  it('enforces the per-member limit', async () => {
    const { service, vouchers } = setup();
    await service.claim(PROMO, USER);
    await expect(service.claim(PROMO, USER)).rejects.toMatchObject({
      code: 'PC_COUPON_LIMIT_REACHED',
      status: 422,
    });
    expect(vouchers.issue).toHaveBeenCalledTimes(1);
  });

  it('gives every claim its own id when the member may claim several coupons', async () => {
    const { service, vouchers, prisma } = setup({ template: { perUserLimit: 2 } });
    await service.claim(PROMO, USER);
    const second = await service.claim(PROMO, USER);
    expect(prisma.claims.map((claim) => claim.id)).toEqual([
      vouchers.issueCalls[0]?.sourceId,
      vouchers.issueCalls[1]?.sourceId,
    ]);
    expect(new Set(prisma.claims.map((claim) => claim.id)).size).toBe(2);
    expect(second).toMatchObject({ claimedByMe: 2, remainingForMe: 0 });
  });

  it('does not count a cancelled claim against the member', async () => {
    const { service, prisma } = setup();
    await service.claim(PROMO, USER);
    await expect(service.cancelCouponClaim(prisma.claims[0]!.id)).resolves.toBe('coupon_released');
    const again = await service.claim(PROMO, USER);
    expect(prisma.claims).toHaveLength(2);
    expect(again.claimedByMe).toBe(1);
  });

  it('counts only the member own claims against the per-member limit', async () => {
    const { service } = setup();
    await service.claim(PROMO, OTHER_USER);
    await expect(service.claim(PROMO, USER)).resolves.toMatchObject({ claimedByMe: 1 });
  });

  it('refuses when the pool is sold out', async () => {
    const { service, vouchers } = setup({ template: { totalLimit: 1 } });
    await service.claim(PROMO, OTHER_USER);
    await expect(service.claim(PROMO, USER)).rejects.toMatchObject({ code: 'PC_COUPON_SOLD_OUT' });
    expect(vouchers.issue).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ kind: 'info' as const, couponTemplateId: null }, 'PC_PROMO_NOT_COUPON'],
    [{ status: 'draft' as const }, 'PC_PROMO_NOT_PUBLISHED'],
    [{ validTo: new Date('2026-10-31T00:00:00.000Z') }, 'PC_PROMO_EXPIRED'],
    [{ validFrom: new Date('2026-11-05T00:00:00.000Z') }, 'PC_PROMO_EXPIRED'],
  ])('rejects promo %j with %s before issuing anything', async (override, code) => {
    const { service, vouchers } = setup({ promo: override });
    await expect(service.claim(PROMO, USER)).rejects.toMatchObject({ code });
    expect(vouchers.issue).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown promo', async () => {
    const { service } = setup();
    await expect(service.claim('01900000-0000-7000-8000-00000000dead', USER)).rejects.toMatchObject(
      { code: 'PC_PROMO_NOT_FOUND', status: 404 },
    );
  });
});

describe('PromosService reads and the PromosPort hooks', () => {
  it('validateClaim mirrors the claim rules without side effects', async () => {
    const { service, vouchers, prisma } = setup();
    const allowed = await service.validateClaim({ promoId: PROMO, userId: USER });
    expect(allowed).toMatchObject({
      allowed: true,
      promo: { id: PROMO, kind: 'coupon' },
      template: { id: TEMPLATE, perUserLimit: 1 },
    });
    await service.claim(PROMO, USER);
    const refused = await service.validateClaim({ promoId: PROMO, userId: USER });
    expect(refused).toEqual({
      allowed: false,
      code: 'PC_COUPON_LIMIT_REACHED',
      detail: expect.any(String),
    });
    expect(vouchers.issue).toHaveBeenCalledTimes(1);
    expect(prisma.templates.get(TEMPLATE)?.claimedCount).toBe(1);
  });

  it('shows the member claim state on the promo detail and hides drafts', async () => {
    const { service } = setup();
    const detail = await service.getPublishedForMember(PROMO, USER);
    expect(detail).toMatchObject({
      id: PROMO,
      window: 'active',
      tenant: { slug: 'intertop' },
      claim: { allowed: true, code: null, claimedByMe: 0 },
    });

    const drafts = setup({ promo: { status: 'draft' } });
    await expect(drafts.service.getPublishedForMember(PROMO, USER)).rejects.toMatchObject({
      code: 'PC_PROMO_NOT_FOUND',
    });
  });

  it('serves guests the detail with claim = PC_AUTH_REQUIRED and no claim lookups', async () => {
    const { service, prisma } = setup();
    const countSpy = jest.spyOn(prisma.couponClaim, 'count');
    const detail = await service.getPublishedForMember(PROMO, undefined);
    expect(detail).toMatchObject({
      id: PROMO,
      category: 'fashion',
      claim: { allowed: false, code: 'PC_AUTH_REQUIRED', claimedByMe: 0 },
    });
    expect(countSpy).not.toHaveBeenCalled();
  });

  it('builds imageUrl from S3_PUBLIC_BASE_URL and leaves it null without the base URL', async () => {
    const withBase = setup({ imageBaseUrl: 'https://cdn.portcity.ua/' });
    const page = await withBase.service.listPublished({ limit: 20 });
    expect(page.items[0]).toMatchObject({
      imageKey: 'promos/2026/10/intertop.jpg',
      imageUrl: 'https://cdn.portcity.ua/promos/2026/10/intertop.jpg',
    });
    const withoutBase = setup();
    const detail = await withoutBase.service.getPublishedForMember(PROMO, USER);
    expect(detail.imageUrl).toBeNull();
  });

  it('filters the published list by category', async () => {
    const { service, prisma } = setup();
    await service.listPublished({ limit: 20, category: 'fashion' });
    expect(prisma.promo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: expect.arrayContaining([{ category: 'fashion' }]) },
      }),
    );
  });

  it('getPromoSummary returns the contract shape or null', async () => {
    const { service } = setup();
    await expect(service.getPromoSummary(PROMO)).resolves.toMatchObject({
      id: PROMO,
      couponTemplateId: TEMPLATE,
      priority: 10,
    });
    await expect(service.getPromoSummary('missing')).resolves.toBeNull();
  });

  it('cancelCouponClaim returns the coupon to the pool once and ignores replays', async () => {
    const { service, prisma } = setup();
    await service.claim(PROMO, USER);
    const claimId = prisma.claims[0]!.id;
    expect(prisma.templates.get(TEMPLATE)?.claimedCount).toBe(1);

    await expect(service.cancelCouponClaim(claimId)).resolves.toBe('coupon_released');
    expect(prisma.claims[0]).toMatchObject({
      status: 'cancelled',
      cancelledAt: new Date(NOW),
    });
    expect(prisma.templates.get(TEMPLATE)?.claimedCount).toBe(0);

    await expect(service.cancelCouponClaim(claimId)).resolves.toBe('already_cancelled');
    expect(prisma.templates.get(TEMPLATE)?.claimedCount).toBe(0);
    await expect(service.cancelCouponClaim('missing-claim')).resolves.toBe('not_found');
  });

  it('cancelCouponClaim never drives the pool counter below zero', async () => {
    const { service, prisma } = setup();
    await service.claim(PROMO, USER);
    prisma.templates.get(TEMPLATE)!.claimedCount = 0;
    await expect(service.cancelCouponClaim(prisma.claims[0]!.id)).resolves.toBe('coupon_released');
    expect(prisma.templates.get(TEMPLATE)?.claimedCount).toBe(0);
  });
});
