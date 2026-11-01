import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ACTOR_TYPES, type ActorType } from '../../../common/contracts/shared';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import type { AuditLogView } from '../domain/views';

export class AuditQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ example: 'tenant', description: 'Prisma model name in snake_case' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entityType?: string;

  @ApiPropertyOptional({ description: 'Entity id (uuid or natural key such as a flag key)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  entityId?: string;

  @ApiPropertyOptional({ enum: ACTOR_TYPES })
  @IsOptional()
  @IsIn(ACTOR_TYPES)
  actorType?: ActorType;

  @ApiPropertyOptional({ description: 'Admin id, user id or system component name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  actorId?: string;

  @ApiPropertyOptional({
    example: 'tenant.*',
    description: 'Exact action (`tenant.update`) or a prefix ending in `.*`',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Inclusive lower bound of createdAt' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Exclusive upper bound of createdAt' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class AuditLogDto implements AuditLogView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: ACTOR_TYPES })
  actorType: ActorType;

  @ApiPropertyOptional({ nullable: true })
  actorId: string | null;

  @ApiProperty({ example: 'manual_adjustment.approve' })
  action: string;

  @ApiProperty({ example: 'manual_adjustment' })
  entityType: string;

  @ApiPropertyOptional({ nullable: true })
  entityId: string | null;

  @ApiPropertyOptional({ description: 'Snapshot before the change (JSON)', nullable: true })
  before: unknown;

  @ApiPropertyOptional({ description: 'Snapshot after the change (JSON)', nullable: true })
  after: unknown;

  @ApiPropertyOptional({ nullable: true })
  reason: string | null;

  @ApiPropertyOptional({ nullable: true })
  ip: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class AuditPageDto {
  @ApiProperty({ type: [AuditLogDto] })
  items: AuditLogDto[];

  @ApiPropertyOptional({ nullable: true, description: 'Pass as ?cursor= to fetch the next page' })
  nextCursor: string | null;
}
