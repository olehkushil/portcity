import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import { NEW_PIN_PATTERN } from '../domain/validator-pin';
import { toOptionalBoolean, trimmed } from './transforms';

const NEW_PIN_MESSAGE = 'pin must be 6 to 12 digits';

export class ValidatorDeviceDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Null for mall-operated devices',
  })
  tenantId: string | null;

  @ApiProperty({ example: 'Aroma Kava, каса 1' })
  name: string;

  @ApiProperty()
  active: boolean;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  lastSeenAt: Date | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  revokedAt: Date | null;

  @ApiProperty({ description: 'Wrong PINs in a row since the last successful shift', example: 0 })
  failedPinAttempts: number;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'Opening a shift is locked until then (5 wrong PINs); a new PIN clears it',
  })
  pinLockedUntil: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class ValidatorDeviceWithKeyDto {
  @ApiProperty({ type: ValidatorDeviceDto })
  device: ValidatorDeviceDto;

  @ApiProperty({
    description: 'Raw device key, shown once; the device sends it as X-Validator-Key',
  })
  deviceKey: string;
}

export class ValidatorDevicePageDto {
  @ApiProperty({ type: [ValidatorDeviceDto] })
  items: ValidatorDeviceDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

export class CreateValidatorDeviceDto {
  @ApiProperty({ maxLength: 100, example: 'Aroma Kava, каса 1' })
  @Transform(trimmed)
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Omit or null for a mall device',
  })
  @IsOptional()
  @ValidateIf((dto: CreateValidatorDeviceDto) => dto.tenantId !== null)
  @IsUUID()
  tenantId?: string | null;

  @ApiProperty({ example: '482915', description: 'Shift PIN, 6-12 digits' })
  @Transform(trimmed)
  @IsString()
  @Matches(NEW_PIN_PATTERN, { message: NEW_PIN_MESSAGE })
  pin: string;
}

export class UpdateValidatorDeviceDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 100)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @ValidateIf((dto: UpdateValidatorDeviceDto) => dto.tenantId !== null)
  @IsUUID()
  tenantId?: string | null;

  @ApiPropertyOptional({ description: 'Re-activating clears revokedAt' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class SetValidatorPinDto {
  @ApiProperty({
    example: '730158',
    description: '6-12 digits; closes open shifts and clears a PIN lock',
  })
  @Transform(trimmed)
  @IsString()
  @Matches(NEW_PIN_PATTERN, { message: NEW_PIN_MESSAGE })
  pin: string;
}

export class ValidatorDeviceListQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({ type: Boolean })
  @Transform(toOptionalBoolean)
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class AdminReasonQueryDto {
  @ApiPropertyOptional({ maxLength: 300, description: 'Reason recorded in the audit log' })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 300)
  reason?: string;
}

/** Shared sort direction vocabulary kept for future list extensions. */
export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export class SortQueryDto {
  @ApiPropertyOptional({ enum: SORT_DIRECTIONS })
  @IsOptional()
  @IsIn(SORT_DIRECTIONS)
  direction?: (typeof SORT_DIRECTIONS)[number];
}
