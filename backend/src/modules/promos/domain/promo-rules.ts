import type { PromoKind, PromoStatus, PromosErrorCode } from '../../../common/contracts/promos';

/** The promo fields the claim rules look at (a Prisma Promo row satisfies it). */
export interface PromoRuleInput {
  id: string;
  status: PromoStatus;
  kind: PromoKind;
  validFrom: Date;
  validTo: Date;
  couponTemplateId: string | null;
}

/** The coupon template fields the claim rules look at. */
export interface CouponTemplateRuleInput {
  perUserLimit: number;
  totalLimit: number | null;
  claimedCount: number;
  validityHoursAfterClaim: number | null;
}

export interface ClaimContext {
  now: Date;
  /** Active coupon claims of the member for this promo (cancelled claims excluded). */
  userClaimCount: number;
}

export type ClaimRejectionCode = Extract<
  PromosErrorCode,
  | 'PC_PROMO_NOT_FOUND'
  | 'PC_PROMO_NOT_PUBLISHED'
  | 'PC_PROMO_NOT_COUPON'
  | 'PC_PROMO_EXPIRED'
  | 'PC_COUPON_LIMIT_REACHED'
  | 'PC_COUPON_SOLD_OUT'
>;

export type ClaimDecision =
  { allowed: true } | { allowed: false; code: ClaimRejectionCode; detail: string };

export type PromoWindowState = 'upcoming' | 'active' | 'ended';

/** Where `now` falls relative to the validity window (inclusive on both ends). */
export function promoWindowState(
  promo: Pick<PromoRuleInput, 'validFrom' | 'validTo'>,
  now: Date,
): PromoWindowState {
  if (now.getTime() < promo.validFrom.getTime()) {
    return 'upcoming';
  }
  if (now.getTime() > promo.validTo.getTime()) {
    return 'ended';
  }
  return 'active';
}

/** Published and inside the validity window: what members see in the list. */
export function isPromoActiveAt(
  promo: Pick<PromoRuleInput, 'status' | 'validFrom' | 'validTo'>,
  now: Date,
): boolean {
  return promo.status === 'published' && promoWindowState(promo, now) === 'active';
}

export function isValidPromoWindow(validFrom: Date, validTo: Date): boolean {
  return (
    Number.isFinite(validFrom.getTime()) &&
    Number.isFinite(validTo.getTime()) &&
    validFrom.getTime() < validTo.getTime()
  );
}

/** Coupons still available in the pool; null means unlimited. */
export function remainingCoupons(
  template: Pick<CouponTemplateRuleInput, 'totalLimit' | 'claimedCount'>,
): number | null {
  if (template.totalLimit === null) {
    return null;
  }
  return Math.max(template.totalLimit - template.claimedCount, 0);
}

/**
 * Pure claim check (brief section 8, contract `validateClaim`): status, kind, window, pool and
 * per-member limits, in that order. No side effects.
 */
export function decideClaim(
  promo: PromoRuleInput | null,
  template: CouponTemplateRuleInput | null,
  context: ClaimContext,
): ClaimDecision {
  if (!promo) {
    return { allowed: false, code: 'PC_PROMO_NOT_FOUND', detail: 'Promo does not exist' };
  }
  if (promo.status !== 'published') {
    return {
      allowed: false,
      code: 'PC_PROMO_NOT_PUBLISHED',
      detail: `Promo is ${promo.status}, only published promos can be claimed`,
    };
  }
  if (promo.kind !== 'coupon' || !promo.couponTemplateId || !template) {
    return {
      allowed: false,
      code: 'PC_PROMO_NOT_COUPON',
      detail: 'This promo is informational and does not issue coupons',
    };
  }
  const window = promoWindowState(promo, context.now);
  if (window === 'upcoming') {
    return {
      allowed: false,
      code: 'PC_PROMO_EXPIRED',
      detail: `Promo starts at ${promo.validFrom.toISOString()}`,
    };
  }
  if (window === 'ended') {
    return {
      allowed: false,
      code: 'PC_PROMO_EXPIRED',
      detail: `Promo ended at ${promo.validTo.toISOString()}`,
    };
  }
  const remaining = remainingCoupons(template);
  if (remaining !== null && remaining <= 0) {
    return {
      allowed: false,
      code: 'PC_COUPON_SOLD_OUT',
      detail: `All ${template.totalLimit ?? 0} coupons have been claimed`,
    };
  }
  if (context.userClaimCount >= template.perUserLimit) {
    return {
      allowed: false,
      code: 'PC_COUPON_LIMIT_REACHED',
      detail: `Each member may claim at most ${template.perUserLimit} coupon(s) of this promo`,
    };
  }
  return { allowed: true };
}

/**
 * Hard expiry of a claimed coupon: `validityHoursAfterClaim` after the claim, never later than
 * the promo's `validTo` (the window is the agreement with the tenant); null hours means validTo.
 */
export function couponExpiresAt(
  promo: Pick<PromoRuleInput, 'validTo'>,
  template: Pick<CouponTemplateRuleInput, 'validityHoursAfterClaim'>,
  claimedAt: Date,
): Date {
  if (template.validityHoursAfterClaim === null) {
    return new Date(promo.validTo.getTime());
  }
  const byHours = claimedAt.getTime() + template.validityHoursAfterClaim * 3_600_000;
  return new Date(Math.min(byHours, promo.validTo.getTime()));
}

export function isValidCouponLimits(input: {
  perUserLimit: number;
  totalLimit: number | null;
  validityHoursAfterClaim: number | null;
}): boolean {
  if (!Number.isInteger(input.perUserLimit) || input.perUserLimit < 1) {
    return false;
  }
  if (input.totalLimit !== null && (!Number.isInteger(input.totalLimit) || input.totalLimit < 1)) {
    return false;
  }
  if (
    input.validityHoursAfterClaim !== null &&
    (!Number.isInteger(input.validityHoursAfterClaim) || input.validityHoursAfterClaim < 1)
  ) {
    return false;
  }
  return true;
}
