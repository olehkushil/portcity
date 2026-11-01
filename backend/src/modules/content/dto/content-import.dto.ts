import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { TENANT_STATUSES, type TenantStatus } from '../../../common/contracts/content';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import { CONTENT_IMPORT_SOURCES, type ContentImportSource } from '../jobs/content-import.job';

export const CONTENT_IMPORT_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type ContentImportRunStatus = (typeof CONTENT_IMPORT_STATUSES)[number];

export const CONTENT_IMPORT_MAX_ITEMS = 500;

export class ContentImportItemDto {
  @ApiPropertyOptional({ nullable: true, description: 'Derived from the name when omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  slug?: string | null;

  @ApiProperty({ example: 'Aroma Kava' })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  name: string;

  @ApiPropertyOptional({ nullable: true, description: 'Category key or a Ukrainian/English label' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string | null;

  @ApiPropertyOptional({ nullable: true, oneOf: [{ type: 'integer' }, { type: 'string' }] })
  @IsOptional()
  @Allow()
  floor?: number | string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Storage key of an already uploaded logo' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  logoKey?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Identifier in the source system' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalId?: string | null;
}

export class ContentImportDefaultsDto {
  @ApiPropertyOptional({ enum: TENANT_STATUSES, default: 'active' })
  @IsOptional()
  @IsIn(TENANT_STATUSES)
  status?: TenantStatus;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  participates?: boolean;
}

export class RunContentImportDto {
  @ApiProperty({ enum: CONTENT_IMPORT_SOURCES })
  @IsIn(CONTENT_IMPORT_SOURCES)
  source: ContentImportSource;

  @ApiPropertyOptional({ default: false, description: 'Compute the plan without writing' })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Queue the run (content-import queue, executed by the worker): answers 202 with the run in status running; poll GET /admin/content/import-runs/:id',
  })
  @IsOptional()
  @IsBoolean()
  async?: boolean;

  @ApiPropertyOptional({ type: [ContentImportItemDto], maxItems: CONTENT_IMPORT_MAX_ITEMS })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CONTENT_IMPORT_MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => ContentImportItemDto)
  items?: ContentImportItemDto[];

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    maxItems: CONTENT_IMPORT_MAX_ITEMS,
    description: 'Raw WordPress REST posts (wp/v2); mapped with mapWordPressPost',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CONTENT_IMPORT_MAX_ITEMS)
  @IsObject({ each: true })
  posts?: Record<string, unknown>[];

  @ApiPropertyOptional({ type: ContentImportDefaultsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ContentImportDefaultsDto)
  defaults?: ContentImportDefaultsDto;
}

export class ListImportRunsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: CONTENT_IMPORT_STATUSES })
  @IsOptional()
  @IsIn(CONTENT_IMPORT_STATUSES)
  status?: ContentImportRunStatus;
}

export class ContentImportStatsDto {
  @ApiProperty({ enum: CONTENT_IMPORT_SOURCES })
  source: ContentImportSource;

  @ApiProperty()
  dryRun: boolean;

  @ApiProperty()
  received: number;

  @ApiProperty()
  valid: number;

  @ApiProperty()
  invalid: number;

  @ApiProperty()
  duplicates: number;

  @ApiProperty()
  created: number;

  @ApiProperty()
  updated: number;

  @ApiProperty()
  unchanged: number;

  @ApiProperty({ type: [String] })
  createdSlugs: string[];

  @ApiProperty({ type: [String] })
  updatedSlugs: string[];

  @ApiProperty({ type: [String] })
  issues: string[];

  @ApiProperty({ type: [String] })
  warnings: string[];
}

export class ContentImportRunDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: CONTENT_IMPORT_SOURCES })
  source: string;

  @ApiProperty({ enum: CONTENT_IMPORT_STATUSES })
  status: ContentImportRunStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  startedAt: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  finishedAt: Date | null;

  @ApiProperty({ type: ContentImportStatsDto, nullable: true })
  stats: ContentImportStatsDto | null;

  @ApiProperty({ nullable: true, type: String })
  error: string | null;
}

export class ContentImportRunPageDto {
  @ApiProperty({ type: [ContentImportRunDto] })
  items: ContentImportRunDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor: string | null;
}
