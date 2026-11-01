import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { REWARD_KINDS, type RewardKind } from '../../../common/contracts/rewards';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import { REWARD_UNAVAILABLE_REASONS, type RewardUnavailableReason } from '../domain/reward-rules';
import { toOptionalBoolean } from './transforms';
import { VoucherDto } from './voucher.dto';

export class RewardTenantDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aroma-kava' })
  slug: string;

  @ApiProperty({ example: 'Aroma Kava' })
  name: string;

  @ApiProperty({ type: Number, nullable: true })
  floor: number | null;

  @ApiProperty({ type: String, nullable: true })
  logoKey: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Public logo URL; null when there is no logo or no public base URL',
  })
  logoUrl: string | null;
}

export class RewardDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Кава з собою' })
  title: string;

  @ApiProperty({ type: String, nullable: true })
  description: string | null;

  @ApiProperty({ example: 60 })
  costPoints: number;

  @ApiProperty({ enum: REWARD_KINDS })
  kind: RewardKind;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  tenantId: string | null;

  @ApiProperty({ type: RewardTenantDto, nullable: true })
  tenant: RewardTenantDto | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Remaining stock; null means unlimited',
  })
  stock: number | null;

  @ApiProperty({ type: Number, nullable: true })
  perUserLimit: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Redemptions left for the member; null when unlimited, for guests and in the back office',
  })
  remainingForUser: number | null;

  @ApiProperty()
  active: boolean;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  validFrom: Date | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  validTo: Date | null;

  @ApiProperty({ type: String, nullable: true })
  imageKey: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'S3_PUBLIC_BASE_URL + imageKey; null when either is missing',
  })
  imageUrl: string | null;

  @ApiProperty({ type: String, nullable: true })
  terms: string | null;

  @ApiProperty()
  sortOrder: number;

  @ApiProperty({
    description: 'True when the reward can be redeemed right now (stock, period, per-user limit)',
  })
  available: boolean;

  @ApiProperty({ enum: REWARD_UNAVAILABLE_REASONS, nullable: true })
  unavailableReason: RewardUnavailableReason | null;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: 'Null for guests and when the balance is unknown',
  })
  affordable: boolean | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class RewardPageDto {
  @ApiProperty({ type: [RewardDto] })
  items: RewardDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

export class RewardListQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    description: 'Only rewards the member can afford with the current balance',
  })
  @Transform(toOptionalBoolean)
  @IsOptional()
  @IsBoolean()
  affordable?: boolean;

  @ApiPropertyOptional({ enum: REWARD_KINDS })
  @IsOptional()
  @IsIn(REWARD_KINDS)
  kind?: RewardKind;
}

export class RedemptionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  rewardId: string;

  @ApiProperty({ enum: ['created', 'issued', 'cancelled', 'refunded'] })
  status: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class RedeemRewardResponseDto {
  @ApiProperty({ type: RedemptionDto })
  redemption: RedemptionDto;

  @ApiProperty({ type: VoucherDto })
  voucher: VoucherDto;

  @ApiProperty({ example: 60 })
  pointsSpent: number;

  @ApiProperty({ format: 'uuid', description: 'The spend transaction in the points ledger' })
  pointsTxId: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Available balance after the spend; null if unknown',
  })
  availableBalance: number | null;
}
