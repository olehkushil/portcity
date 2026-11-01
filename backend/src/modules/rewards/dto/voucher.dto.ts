import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  VOUCHER_KINDS,
  VOUCHER_SOURCE_TYPES,
  VOUCHER_STATUSES,
  type VoucherKind,
  type VoucherSourceType,
  type VoucherStatus,
} from '../../../common/contracts/rewards';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import type { VoucherView } from '../services/voucher.mapper';
import { toCommaList } from './transforms';

/** Tenant card shown on the voucher (CONTENT_PORT lookup by id). */
export class VoucherTenantDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aroma-kava' })
  slug: string;

  @ApiProperty({ example: 'Aroma Kava' })
  name: string;

  @ApiProperty({ type: Number, nullable: true, example: 1 })
  floor: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Public logo URL; null when the tenant has no logo or no public base URL is set',
  })
  logoUrl: string | null;
}

export class VoucherDto implements VoucherView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty({ enum: VOUCHER_KINDS })
  kind: VoucherKind;

  @ApiProperty({ example: 'Кава з собою' })
  title: string;

  @ApiProperty({ type: String, nullable: true, example: 'Aroma Kava, 1 поверх' })
  subtitle: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  tenantId: string | null;

  @ApiProperty({ type: VoucherTenantDto, nullable: true })
  tenant: VoucherTenantDto | null;

  @ApiProperty({
    enum: VOUCHER_STATUSES,
    description:
      'Effective status: a lapsed activation reads as issued, a passed expiresAt as expired',
  })
  status: VoucherStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'K7M2PQ',
    description: 'Present only while active',
  })
  code: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  activatedAt: Date | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  activationExpiresAt: Date | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  redeemedAt: Date | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  redeemedByTenantId: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'Hard expiry; null means none',
  })
  expiresAt: Date | null;

  @ApiProperty({ enum: VOUCHER_SOURCE_TYPES })
  sourceType: VoucherSourceType;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  sourceId: string | null;

  @ApiProperty({
    type: Object,
    description: 'Free-form data: rewardId, discountText, eventId, persons, ...',
  })
  meta: Record<string, unknown>;

  @ApiProperty({
    example: '48210937',
    description: '8-digit number shown under the QR, stable per voucher (display only)',
  })
  displayNumber: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'PCV1:MDE5MmYz...',
    description:
      'Static offline QR of tickets and certificates while live (signed, bound to the voucher id and expiresAt, single use); null otherwise',
  })
  qrPayload: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Storage key of the image' })
  imageKey: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'S3_PUBLIC_BASE_URL + imageKey; null when either is missing',
  })
  imageUrl: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class VoucherPageDto {
  @ApiProperty({ type: [VoucherDto] })
  items: VoucherDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

/** `?status=issued,active` (comma separated or repeated); any listed status matches. */
export class VoucherStatusFilterDto extends CursorQueryDto {
  @ApiPropertyOptional({
    type: String,
    example: 'issued,active',
    description: `Effective statuses, comma separated: ${VOUCHER_STATUSES.join(', ')}`,
  })
  @IsOptional()
  @Transform(toCommaList)
  @IsArray()
  @ArrayMaxSize(VOUCHER_STATUSES.length)
  @IsIn(VOUCHER_STATUSES, { each: true })
  status?: VoucherStatus[];
}

export class VoucherListQueryDto extends VoucherStatusFilterDto {
  @ApiPropertyOptional({ enum: VOUCHER_KINDS })
  @IsOptional()
  @IsIn(VOUCHER_KINDS)
  kind?: VoucherKind;
}

export class VoucherStatusCountsDto {
  @ApiProperty({ example: 2 })
  issued: number;

  @ApiProperty({ example: 0 })
  active: number;

  @ApiProperty({ example: 5 })
  redeemed: number;

  @ApiProperty({ example: 1 })
  expired: number;

  @ApiProperty({ example: 0 })
  cancelled: number;
}

export class VoucherSummaryDto {
  @ApiProperty({ type: VoucherStatusCountsDto, description: 'Counts per effective status' })
  counts: VoucherStatusCountsDto;

  @ApiProperty({ description: 'issued + active: the "Мої ваучери (N)" badge', example: 2 })
  live: number;

  @ApiProperty({ example: 8 })
  total: number;
}

export class ActivateVoucherResponseDto {
  @ApiProperty({
    example: 'K7M2PQ',
    description: '6 characters from 23456789ABCDEFGHJKLMNPQRSTUVWXYZ',
  })
  code: string;

  @ApiProperty({ description: 'Signed token base64url(voucherId.exp.hmac) for QR display' })
  token: string;

  @ApiProperty({ type: String, format: 'date-time' })
  activatedAt: Date;

  @ApiProperty({ type: String, format: 'date-time', description: 'End of the 120-second window' })
  activationExpiresAt: Date;

  @ApiProperty({ type: String, format: 'date-time', description: 'Server time for the countdown' })
  serverTime: Date;

  @ApiProperty({ type: VoucherDto })
  voucher: VoucherDto;
}

export class CancelVoucherDto {
  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
