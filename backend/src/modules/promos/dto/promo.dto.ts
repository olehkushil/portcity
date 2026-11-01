import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  GUEST_CLAIM_CODE,
  type GuestClaimCode,
  PROMO_CATEGORIES,
  PROMO_KINDS,
  PROMO_STATUSES,
  type PromoCategory,
  type PromoKind,
  type PromoStatus,
  type PromosErrorCode,
} from '../../../common/contracts/promos';
import {
  VOUCHER_KINDS,
  VOUCHER_SOURCE_TYPES,
  VOUCHER_STATUSES,
  type VoucherKind,
  type VoucherSourceType,
  type VoucherStatus,
} from '../../../common/contracts/rewards';

/** Tenant facts shown on a promo card (read through CONTENT_PORT). */
export class PromoTenantDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  slug: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: String, nullable: true })
  logoKey: string | null;

  @ApiProperty({ type: Number, nullable: true })
  floor: number | null;
}

export class CouponTemplateDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: '-20 % на весь асортимент' })
  discountText: string;

  @ApiProperty({ description: 'Coupons one member may claim for the promo', example: 1 })
  perUserLimit: number;

  @ApiProperty({ type: Number, nullable: true, description: 'Pool size; null means unlimited' })
  totalLimit: number | null;

  @ApiProperty({ description: 'Coupons claimed so far' })
  claimedCount: number;

  @ApiProperty({ type: Number, nullable: true, description: 'totalLimit - claimedCount or null' })
  remaining: number | null;

  @ApiProperty({ description: 'The coupon must be activated at the counter (2-minute code)' })
  requiresActivation: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Coupon lifetime after claim in hours; null means until the promo ends',
  })
  validityHoursAfterClaim: number | null;

  @ApiProperty({ type: String, nullable: true })
  terms: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class PromoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  tenantId: string | null;

  @ApiProperty({ type: PromoTenantDto, nullable: true })
  tenant: PromoTenantDto | null;

  @ApiProperty({ example: '-20 % INTERTOP до 15.11' })
  title: string;

  @ApiProperty()
  body: string;

  @ApiProperty({ enum: PROMO_KINDS })
  kind: PromoKind;

  @ApiProperty({ enum: PROMO_CATEGORIES, description: 'Filter chip of the promo list' })
  category: PromoCategory;

  @ApiProperty({ type: String, format: 'date-time' })
  validFrom: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  validTo: Date;

  @ApiProperty({ type: String, nullable: true, description: 'Storage key of the banner' })
  imageKey: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Public banner URL (S3_PUBLIC_BASE_URL + imageKey); null without image or base URL',
  })
  imageUrl: string | null;

  @ApiProperty({ enum: PROMO_STATUSES })
  status: PromoStatus;

  @ApiProperty({ description: 'Higher priority is listed first' })
  priority: number;

  @ApiProperty({ enum: ['upcoming', 'active', 'ended'] })
  window: 'upcoming' | 'active' | 'ended';

  @ApiProperty({ type: CouponTemplateDto, nullable: true })
  couponTemplate: CouponTemplateDto | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

/** Whether the caller may claim the promo right now (guests: PC_AUTH_REQUIRED). */
export class ClaimStateDto {
  @ApiProperty()
  allowed: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: `PC_* code when not allowed; ${GUEST_CLAIM_CODE} for guests (no token)`,
  })
  code: PromosErrorCode | GuestClaimCode | null;

  @ApiProperty({ type: String, nullable: true })
  detail: string | null;

  @ApiProperty({ description: 'Live coupons of this promo held by the member' })
  claimedByMe: number;
}

export class PromoDetailDto extends PromoDto {
  @ApiProperty({ type: ClaimStateDto })
  claim: ClaimStateDto;
}

export class PromoPageDto {
  @ApiProperty({ type: [PromoDto] })
  items: PromoDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

export class CouponTemplatePageDto {
  @ApiProperty({ type: [CouponTemplateDto] })
  items: CouponTemplateDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

/** Subset of the rewards VoucherSummary returned by claim and registration endpoints. */
export class PromoVoucherDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: VOUCHER_KINDS })
  kind: VoucherKind;

  @ApiProperty()
  title: string;

  @ApiProperty({ type: String, nullable: true })
  subtitle: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  tenantId: string | null;

  @ApiProperty({ enum: VOUCHER_STATUSES })
  status: VoucherStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt: Date | null;

  @ApiProperty({ enum: VOUCHER_SOURCE_TYPES })
  sourceType: VoucherSourceType;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  sourceId: string | null;

  @ApiProperty({ type: Object })
  meta: Record<string, unknown>;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class ClaimResultDto {
  @ApiProperty({ format: 'uuid' })
  promoId: string;

  @ApiProperty({ format: 'uuid' })
  couponTemplateId: string;

  @ApiProperty({ type: PromoVoucherDto, description: 'The coupon voucher (kind = coupon)' })
  voucher: PromoVoucherDto;

  @ApiProperty({ description: 'Live coupons of this promo held by the member after the claim' })
  claimedByMe: number;

  @ApiProperty({ description: 'Claims the member may still make for this promo' })
  remainingForMe: number;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Pool remaining or null' })
  remainingInPool: number | null;
}
