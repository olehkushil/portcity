import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  FISCAL_NUMBER_SOURCES,
  FISCAL_NUMBER_STATUSES,
  TENANT_CATEGORIES,
  TENANT_STATUSES,
  type FiscalNumberSource,
  type FiscalNumberStatus,
  type TenantStatus,
} from '../../../common/contracts/content';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import { transformBooleanQuery, transformTrim, transformTrimToNull } from './transforms';

export class ListFiscalNumbersQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: FISCAL_NUMBER_STATUSES })
  @IsOptional()
  @IsIn(FISCAL_NUMBER_STATUSES)
  status?: FiscalNumberStatus;

  @ApiPropertyOptional({ enum: FISCAL_NUMBER_SOURCES })
  @IsOptional()
  @IsIn(FISCAL_NUMBER_SOURCES)
  source?: FiscalNumberSource;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Only numbers without a tenant (overrides tenantId)',
  })
  @IsOptional()
  @Transform(transformBooleanQuery)
  @IsBoolean()
  unmapped?: boolean;

  @ApiPropertyOptional({ description: 'Prefix of the fiscal number (digits)', maxLength: 40 })
  @IsOptional()
  @Transform(transformTrim)
  @IsString()
  @MaxLength(40)
  q?: string;
}

export class CreateFiscalNumberDto {
  @ApiProperty({ example: '4000100011', description: '6-20 digits; inner spaces are ignored' })
  @IsString()
  @MinLength(6)
  @MaxLength(40)
  fn: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  tenantId?: string | null;

  @ApiPropertyOptional({
    enum: FISCAL_NUMBER_STATUSES,
    description: 'Defaults to active when tenantId is given, otherwise pending',
  })
  @IsOptional()
  @IsIn(FISCAL_NUMBER_STATUSES)
  status?: FiscalNumberStatus;

  @ApiPropertyOptional({ nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export class UpdateFiscalNumberDto {
  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'New mapping; null unmaps (not allowed while active)',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string | null;

  @ApiPropertyOptional({
    enum: FISCAL_NUMBER_STATUSES,
    description: 'Target status; transitions follow the state machine',
  })
  @IsOptional()
  @IsIn(FISCAL_NUMBER_STATUSES)
  status?: FiscalNumberStatus;

  @ApiPropertyOptional({ nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export class ConfirmFiscalNumberDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Required when the number is not mapped yet',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export class BlockFiscalNumberDto {
  @ApiPropertyOptional({
    nullable: true,
    maxLength: 1000,
    description: 'Why the number is blocked',
  })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

/** TenantSummary of the contract, as embedded in fiscal number responses. */
export class TenantRefDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aroma-kava' })
  slug: string;

  @ApiProperty({ example: 'Aroma Kava' })
  name: string;

  @ApiProperty({ enum: TENANT_CATEGORIES })
  category: string;

  @ApiProperty({ nullable: true, type: Number })
  floor: number | null;

  @ApiProperty({ nullable: true, type: String })
  logoKey: string | null;

  @ApiProperty()
  participates: boolean;

  @ApiProperty({ nullable: true, type: Number })
  ratePercentOverride: number | null;

  @ApiProperty()
  excludedFromProgram: boolean;

  @ApiProperty({ enum: TENANT_STATUSES })
  status: TenantStatus;
}

export class FiscalNumberDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: '4000100011' })
  fn: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  tenantId: string | null;

  @ApiProperty({ type: TenantRefDto, nullable: true })
  tenant: TenantRefDto | null;

  @ApiProperty({ enum: FISCAL_NUMBER_STATUSES })
  status: FiscalNumberStatus;

  @ApiProperty({ enum: FISCAL_NUMBER_SOURCES })
  source: FiscalNumberSource;

  @ApiProperty({ type: String, format: 'date-time' })
  firstSeenAt: Date;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  confirmedById: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  confirmedAt: Date | null;

  @ApiProperty({ nullable: true, type: String })
  note: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class FiscalNumberPageDto {
  @ApiProperty({ type: [FiscalNumberDto] })
  items: FiscalNumberDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor: string | null;
}
