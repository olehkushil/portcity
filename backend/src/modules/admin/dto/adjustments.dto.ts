import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  NotEquals,
} from 'class-validator';
import {
  FOUR_EYES_THRESHOLD_POINTS,
  MANUAL_ADJUSTMENT_STATUSES,
  type ManualAdjustmentStatus,
} from '../../../common/contracts/admin';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import {
  MAX_ADJUSTMENT_POINTS,
  SECOND_APPROVAL_REASONS,
  type SecondApprovalReason,
} from '../domain/adjustment-rules';
import type { AdjustmentView } from '../domain/views';

export class CreateAdjustmentDto {
  @ApiProperty({ format: 'uuid', description: 'Member whose loyalty account is adjusted' })
  @IsUUID()
  userId: string;

  @ApiProperty({
    example: 150,
    description: `Signed integer points: positive credits, negative debits. A second admin must approve when the absolute amount exceeds ${FOUR_EYES_THRESHOLD_POINTS}, or when it would bring the requester's self-approved total of the Kyiv day or the account's self-approved total of the last 24 h above ${FOUR_EYES_THRESHOLD_POINTS}.`,
    minimum: -MAX_ADJUSTMENT_POINTS,
    maximum: MAX_ADJUSTMENT_POINTS,
  })
  @IsInt()
  @NotEquals(0)
  @Min(-MAX_ADJUSTMENT_POINTS)
  @Max(MAX_ADJUSTMENT_POINTS)
  amount: number;

  @ApiProperty({
    example: 'Компенсація за технічний збій у застосунку',
    minLength: 3,
    maxLength: 500,
  })
  @IsString()
  @Length(3, 500)
  reason: string;
}

export class RejectAdjustmentDto {
  @ApiProperty({ example: 'Дублює коригування від 12.10', minLength: 3, maxLength: 500 })
  @IsString()
  @Length(3, 500)
  reason: string;
}

export class ListAdjustmentsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: MANUAL_ADJUSTMENT_STATUSES })
  @IsOptional()
  @IsIn(MANUAL_ADJUSTMENT_STATUSES)
  status?: ManualAdjustmentStatus;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only adjustments of this member' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}

export class AdjustmentDto implements AdjustmentView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  accountId: string;

  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty({ example: 150, description: 'Signed points' })
  amount: number;

  @ApiProperty()
  reason: string;

  @ApiProperty({ enum: MANUAL_ADJUSTMENT_STATUSES })
  status: ManualAdjustmentStatus;

  @ApiProperty({
    description:
      'True when a second admin must approve: |amount| or the cumulative self-approved totals exceed thresholdPoints (four eyes)',
  })
  needsSecondApproval: boolean;

  @ApiPropertyOptional({
    enum: SECOND_APPROVAL_REASONS,
    nullable: true,
    description:
      'amount: |amount| > threshold; requester_daily_total: the requester self-approved too much today (Kyiv); account_24h_total: the account got too much self-approved in 24 h',
  })
  secondApprovalReason: SecondApprovalReason | null;

  @ApiProperty({ example: FOUR_EYES_THRESHOLD_POINTS })
  thresholdPoints: number;

  @ApiProperty({ format: 'uuid' })
  requestedById: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  approvedById: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'Ledger row once applied' })
  pointsTxId: string | null;

  @ApiPropertyOptional({ nullable: true })
  rejectionReason: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  appliedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class AdjustmentPageDto {
  @ApiProperty({ type: [AdjustmentDto] })
  items: AdjustmentDto[];

  @ApiPropertyOptional({ nullable: true, description: 'Pass as ?cursor= to fetch the next page' })
  nextCursor: string | null;
}
