import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length, Matches, MaxLength, ValidateIf } from 'class-validator';
import { VOUCHER_KINDS, type VoucherKind } from '../../../common/contracts/rewards';
import { REDEEM_OUTCOMES, type RedeemOutcome } from '../domain/redeem-rules';
import { SHIFT_PIN_PATTERN } from '../domain/validator-pin';
import { trimmed } from './transforms';
import { VoucherDto } from './voucher.dto';

/** PIN accepted when opening a shift; devices registered before the 6-digit rule may have 4. */
export const PIN_PATTERN = SHIFT_PIN_PATTERN;

export class OpenShiftDto {
  @ApiProperty({
    example: '482915',
    description: '4-12 digits (new and changed PINs have at least 6)',
  })
  @Transform(trimmed)
  @IsString()
  @Matches(PIN_PATTERN, { message: 'pin must be 4 to 12 digits' })
  pin: string;
}

export class ValidatorDeviceSelfDto {
  @ApiProperty({ format: 'uuid' })
  deviceId: string;

  @ApiProperty({ example: 'Aroma Kava, каса 1' })
  name: string;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Null for mall-operated devices',
  })
  tenantId: string | null;

  @ApiProperty({
    enum: ['key', 'shift'],
    description: 'key: device key only (opening a shift); shift: key + shift token',
  })
  authMethod: 'key' | 'shift';

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  shiftExpiresAt: Date | null;
}

export class OpenShiftResponseDto {
  @ApiProperty({ description: 'Send as X-Validator-Shift on every following request' })
  shiftToken: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  @ApiProperty({ type: ValidatorDeviceSelfDto })
  device: ValidatorDeviceSelfDto;
}

export class ValidatorRedeemDto {
  @ApiPropertyOptional({
    example: 'K7M2PQ',
    description: 'Code typed by the cashier (case and dashes ignored)',
  })
  @ValidateIf((dto: ValidatorRedeemDto) => dto.token === undefined)
  @Transform(trimmed)
  @IsString()
  @Length(6, 16)
  code?: string;

  @ApiPropertyOptional({
    description:
      'Token scanned from the member QR: the activation token, or the static PCV1:... QR of a ticket or certificate',
  })
  @ValidateIf((dto: ValidatorRedeemDto) => dto.code === undefined)
  @Transform(trimmed)
  @IsString()
  @Length(16, 512)
  token?: string;
}

export class ValidatorRedeemResponseDto {
  @ApiProperty({ enum: ['redeemed'] })
  outcome: 'redeemed';

  @ApiProperty({ type: String, format: 'date-time' })
  redeemedAt: Date;

  @ApiProperty({ type: VoucherDto })
  voucher: VoucherDto;

  @ApiProperty({ type: ValidatorDeviceSelfDto })
  device: ValidatorDeviceSelfDto;
}

export class ValidatorLogVoucherDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VOUCHER_KINDS })
  kind: VoucherKind;
}

export class ValidatorLogEntryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  voucherId: string | null;

  @ApiProperty({ type: ValidatorLogVoucherDto, nullable: true })
  voucher: ValidatorLogVoucherDto | null;

  @ApiProperty({ enum: ['code', 'token'] })
  method: 'code' | 'token';

  @ApiProperty({ type: String, nullable: true })
  codeTried: string | null;

  @ApiProperty({ enum: REDEEM_OUTCOMES })
  outcome: RedeemOutcome;

  @ApiProperty({ type: String, nullable: true })
  message: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class ValidatorLogPageDto {
  @ApiProperty({ type: [ValidatorLogEntryDto] })
  items: ValidatorLogEntryDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

/** Shared by the member and admin cancel endpoints' free-text reason. */
export class ReasonDto {
  @ApiProperty({ maxLength: 300 })
  @Transform(trimmed)
  @IsString()
  @Length(1, 300)
  @MaxLength(300)
  reason: string;
}
