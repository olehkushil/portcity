import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsISO8601, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';

export class CreateTenantRuleDto {
  @ApiProperty({ minimum: 0, maximum: 100, example: 5, description: 'Points per 100 UAH' })
  @IsInt()
  @Min(0)
  @Max(100)
  ratePercent: number;

  @ApiPropertyOptional({
    default: 0,
    minimum: 0,
    description: 'Receipts below this total earn nothing',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  minTotalKopecks?: number;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 1,
    description: 'Max points per member per Kyiv day',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  dailyCapPoints?: number | null;

  @ApiProperty({ type: String, format: 'date-time', example: '2026-11-01T00:00:00.000Z' })
  @IsISO8601({ strict: true })
  validFrom: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Exclusive end; null or omitted means open-ended',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  validTo?: string | null;
}

/** Every field optional; the tenant of a rule cannot change (delete and recreate instead). */
export class UpdateTenantRuleDto extends PartialType(CreateTenantRuleDto) {}

/** POST /admin/tenant-rules. */
export class AdminCreateTenantRuleDto extends CreateTenantRuleDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  tenantId: string;
}

export class ListTenantRulesQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Only rules whose period [validFrom, validTo) contains this instant',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  activeAt?: string;
}

export class EffectiveRuleQueryDto {
  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'Defaults to now' })
  @IsOptional()
  @IsISO8601({ strict: true })
  at?: string;
}

export class TenantRuleDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({ example: 5 })
  ratePercent: number;

  @ApiProperty({ example: 0 })
  minTotalKopecks: number;

  @ApiProperty({ nullable: true, type: Number })
  dailyCapPoints: number | null;

  @ApiProperty({ type: String, format: 'date-time' })
  validFrom: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  validTo: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class TenantRulePageDto {
  @ApiProperty({ type: [TenantRuleDto] })
  items: TenantRuleDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor: string | null;
}

export class EffectiveTenantRuleDto {
  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Null means baseRatePercent of the active rule set applies',
  })
  ratePercent: number | null;

  @ApiProperty()
  minTotalKopecks: number;

  @ApiProperty({ nullable: true, type: Number })
  dailyCapPoints: number | null;

  @ApiProperty({ enum: ['rule', 'override', 'none'] })
  source: 'rule' | 'override' | 'none';

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Instant the rule was resolved for',
  })
  at: Date;
}
