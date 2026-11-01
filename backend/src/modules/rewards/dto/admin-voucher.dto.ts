import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  VOUCHER_KINDS,
  VOUCHER_SOURCE_TYPES,
  type VoucherKind,
  type VoucherSourceType,
} from '../../../common/contracts/rewards';
import { toDateOrNull, trimmed } from './transforms';
import { VoucherStatusFilterDto } from './voucher.dto';

export class AdminIssueVoucherDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId: string;

  @ApiProperty({ enum: VOUCHER_KINDS })
  @IsIn(VOUCHER_KINDS)
  kind: VoucherKind;

  @ApiProperty({ maxLength: 200, example: 'Подарункова карта 200 ₴' })
  @Transform(trimmed)
  @IsString()
  @Length(1, 200)
  title: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(300)
  subtitle?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'Null or omitted: no hard expiry',
  })
  @IsOptional()
  @Transform(toDateOrNull)
  @ValidateIf((dto: AdminIssueVoucherDto) => dto.expiresAt !== null)
  @IsDate()
  expiresAt?: Date | null;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>;

  @ApiPropertyOptional({ maxLength: 300, description: 'Why the voucher is issued (audit log)' })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class AdminCancelVoucherDto {
  @ApiProperty({ maxLength: 300 })
  @Transform(trimmed)
  @IsString()
  @Length(1, 300)
  reason: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Return points for redemption vouchers (default true)',
  })
  @IsOptional()
  @IsBoolean()
  refundPoints?: boolean;
}

export class AdminVoucherListQueryDto extends VoucherStatusFilterDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ enum: VOUCHER_KINDS })
  @IsOptional()
  @IsIn(VOUCHER_KINDS)
  kind?: VoucherKind;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({ enum: VOUCHER_SOURCE_TYPES })
  @IsOptional()
  @IsIn(VOUCHER_SOURCE_TYPES)
  sourceType?: VoucherSourceType;
}
