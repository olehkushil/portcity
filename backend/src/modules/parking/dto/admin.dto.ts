import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  PARKING_SESSION_STATUSES,
  type ParkingSessionStatus,
} from '../../../common/contracts/parking';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import type { TariffRecord } from '../services/tariff.service';
import { ParkingSessionDto } from './session.dto';
import { TariffConfigDto, toTariffConfigDto } from './tariff.dto';

export class CreateParkingTariffDto {
  @ApiProperty({ type: String, format: 'date-time', description: 'The new version applies from' })
  @IsISO8601({ strict: true })
  activeFrom: string;

  @ApiProperty({ type: TariffConfigDto, description: 'Validated as a whole (zod schema)' })
  @IsObject()
  config: Record<string, unknown>;
}

export class ParkingTariffRecordDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 2 })
  version: number;

  @ApiProperty({ type: String, format: 'date-time' })
  activeFrom: string;

  @ApiProperty({ type: TariffConfigDto })
  config: TariffConfigDto;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
}

export class ParkingTariffListDto {
  @ApiProperty({ type: [ParkingTariffRecordDto] })
  items: ParkingTariffRecordDto[];
}

export class AdminSessionsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: PARKING_SESSION_STATUSES })
  @IsOptional()
  @IsIn(PARKING_SESSION_STATUSES)
  status?: ParkingSessionStatus;

  @ApiPropertyOptional({
    description: 'Any spelling; normalised like member input',
    example: 'AC1234BC',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  plate?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: 'true: only sessions members disputed (F2 «Це не моє авто»); false: only others',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  disputed?: 'true' | 'false';
}

export class AdminSessionPageDto {
  @ApiProperty({ type: [ParkingSessionDto] })
  items: ParkingSessionDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

export class AdminCloseSessionDto {
  @ApiProperty({
    enum: ['privilege', 'air_raid'],
    description: 'Closes the session as closed_free',
  })
  @IsIn(['privilege', 'air_raid'])
  reason: 'privilege' | 'air_raid';

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export function toTariffRecordDto(record: TariffRecord): ParkingTariffRecordDto {
  return {
    id: record.id,
    version: record.version,
    activeFrom: record.activeFrom.toISOString(),
    config: toTariffConfigDto(record.config),
    createdById: record.createdById,
    createdAt: record.createdAt.toISOString(),
  };
}
