import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { REWARD_KINDS, type RewardKind } from '../../../common/contracts/rewards';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import { toDateOrNull, toOptionalBoolean, trimmed } from './transforms';

/** `@ValidateIf` guard: an explicit null clears the field and skips the other validators. */
const nullable = (dto: unknown, key: string): boolean =>
  (dto as Record<string, unknown>)[key] !== null;

export class CreateRewardDto {
  @ApiProperty({ example: 'Кава з собою', maxLength: 200 })
  @Transform(trimmed)
  @IsString()
  @Length(1, 200)
  title: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @ValidateIf((dto) => nullable(dto, 'description'))
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({ example: 60, minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  costPoints: number;

  @ApiProperty({ enum: REWARD_KINDS })
  @IsIn(REWARD_KINDS)
  kind: RewardKind;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @ValidateIf((dto) => nullable(dto, 'tenantId'))
  @IsUUID()
  tenantId?: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Remaining stock; null means unlimited',
  })
  @IsOptional()
  @ValidateIf((dto) => nullable(dto, 'stock'))
  @IsInt()
  @Min(0)
  stock?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @ValidateIf((dto) => nullable(dto, 'perUserLimit'))
  @IsInt()
  @Min(1)
  perUserLimit?: number | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time' })
  @IsOptional()
  @Transform(toDateOrNull)
  @ValidateIf((dto) => nullable(dto, 'validFrom'))
  @IsDate()
  validFrom?: Date | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time' })
  @IsOptional()
  @Transform(toDateOrNull)
  @ValidateIf((dto) => nullable(dto, 'validTo'))
  @IsDate()
  validTo?: Date | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Object key in storage' })
  @IsOptional()
  @ValidateIf((dto) => nullable(dto, 'imageKey'))
  @IsString()
  @MaxLength(512)
  imageKey?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 4000 })
  @IsOptional()
  @ValidateIf((dto) => nullable(dto, 'terms'))
  @IsString()
  @MaxLength(4000)
  terms?: string | null;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(-10_000)
  @Max(10_000)
  sortOrder?: number;
}

export class UpdateRewardDto extends PartialType(CreateRewardDto) {}

export class AdminRewardListQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ type: Boolean })
  @Transform(toOptionalBoolean)
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ enum: REWARD_KINDS })
  @IsOptional()
  @IsIn(REWARD_KINDS)
  kind?: RewardKind;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}
