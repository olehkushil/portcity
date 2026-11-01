import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { RECEIPT_STATUSES } from '../../../common/contracts/receipts';
import {
  type AdjustmentDailyStats,
  type DailyReport,
  MAX_REPORT_RANGE_DAYS,
  REPORT_SOURCES,
  type ReportSource,
} from '../domain/daily-report';
import { IsDayKey } from './validators';

export class DailyReportQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-29',
    description: 'Kyiv calendar day yyyy-MM-dd; defaults to yesterday (Kyiv)',
  })
  @IsOptional()
  @IsDayKey()
  day?: string;
}

export class DailyReportRangeQueryDto {
  @ApiProperty({ example: '2026-10-01', description: 'First day, inclusive' })
  @IsDayKey()
  from: string;

  @ApiProperty({
    example: '2026-10-31',
    description: `Last day, inclusive; at most ${MAX_REPORT_RANGE_DAYS} days after "from"`,
  })
  @IsDayKey()
  to: string;
}

export class RecomputeDailyReportDto {
  @ApiPropertyOptional({
    example: '2026-10-29',
    description: 'Day to recompute; defaults to yesterday (Kyiv). Today yields a partial report.',
  })
  @IsOptional()
  @IsDayKey()
  day?: string;
}

export class ReportRangeDto {
  @ApiProperty({ type: String, format: 'date-time' })
  from: string;

  @ApiProperty({ type: String, format: 'date-time' })
  to: string;
}

export class ReceiptsSectionDto {
  @ApiProperty()
  submitted: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { credited: 12, needs_moderation: 3, rejected: 1 },
    description: `Counts per status (${RECEIPT_STATUSES.join(', ')})`,
  })
  byStatus: Record<string, number>;

  @ApiProperty()
  pointsAwarded: number;
}

export class PointsSectionDto {
  @ApiProperty()
  earned: number;

  @ApiProperty()
  spent: number;

  @ApiProperty()
  expired: number;

  @ApiProperty()
  reversed: number;
}

export class VouchersSectionDto {
  @ApiProperty()
  issued: number;

  @ApiProperty()
  redeemed: number;

  @ApiProperty({ description: 'Vouchers in issued or active state at the end of the day' })
  live: number;
}

export class ParkingSectionDto {
  @ApiProperty()
  opened: number;

  @ApiProperty()
  closed: number;

  @ApiProperty({ description: 'Kopecks paid for parking during the day' })
  paidKopecks: number;
}

export class AdjustmentsSectionDto implements AdjustmentDailyStats {
  @ApiProperty()
  requested: number;

  @ApiProperty()
  approved: number;

  @ApiProperty()
  applied: number;

  @ApiProperty()
  rejected: number;

  @ApiProperty({ description: 'Signed sum of applied amounts' })
  appliedPoints: number;
}

export class DailyReportDto implements DailyReport {
  @ApiProperty({ example: '2026-10-29' })
  day: string;

  @ApiProperty({ type: ReportRangeDto })
  range: ReportRangeDto;

  @ApiPropertyOptional({ type: ReceiptsSectionDto, nullable: true })
  receipts: ReceiptsSectionDto | null;

  @ApiPropertyOptional({ type: PointsSectionDto, nullable: true })
  points: PointsSectionDto | null;

  @ApiPropertyOptional({ type: VouchersSectionDto, nullable: true })
  vouchers: VouchersSectionDto | null;

  @ApiPropertyOptional({ type: ParkingSectionDto, nullable: true })
  parking: ParkingSectionDto | null;

  @ApiProperty({ type: AdjustmentsSectionDto })
  adjustments: AdjustmentsSectionDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { parking: 'PC_PARKING_PROVIDER_UNAVAILABLE' },
    description: 'Sections that could not be computed, with the error code',
  })
  errors: Partial<Record<'receipts' | 'points' | 'vouchers' | 'parking', string>>;

  @ApiProperty({ description: 'True when every section was computed' })
  complete: boolean;

  @ApiProperty({ description: 'False when computed before the Kyiv day ended (partial numbers)' })
  dayClosed: boolean;

  @ApiProperty({ enum: REPORT_SOURCES })
  source: ReportSource;

  @ApiProperty({ type: String, format: 'date-time' })
  computedAt: string;
}

export class DailyReportListDto {
  @ApiProperty({ type: [DailyReportDto] })
  items: DailyReportDto[];
}
