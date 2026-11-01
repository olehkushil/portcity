import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  TENANT_CATEGORIES,
  TENANT_STATUSES,
  type TenantCategory,
  type TenantStatus,
} from '../../../common/contracts/content';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '../domain/slug';
import { TENANT_RATE_SOURCES, type TenantRateSource } from '../domain/tenant-earning';
import {
  OBJECT_KEY_PATTERN,
  transformBooleanQuery,
  transformTrim,
  transformTrimToNull,
} from './transforms';

export const TENANT_FLOOR_MIN = -3;
export const TENANT_FLOOR_MAX = 30;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export class ListTenantsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Only tenants that participate (true) or do not participate (false) in the program',
  })
  @IsOptional()
  @Transform(transformBooleanQuery)
  @IsBoolean()
  participates?: boolean;

  @ApiPropertyOptional({ enum: TENANT_CATEGORIES })
  @IsOptional()
  @IsIn(TENANT_CATEGORIES)
  category?: TenantCategory;

  @ApiPropertyOptional({ minimum: TENANT_FLOOR_MIN, maximum: TENANT_FLOOR_MAX })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(TENANT_FLOOR_MIN)
  @Max(TENANT_FLOOR_MAX)
  floor?: number;

  @ApiPropertyOptional({ description: 'Search in name and slug, case-insensitive', maxLength: 100 })
  @IsOptional()
  @Transform(transformTrim)
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class AdminListTenantsQueryDto extends ListTenantsQueryDto {
  @ApiPropertyOptional({ enum: TENANT_STATUSES, description: 'Defaults to every status' })
  @IsOptional()
  @IsIn(TENANT_STATUSES)
  status?: TenantStatus;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export class CreateTenantDto {
  @ApiPropertyOptional({
    example: 'aroma-kava',
    description: 'Derived from the name when omitted',
    pattern: SLUG_PATTERN.source,
    maxLength: SLUG_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @Matches(SLUG_PATTERN)
  @MaxLength(SLUG_MAX_LENGTH)
  slug?: string;

  @ApiProperty({ example: 'Aroma Kava', maxLength: 200 })
  @Transform(transformTrim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiProperty({ enum: TENANT_CATEGORIES, example: 'coffee' })
  @IsIn(TENANT_CATEGORIES)
  category: TenantCategory;

  @ApiPropertyOptional({ nullable: true, minimum: TENANT_FLOOR_MIN, maximum: TENANT_FLOOR_MAX })
  @IsOptional()
  @IsInt()
  @Min(TENANT_FLOOR_MIN)
  @Max(TENANT_FLOOR_MAX)
  floor?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Storage key of the logo (uploaded separately)',
    example: 'tenants/2026/01/0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11.png',
  })
  @IsOptional()
  @IsString()
  @Matches(OBJECT_KEY_PATTERN)
  logoKey?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://aromakava.ua' })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  website?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '+380 332 000 000', maxLength: 32 })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 4000 })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsString()
  @MaxLength(4000)
  description?: string | null;

  @ApiPropertyOptional({ default: true, description: 'Receipts from this tenant earn points' })
  @IsOptional()
  @IsBoolean()
  participates?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 0,
    maximum: 100,
    description: 'Overrides baseRatePercent of the active rule set',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  ratePercentOverride?: number | null;

  @ApiPropertyOptional({
    default: false,
    description: 'Receipts are rejected with PC_RECEIPT_EXCLUDED_TENANT',
  })
  @IsOptional()
  @IsBoolean()
  excludedFromProgram?: boolean;

  @ApiPropertyOptional({ enum: TENANT_STATUSES, default: 'active' })
  @IsOptional()
  @IsIn(TENANT_STATUSES)
  status?: TenantStatus;

  @ApiPropertyOptional({
    type: () => TenantHoursDto,
    nullable: true,
    description:
      'Weekly opening hours (Kyiv time). A missing day uses the mall hours, [] means closed; exceptions replace single dates. null clears the schedule (mall hours apply).',
  })
  @IsOptional()
  @IsObject()
  hours?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 200,
    example: '1 поверх, біля центрального входу',
  })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsString()
  @MaxLength(200)
  locationText?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.portcity.com.ua/mall/floor-1.png' })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  mapImageUrl?: string | null;
}

/** Every field optional; `null` clears nullable fields; status changes follow the state machine. */
export class UpdateTenantDto extends PartialType(CreateTenantDto) {}

// ---------------------------------------------------------------------------
// Opening hours (documentation shape of Tenant.hours, see domain/tenant-hours.ts)
// ---------------------------------------------------------------------------

export class TenantHoursExceptionDto {
  @ApiProperty({ example: '2026-12-31', description: 'Kyiv calendar date' })
  date: string;

