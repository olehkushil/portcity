import {
  type ClaimContext,
  type ClaimDecision,
  type CouponTemplateRuleInput,
  type PromoRuleInput,
  couponExpiresAt,
  decideClaim,
  isPromoActiveAt,
  isValidCouponLimits,
  isValidPromoWindow,
  promoWindowState,
  remainingCoupons,
} from './promo-rules';

const now = new Date('2026-11-01T12:00:00.000Z');

function promo(overrides: Partial<PromoRuleInput> = {}): PromoRuleInput {
  return {
    id: 'promo-1',
    status: 'published',
    kind: 'coupon',
    validFrom: new Date('2026-10-25T00:00:00.000Z'),
    validTo: new Date('2026-11-15T21:59:00.000Z'),
    couponTemplateId: 'template-1',
    ...overrides,
  };
}

function template(overrides: Partial<CouponTemplateRuleInput> = {}): CouponTemplateRuleInput {
  return {
    perUserLimit: 1,
    totalLimit: 500,
    claimedCount: 0,
    validityHoursAfterClaim: 72,
    ...overrides,
  };
}

function context(overrides: Partial<ClaimContext> = {}): ClaimContext {
  return { now, userClaimCount: 0, ...overrides };
}

describe('decideClaim', () => {
  const table: Array<
    [string, PromoRuleInput | null, CouponTemplateRuleInput | null, ClaimContext, ClaimDecision]
  > = [
    ['happy path', promo(), template(), context(), { allowed: true }],
    [
      'missing promo',
      null,
      template(),
      context(),
      { allowed: false, code: 'PC_PROMO_NOT_FOUND', detail: 'Promo does not exist' },
    ],
    [
      'draft promo',
      promo({ status: 'draft' }),
      template(),
      context(),
      {
        allowed: false,
        code: 'PC_PROMO_NOT_PUBLISHED',
        detail: 'Promo is draft, only published promos can be claimed',
      },
    ],
    [
      'archived promo',
      promo({ status: 'archived' }),
      template(),
      context(),
      {
        allowed: false,
        code: 'PC_PROMO_NOT_PUBLISHED',
        detail: 'Promo is archived, only published promos can be claimed',
      },
    ],
    [
      'info promo',
      promo({ kind: 'info', couponTemplateId: null }),
      null,
      context(),
      {
        allowed: false,
        code: 'PC_PROMO_NOT_COUPON',
        detail: 'This promo is informational and does not issue coupons',
      },
    ],
    [
      'coupon promo without template row',
      promo(),
      null,
      context(),
      {
        allowed: false,
        code: 'PC_PROMO_NOT_COUPON',
        detail: 'This promo is informational and does not issue coupons',
      },
    ],
    [
      'not started yet',
      promo({ validFrom: new Date('2026-11-02T00:00:00.000Z') }),
      template(),
      context(),
      {
        allowed: false,
        code: 'PC_PROMO_EXPIRED',
        detail: 'Promo starts at 2026-11-02T00:00:00.000Z',
      },
    ],
    [
      'already ended',
      promo({ validTo: new Date('2026-10-31T23:59:59.000Z') }),
      template(),
      context(),
      {
        allowed: false,
        code: 'PC_PROMO_EXPIRED',
        detail: 'Promo ended at 2026-10-31T23:59:59.000Z',
      },
    ],
    [
      'last millisecond of the window is still valid',
      promo({ validTo: now }),
      template(),
      context(),
      { allowed: true },
    ],
    [
      'sold out',
      promo(),
      template({ totalLimit: 500, claimedCount: 500 }),
      context(),
      {
        allowed: false,
        code: 'PC_COUPON_SOLD_OUT',
        detail: 'All 500 coupons have been claimed',
      },
    ],
    [
      'over-claimed counter still reads as sold out',
      promo(),
      template({ totalLimit: 10, claimedCount: 12 }),
      context(),
      { allowed: false, code: 'PC_COUPON_SOLD_OUT', detail: 'All 10 coupons have been claimed' },
    ],
    [
      'unlimited pool ignores the counter',
      promo(),
      template({ totalLimit: null, claimedCount: 100000 }),
      context(),
      { allowed: true },
    ],
    [
      'per-user limit reached',
      promo(),
      template({ perUserLimit: 1 }),
      context({ userClaimCount: 1 }),
      {
        allowed: false,
        code: 'PC_COUPON_LIMIT_REACHED',
        detail: 'Each member may claim at most 1 coupon(s) of this promo',
      },
    ],
    [
      'second coupon allowed when the limit is two',
      promo(),
      template({ perUserLimit: 2 }),
      context({ userClaimCount: 1 }),
      { allowed: true },
    ],
    [
      'sold out wins over the per-user limit',
      promo(),
      template({ totalLimit: 1, claimedCount: 1, perUserLimit: 1 }),
      context({ userClaimCount: 1 }),
      { allowed: false, code: 'PC_COUPON_SOLD_OUT', detail: 'All 1 coupons have been claimed' },
    ],
    [
      'status is checked before the window',
      promo({ status: 'draft', validTo: new Date('2026-01-01T00:00:00.000Z') }),
      template(),
      context(),
      {
        allowed: false,
        code: 'PC_PROMO_NOT_PUBLISHED',
        detail: 'Promo is draft, only published promos can be claimed',
      },
    ],
  ];

  it.each(table)('%s', (_name, promoInput, templateInput, ctx, expected) => {
    expect(decideClaim(promoInput, templateInput, ctx)).toEqual(expected);
  });
});

