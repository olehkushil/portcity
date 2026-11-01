import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  EVENT_ADMISSIONS,
  EVENT_CATEGORIES,
  EVENT_REGISTRATION_STATUSES,
  EVENT_STATUSES,
  type EventAdmission,
  type EventCategory,
  type EventRegistrationStatus,
  type EventStatus,
  MAX_PERSONS_PER_REGISTRATION_LIMIT,
} from '../../../common/contracts/promos';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';

export class CreateEventDto {
  @ApiProperty({ example: 'Майстер-клас для дітей', maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 10000 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(10000)
  description?: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  startsAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  endsAt: Date;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(200)
  venue?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1, maximum: 100000 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(100000)
  capacity?: number | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  registrationOpen?: boolean;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 21 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(21)
  ageLimit?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(500)
  imageKey?: string | null;

  @ApiPropertyOptional({ enum: EVENT_CATEGORIES, default: 'other' })
  @IsOptional()
  @IsIn(EVENT_CATEGORIES)
  category?: EventCategory;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Host tenant (e.g. Figli Migli)',
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('all')
  tenantId?: string | null;

  @ApiPropertyOptional({
    enum: EVENT_ADMISSIONS,
    default: 'registration',
    description: 'registration: in-app registration with a ticket; external: externalUrl',
  })
  @IsOptional()
  @IsIn(EVENT_ADMISSIONS)
  admission?: EventAdmission;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 500,
    description: 'https link to buy or book; required when admission = external',
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  externalUrl?: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: MAX_PERSONS_PER_REGISTRATION_LIMIT,
    description:
      'Persons per registration; null = the events.registration flag payload (maxPersonsPerRegistration) or 4',
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(MAX_PERSONS_PER_REGISTRATION_LIMIT)
  maxPersonsPerRegistration?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 99 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(99)
  ageMin?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 99 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(99)
  ageMax?: number | null;
}

export class UpdateEventDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 10000 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(10000)
  description?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startsAt?: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endsAt?: Date;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(200)
  venue?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1, maximum: 100000 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(100000)
  capacity?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  registrationOpen?: boolean;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 21 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(21)
  ageLimit?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(500)
  imageKey?: string | null;

  @ApiPropertyOptional({ enum: EVENT_CATEGORIES, default: 'other' })
  @IsOptional()
  @IsIn(EVENT_CATEGORIES)
  category?: EventCategory;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Host tenant (e.g. Figli Migli)',
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('all')
  tenantId?: string | null;

  @ApiPropertyOptional({
    enum: EVENT_ADMISSIONS,
    default: 'registration',
    description: 'registration: in-app registration with a ticket; external: externalUrl',
  })
  @IsOptional()
  @IsIn(EVENT_ADMISSIONS)
  admission?: EventAdmission;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 500,
    description: 'https link to buy or book; required when admission = external',
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  externalUrl?: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: MAX_PERSONS_PER_REGISTRATION_LIMIT,
    description:
      'Persons per registration; null = the events.registration flag payload (maxPersonsPerRegistration) or 4',
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(MAX_PERSONS_PER_REGISTRATION_LIMIT)
  maxPersonsPerRegistration?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 99 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(99)
  ageMin?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 99 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(99)
  ageMax?: number | null;
}

export class AdminListEventsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: EVENT_STATUSES })
  @IsOptional()
  @IsIn(EVENT_STATUSES)
  status?: EventStatus;

  @ApiPropertyOptional({ enum: EVENT_CATEGORIES })
  @IsOptional()
  @IsIn(EVENT_CATEGORIES)
  category?: EventCategory;

  @ApiPropertyOptional({ description: 'Case-insensitive title search' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

export class AdminListRegistrationsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: EVENT_REGISTRATION_STATUSES })
  @IsOptional()
  @IsIn(EVENT_REGISTRATION_STATUSES)
  status?: EventRegistrationStatus;
}
