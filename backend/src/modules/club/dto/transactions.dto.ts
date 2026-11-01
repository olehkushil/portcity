import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, Matches } from 'class-validator';
import {
  type LedgerEntry,
  POINTS_SOURCE_TYPES,
  POINTS_TX_STATES,
  POINTS_TX_TYPES,
  type PointsSourceType,
  type PointsTxState,
  type PointsTxType,
} from '../../../common/contracts/club';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import type { Page } from '../../../common/pagination/cursor';
import { defaultPointsTitle } from '../domain/display';
import { MONTH_PATTERN, type TransactionsSummaryView } from '../services/club-account.service';
import { isoOrNull } from '../services/mappers';

export class ListPointsTransactionsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: POINTS_TX_TYPES })
  @IsOptional()
  @IsIn(POINTS_TX_TYPES)
  type?: PointsTxType;

  @ApiPropertyOptional({ enum: POINTS_TX_STATES })
  @IsOptional()
  @IsIn(POINTS_TX_STATES)
  state?: PointsTxState;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Only rows created at or after this moment',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Only rows created before this moment (exclusive)',
  })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class TransactionsSummaryQueryDto {
  @ApiPropertyOptional({
    example: '2026-11',
    description: 'Kyiv calendar month YYYY-MM; default the current month',
  })
  @IsOptional()
  @Matches(MONTH_PATTERN, { message: 'month must be YYYY-MM' })
  month?: string;
}

export class PointsCounterpartyDto {
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  tenantId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'INTERTOP' })
  tenantName?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  receiptId?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 600000 })
  receiptTotalKopecks?: number | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  rewardId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Кава з собою' })
  rewardTitle?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  voucherId?: string | null;
}

export class PointsTransactionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: POINTS_TX_TYPES, example: 'earn' })
  type: PointsTxType;

  @ApiProperty({ enum: POINTS_TX_STATES, example: 'available' })
  state: PointsTxState;

  @ApiProperty({
    description: 'Signed points: positive for credits, negative for spend/expire/reverse',
    example: 180,
  })
  amount: number;

  @ApiProperty({ enum: POINTS_SOURCE_TYPES, example: 'receipt' })
  sourceType: PointsSourceType;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  sourceId: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  availableAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Бонус за перший чек' })
  reason: string | null;

  @ApiProperty({
    example: 'Нарахування за чек',
    description:
      'History line written at posting time; rows posted before it existed get a title derived from the type',
  })
  title: string;

  @ApiProperty({ type: String, nullable: true, example: 'INTERTOP, 1 поверх' })
  subtitle: string | null;

  @ApiProperty({ type: PointsCounterpartyDto, nullable: true })
  counterparty: PointsCounterpartyDto | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
}

export class PointsTransactionsSummaryDto {
  @ApiProperty({ example: '2026-11' })
  month: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'Start of the Kyiv month (UTC)' })
  from: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'Start of the next month (UTC)' })
  to: string;

  @ApiProperty({
    description: 'Credits that reached the balance (receipts, bonuses)',
    example: 230,
  })
  earned: number;

  @ApiProperty({ description: 'Points exchanged or deducted', example: 60 })
  spent: number;

  @ApiProperty({ example: 0 })
  expired: number;

  @ApiProperty({ description: 'Points returned after cancelled vouchers', example: 0 })
  refunded: number;

  @ApiProperty({ description: 'Credits taken back (cancelled receipts)', example: 0 })
  reversed: number;
}

export class PointsTransactionPageDto {
  @ApiProperty({ type: [PointsTransactionDto] })
  items: PointsTransactionDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

/** Back-office view of a ledger row: adds the idempotency key and the admin behind it. */
export class AdminPointsTransactionDto extends PointsTransactionDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'receipt:0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11',
  })
  idempotencyKey: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById: string | null;
}

export class AdminPointsTransactionPageDto {
  @ApiProperty({ type: [AdminPointsTransactionDto] })
  items: AdminPointsTransactionDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

/** Title stored at posting time, or the generic one for rows posted before titles existed. */
export function displayTitleOf(entry: LedgerEntry): string {
  if (entry.title) {
    return entry.title;
  }
  if (entry.type === 'welcome' && entry.reason) {
    return entry.reason;
  }
  return defaultPointsTitle(entry.type, entry.sourceType, entry.amount);
}

export function toTransactionDto(entry: LedgerEntry): PointsTransactionDto {
  return {
    id: entry.id,
    type: entry.type,
    state: entry.state,
    amount: entry.amount,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    availableAt: isoOrNull(entry.availableAt),
    expiresAt: isoOrNull(entry.expiresAt),
    reason: entry.reason,
    title: displayTitleOf(entry),
    subtitle: entry.subtitle ?? null,
    counterparty: entry.counterparty ? { ...entry.counterparty } : null,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function toTransactionsSummaryDto(
  view: TransactionsSummaryView,
): PointsTransactionsSummaryDto {
  return {
    month: view.month,
    from: view.from.toISOString(),
    to: view.to.toISOString(),
    earned: view.earned,
    spent: view.spent,
    expired: view.expired,
    refunded: view.refunded,
    reversed: view.reversed,
  };
}

export function toAdminTransactionDto(entry: LedgerEntry): AdminPointsTransactionDto {
  return {
    ...toTransactionDto(entry),
    idempotencyKey: entry.idempotencyKey,
    createdById: entry.createdById,
  };
}

export function toTransactionPageDto(page: Page<LedgerEntry>): PointsTransactionPageDto {
  return { items: page.items.map(toTransactionDto), nextCursor: page.nextCursor };
}

export function toAdminTransactionPageDto(page: Page<LedgerEntry>): AdminPointsTransactionPageDto {
  return { items: page.items.map(toAdminTransactionDto), nextCursor: page.nextCursor };
}