describe('promo window helpers', () => {
  it('classifies the validity window inclusively', () => {
    const item = promo();
    expect(promoWindowState(item, new Date('2026-10-24T23:59:59.999Z'))).toBe('upcoming');
    expect(promoWindowState(item, item.validFrom)).toBe('active');
    expect(promoWindowState(item, item.validTo)).toBe('active');
    expect(promoWindowState(item, new Date('2026-11-15T21:59:00.001Z'))).toBe('ended');
  });

  it('isPromoActiveAt requires published status and an active window', () => {
    expect(isPromoActiveAt(promo(), now)).toBe(true);
    expect(isPromoActiveAt(promo({ status: 'draft' }), now)).toBe(false);
    expect(isPromoActiveAt(promo({ status: 'archived' }), now)).toBe(false);
    expect(isPromoActiveAt(promo({ validFrom: new Date('2027-01-01T00:00:00Z') }), now)).toBe(
      false,
    );
  });

  it('validates the window and the limits', () => {
    expect(isValidPromoWindow(new Date('2026-01-01'), new Date('2026-01-02'))).toBe(true);
    expect(isValidPromoWindow(new Date('2026-01-02'), new Date('2026-01-01'))).toBe(false);
    expect(isValidPromoWindow(new Date('2026-01-01'), new Date('2026-01-01'))).toBe(false);
    expect(isValidPromoWindow(new Date('garbage'), new Date('2026-01-01'))).toBe(false);

    expect(
      isValidCouponLimits({ perUserLimit: 1, totalLimit: null, validityHoursAfterClaim: null }),
    ).toBe(true);
    expect(
      isValidCouponLimits({ perUserLimit: 2, totalLimit: 500, validityHoursAfterClaim: 72 }),
    ).toBe(true);
    expect(
      isValidCouponLimits({ perUserLimit: 0, totalLimit: null, validityHoursAfterClaim: null }),
    ).toBe(false);
    expect(
      isValidCouponLimits({ perUserLimit: 1, totalLimit: 0, validityHoursAfterClaim: null }),
    ).toBe(false);
    expect(
      isValidCouponLimits({ perUserLimit: 1, totalLimit: null, validityHoursAfterClaim: 0 }),
    ).toBe(false);
    expect(
      isValidCouponLimits({ perUserLimit: 1.5, totalLimit: null, validityHoursAfterClaim: null }),
    ).toBe(false);
  });

  it('computes remaining coupons with a floor of zero', () => {
    expect(remainingCoupons({ totalLimit: null, claimedCount: 7 })).toBeNull();
    expect(remainingCoupons({ totalLimit: 10, claimedCount: 3 })).toBe(7);
    expect(remainingCoupons({ totalLimit: 10, claimedCount: 12 })).toBe(0);
  });
});

describe('couponExpiresAt', () => {
  const item = promo({ validTo: new Date('2026-11-15T21:59:00.000Z') });

  it('adds the validity hours to the claim time', () => {
    expect(couponExpiresAt(item, { validityHoursAfterClaim: 72 }, now)).toEqual(
      new Date('2026-11-04T12:00:00.000Z'),
    );
  });

  it('never outlives the promo window', () => {
    const lateClaim = new Date('2026-11-15T20:00:00.000Z');
    expect(couponExpiresAt(item, { validityHoursAfterClaim: 72 }, lateClaim)).toEqual(item.validTo);
  });

  it('uses validTo when the template has no validity hours', () => {
    expect(couponExpiresAt(item, { validityHoursAfterClaim: null }, now)).toEqual(item.validTo);
  });
});
