import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  PROMO_CATEGORIES,
  PROMO_KINDS,
  type PromoCategory,
  type PromoKind,
} from '../../../common/contracts/promos';

export class CreateCouponTemplateDto {
  @ApiProperty({ example: '-20 % на весь асортимент', maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  discountText: string;

  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  perUserLimit?: number;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    description: 'null = unlimited',
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1)
  totalLimit?: number | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  requiresActivation?: boolean;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 8760,
    description: 'Hours a coupon lives after the claim; null = until the promo ends',
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(8760)
  validityHoursAfterClaim?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(2000)
  terms?: string | null;
}

export class UpdateCouponTemplateDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  discountText?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  perUserLimit?: number;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1)
  totalLimit?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresActivation?: boolean;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1, maximum: 8760 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(8760)
  validityHoursAfterClaim?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(2000)
  terms?: string | null;
}

export class CreatePromoDto {
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('all')
  tenantId?: string | null;

  @ApiProperty({ example: '-20 % INTERTOP до 15.11', maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  @ApiProperty({ maxLength: 10000 })
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body: string;

  @ApiPropertyOptional({ enum: PROMO_KINDS, default: 'info' })
  @IsOptional()
  @IsIn(PROMO_KINDS)
  kind?: PromoKind;

  @ApiPropertyOptional({ enum: PROMO_CATEGORIES, default: 'other' })
  @IsOptional()
  @IsIn(PROMO_CATEGORIES)
  category?: PromoCategory;

  @ApiProperty({ type: String, format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  validFrom: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  validTo: Date;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(500)
  imageKey?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Existing coupon template (kind = coupon); mutually exclusive with couponTemplate',
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('all')
  couponTemplateId?: string | null;

  @ApiPropertyOptional({
    type: CreateCouponTemplateDto,
    description: 'Creates the coupon template together with the promo (kind = coupon)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateCouponTemplateDto)
  couponTemplate?: CreateCouponTemplateDto;

  @ApiPropertyOptional({ default: 0, minimum: -1000, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(-1000)
  @Max(1000)
  priority?: number;
}

export class UpdatePromoDto {
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('all')
  tenantId?: string | null;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ maxLength: 10000 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body?: string;

  @ApiPropertyOptional({ enum: PROMO_KINDS })
  @IsOptional()
  @IsIn(PROMO_KINDS)
  kind?: PromoKind;

  @ApiPropertyOptional({ enum: PROMO_CATEGORIES })
  @IsOptional()
  @IsIn(PROMO_CATEGORIES)
  category?: PromoCategory;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  validFrom?: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  validTo?: Date;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(500)
  imageKey?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('all')
  couponTemplateId?: string | null;

  @ApiPropertyOptional({ minimum: -1000, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(-1000)
  @Max(1000)
  priority?: number;
}

/** Optional reason recorded in the audit log for publish/archive/delete. */
export class AdminReasonDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Mandatory reason (cancellations). */
export class AdminRequiredReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
