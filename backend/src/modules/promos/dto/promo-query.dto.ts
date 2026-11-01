import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import {
  PROMO_CATEGORIES,
  PROMO_KINDS,
  PROMO_STATUSES,
  type PromoCategory,
  type PromoKind,
  type PromoStatus,
} from '../../../common/contracts/promos';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';

/** `GET /promos`: published promos inside their validity window. */
export class ListPromosQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only promos of this tenant' })
  @IsOptional()
  @IsUUID('all')
  tenantId?: string;

  @ApiPropertyOptional({ enum: PROMO_KINDS })
  @IsOptional()
  @IsIn(PROMO_KINDS)
  kind?: PromoKind;

  @ApiPropertyOptional({ enum: PROMO_CATEGORIES, description: 'Filter chip of the promo list' })
  @IsOptional()
  @IsIn(PROMO_CATEGORIES)
  category?: PromoCategory;
}

/** `GET /admin/promos`: every promo, filterable by status, tenant, kind, category and title. */
export class AdminListPromosQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: PROMO_STATUSES })
  @IsOptional()
  @IsIn(PROMO_STATUSES)
  status?: PromoStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  tenantId?: string;

  @ApiPropertyOptional({ enum: PROMO_KINDS })
  @IsOptional()
  @IsIn(PROMO_KINDS)
  kind?: PromoKind;

  @ApiPropertyOptional({ enum: PROMO_CATEGORIES })
  @IsOptional()
  @IsIn(PROMO_CATEGORIES)
  category?: PromoCategory;

  @ApiPropertyOptional({ description: 'Case-insensitive title search' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

export class AdminListCouponTemplatesQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ description: 'Case-insensitive search in discountText' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