  @ApiPropertyOptional({ description: 'Closed all day' })
  closed?: boolean;

  @ApiPropertyOptional({ type: [String], example: ['10:00-18:00'] })
  ranges?: string[];

  @ApiPropertyOptional({ maxLength: 100 })
  note?: string;
}

export class TenantHoursDto {
  @ApiPropertyOptional({ type: [String], example: ['10:00-22:00'] })
  mon?: string[];

  @ApiPropertyOptional({ type: [String], example: ['10:00-22:00'] })
  tue?: string[];

  @ApiPropertyOptional({ type: [String], example: ['10:00-22:00'] })
  wed?: string[];

  @ApiPropertyOptional({ type: [String], example: ['10:00-22:00'] })
  thu?: string[];

  @ApiPropertyOptional({ type: [String], example: ['10:00-23:00'] })
  fri?: string[];

  @ApiPropertyOptional({ type: [String], example: ['10:00-23:00'] })
  sat?: string[];

  @ApiPropertyOptional({ type: [String], example: [], description: '[] = closed' })
  sun?: string[];

  @ApiPropertyOptional({ type: [TenantHoursExceptionDto] })
  exceptions?: TenantHoursExceptionDto[];
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export class TenantPublicDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aroma-kava' })
  slug: string;

  @ApiProperty({ example: 'Aroma Kava' })
  name: string;

  @ApiProperty({ enum: TENANT_CATEGORIES, example: 'coffee' })
  category: string;

  @ApiProperty({ nullable: true, type: Number, example: 1 })
  floor: number | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Public URL of the logo when configured',
  })
  logoUrl: string | null;

  @ApiProperty({ nullable: true, type: String })
  website: string | null;

  @ApiProperty({ nullable: true, type: String })
  phone: string | null;

  @ApiProperty({ nullable: true, type: String })
  description: string | null;

  @ApiProperty({ description: 'Receipts from this tenant earn points' })
  participates: boolean;

  @ApiProperty({
    nullable: true,
    type: TenantHoursDto,
    description: 'Own weekly hours; null means the mall hours apply',
  })
  hours: TenantHoursDto | null;

  @ApiProperty({
    description: 'Open at server time (Kyiv wall clock; the mall hours when the tenant has none)',
  })
  isOpenNow: boolean;

  @ApiProperty({ nullable: true, type: String, example: '1 поверх, біля центрального входу' })
  locationText: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'Map image showing the tenant' })
  mapImageUrl: string | null;
}

/** Directory entry: public card plus the "нараховує бали" badge and the effective rate. */
export class TenantListItemDto extends TenantPublicDto {
  @ApiProperty({
    description:
      'Receipts from this tenant earn points right now (participates, not excluded, rate above 0)',
  })
  earnsPoints: boolean;

  @ApiProperty({
    example: 3,
    description:
      'Percent of the receipt total credited as points (points per 100 UAH); 0 when earnsPoints is false',
  })
  effectiveRatePercent: number;

  @ApiProperty({
    enum: TENANT_RATE_SOURCES,
    description:
      'rule = active tenant rule, override = tenant override, base = rule set default, none = not in the program',
  })
  rateSource: TenantRateSource;
}

/** GET /tenants/:slug. */
export class TenantDetailsDto extends TenantListItemDto {
  @ApiProperty({
    example: 0,
    description: 'Receipts below this total earn nothing (0 = no minimum)',
  })
  minTotalKopecks: number;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Max points per member per Kyiv day from this tenant; null = no tenant cap',
  })
  dailyCapPoints: number | null;
}

export class TenantPageDto {
  @ApiProperty({ type: [TenantListItemDto] })
  items: TenantListItemDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor: string | null;
}

export class TenantCategoryCountDto {
  @ApiProperty({ enum: TENANT_CATEGORIES, example: 'coffee' })
  category: string;

  @ApiProperty({ example: 2 })
  count: number;
}

export class TenantAdminDto extends TenantPublicDto {
  @ApiProperty({ nullable: true, type: String })
  logoKey: string | null;

  @ApiProperty({ nullable: true, type: Number })
  ratePercentOverride: number | null;

  @ApiProperty()
  excludedFromProgram: boolean;

  @ApiProperty({ enum: TENANT_STATUSES })
  status: TenantStatus;

  @ApiProperty({ description: 'Fiscal numbers mapped to the tenant (any status)' })
  fiscalNumbersCount: number;

  @ApiProperty({ description: 'Loyalty rules of the tenant (any period)' })
  loyaltyRulesCount: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class TenantAdminPageDto {
  @ApiProperty({ type: [TenantAdminDto] })
  items: TenantAdminDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor: string | null;
}
