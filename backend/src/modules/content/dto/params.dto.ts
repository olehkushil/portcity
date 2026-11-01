import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, Matches, MaxLength } from 'class-validator';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '../domain/slug';

export class UuidParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;
}

export class SlugParamDto {
  @ApiProperty({ example: 'aroma-kava', pattern: SLUG_PATTERN.source })
  @Matches(SLUG_PATTERN)
  @MaxLength(SLUG_MAX_LENGTH)
  slug: string;
}
