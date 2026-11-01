import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RECEIPT_STATUSES, type ReceiptStatus } from '../../../common/contracts/receipts';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import { FISCAL_ID_INPUT_PATTERN, FN_INPUT_PATTERN } from '../domain/fiscal-ids';
import { MAX_QR_TEXT_LENGTH, MAX_TOTAL_KOPECKS } from '../domain/qr-parser';
import { MODERATION_REASONS, type ModerationReason } from '../domain/rules';
import { RECEIPT_PHOTO_CONTENT_TYPES, type ReceiptPhotoContentType } from '../receipts.config';

const PHOTO_KEY_PATTERN = /^receipts\/[A-Za-z0-9/_.-]+$/;

export class SubmitQrDto {
  @ApiProperty({
    description: 'Decoded text of the receipt QR (tax-service URL)',
    example:
      'https://cabinet.tax.gov.ua/cashregs/check?fn=4000100011&id=1180000001&date=20260115&time=143000&sm=1234.56',
    maxLength: MAX_QR_TEXT_LENGTH,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(MAX_QR_TEXT_LENGTH)
  qrText: string;
}

export class SubmitManualDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Shop the member picked on the form; omit or null for "Не знаю". With a tenant the cash register number (fn) may be left out: the moderator fills it in.',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string | null;

  @ApiPropertyOptional({
    description:
      'Fiscal number of the cash register (ФН, 6-20 digits; spaces and dashes are ignored, leading zeros dropped). Required when tenantId is not given.',
    example: '4000100011',
  })
  @IsOptional()
  @IsString()
  @Matches(FN_INPUT_PATTERN, { message: 'fn must be 6-20 digits' })
  fn?: string;

  @ApiProperty({
    description:
      'Fiscal number of the receipt (ФН чека). Spaces, dashes, letter case and leading zeros of numeric ids do not matter.',
    example: '1180000001',
  })
  @IsString()
  @Matches(FISCAL_ID_INPUT_PATTERN, {
    message: 'fiscalId must be 1-64 letters, digits, spaces or dashes',
  })
  fiscalId: string;

  @ApiProperty({
    description:
      'Date and time printed on the receipt, ISO 8601. Without a zone designator it is read as Kyiv local time.',
    example: '2026-01-15T14:30:00+02:00',
  })
  @IsISO8601({ strict: true })
  issuedAt: string;

  @ApiProperty({ description: 'Receipt total in kopecks', example: 123456, minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(MAX_TOTAL_KOPECKS)
  totalKopecks: number;

  @ApiProperty({
    description: 'Object key returned by POST /receipts/photo-upload-url after the PUT succeeded',
    example:
      'receipts/0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11/2026/01/0192f3a1-1111-7222-8333-444455556666.jpg',
  })
  @IsString()
  @MaxLength(512)
  @Matches(PHOTO_KEY_PATTERN, { message: 'photoKey must be a key issued by photo-upload-url' })
  photoKey: string;
}

export class CreatePhotoUploadUrlDto {
  @ApiProperty({ enum: RECEIPT_PHOTO_CONTENT_TYPES, example: 'image/jpeg' })
  @IsIn(RECEIPT_PHOTO_CONTENT_TYPES)
  contentType: ReceiptPhotoContentType;

  @ApiProperty({
    description: 'Exact size of the file the client will PUT',
    example: 245_000,
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  @Max(50_000_000)
  sizeBytes: number;
}

export class CreateAppealDto {
  @ApiProperty({
    description: 'Why the member disagrees with the rejection',
    minLength: 3,
    maxLength: 1000,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  message: string;

  @ApiPropertyOptional({ description: 'Optional extra photo (key from photo-upload-url)' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(PHOTO_KEY_PATTERN, { message: 'photoKey must be a key issued by photo-upload-url' })
  photoKey?: string;
}

export class ListReceiptsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: RECEIPT_STATUSES })
  @IsOptional()
  @IsIn(RECEIPT_STATUSES)
  status?: ReceiptStatus;

  @ApiPropertyOptional({ format: 'date-time', description: 'submittedAt >= from' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'submittedAt < to' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}

export const ADMIN_LIST_ORDERS = ['asc', 'desc'] as const;
export type AdminListOrder = (typeof ADMIN_LIST_ORDERS)[number];

export class AdminListReceiptsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({
    enum: RECEIPT_STATUSES,
    description: 'Filter by status (moderation queue: needs_moderation, appealed)',
  })
  @IsOptional()
  @IsIn(RECEIPT_STATUSES)
  status?: ReceiptStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    description: 'Fiscal number of the cash register (canonicalised: leading zeros ignored)',
  })
  @IsOptional()
  @IsString()
  @Matches(FN_INPUT_PATTERN, { message: 'fn must be 6-20 digits' })
  fn?: string;

  @ApiPropertyOptional({
    enum: MODERATION_REASONS,
    description: 'Receipts the rules sent to moderation for this reason',
  })
  @IsOptional()
  @IsIn(MODERATION_REASONS)
  reason?: ModerationReason;

  @ApiPropertyOptional({ format: 'date-time', description: 'submittedAt >= from' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'submittedAt < to' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiPropertyOptional({
    enum: ADMIN_LIST_ORDERS,
    description: 'Sort by submittedAt; defaults to asc for queue statuses and desc otherwise',
  })
  @IsOptional()
  @IsIn(ADMIN_LIST_ORDERS)
  order?: AdminListOrder;
}

export class ApproveReceiptDto {
  @ApiPropertyOptional({ description: 'Optional moderator note', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    description:
      'Cash register number (ФН) read from the photo. Required for a manual receipt submitted without it; ignored when it matches the stored one.',
    example: '4000100011',
  })
  @IsOptional()
  @IsString()
  @Matches(FN_INPUT_PATTERN, { message: 'fn must be 6-20 digits' })
  fn?: string;
}

export class RejectReceiptDto {
  @ApiProperty({ description: 'Reason shown to the member', minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
