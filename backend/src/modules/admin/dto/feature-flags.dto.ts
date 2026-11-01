import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional, IsString, Length } from 'class-validator';
import { FEATURE_FLAG_KEYS, type FeatureFlagView } from '../../../common/contracts/admin';

export class UpsertFeatureFlagDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  enabled: boolean;

  @ApiPropertyOptional({
    type: Object,
    nullable: true,
    description: 'Free-form JSON object. Omit to keep the stored payload, send null to clear it.',
    example: { maxSessionsPerDay: 3 },
  })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown> | null;

  @ApiPropertyOptional({ maxLength: 500, description: 'Stored in the audit log' })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  reason?: string;
}

export class FeatureFlagDto implements FeatureFlagView {
  @ApiProperty({ example: FEATURE_FLAG_KEYS.parkingInfoMode })
  key: string;

  @ApiProperty()
  enabled: boolean;

  @ApiPropertyOptional({ type: Object, nullable: true })
  payload: Record<string, unknown> | null;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class FeatureFlagListDto {
  @ApiProperty({ type: [FeatureFlagDto] })
  items: FeatureFlagDto[];
}
