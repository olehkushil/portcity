import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
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
import { TICKET_STATUSES, type TicketStatus } from '../domain/event-state';
import { PromoTenantDto, PromoVoucherDto } from './promo.dto';

export const EVENT_LIST_SCOPES = ['upcoming', 'past'] as const;
export type EventListScope = (typeof EVENT_LIST_SCOPES)[number];

export class ListEventsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({
    enum: EVENT_LIST_SCOPES,
    default: 'upcoming',
    description: 'upcoming: published events that have not ended; past: finished or ended',
  })
  @IsOptional()
  @IsIn(EVENT_LIST_SCOPES)
  scope?: EventListScope;

  @ApiPropertyOptional({ enum: EVENT_CATEGORIES, description: 'Filter chip of the poster' })
  @IsOptional()
  @IsIn(EVENT_CATEGORIES)
  category?: EventCategory;
}

/**
 * The per-event limit (`EventDto.maxPersonsPerRegistration`) is checked by the service; the DTO
 * only bounds the numbers.
 */
export class RegisterEventDto {
  @ApiProperty({
    minimum: 1,
    maximum: MAX_PERSONS_PER_REGISTRATION_LIMIT,
    example: 2,
    description: 'adults + children must not exceed the event maxPersonsPerRegistration',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_PERSONS_PER_REGISTRATION_LIMIT)
  adults: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_PERSONS_PER_REGISTRATION_LIMIT - 1,
    default: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_PERSONS_PER_REGISTRATION_LIMIT - 1)
  children?: number;
}

export class RegistrationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  eventId: string;

  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty()
  adults: number;

  @ApiProperty()
  children: number;

  @ApiProperty({ description: 'adults + children' })
  persons: number;

  @ApiProperty({ enum: EVENT_REGISTRATION_STATUSES })
  status: EventRegistrationStatus;

  @ApiProperty({ enum: TICKET_STATUSES, description: 'Derived ticket status (brief section 6)' })
  ticketStatus: TicketStatus;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  voucherId: string | null;

  @ApiProperty({
    type: PromoVoucherDto,
    nullable: true,
    description: 'The ticket voucher when loaded',
  })
  ticket: PromoVoucherDto | null;

  @ApiProperty({ type: String, format: 'date-time', description: 'Member may cancel before this' })
  cancelDeadline: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
}

export class EventDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Майстер-клас для дітей' })
  title: string;

  @ApiProperty({ type: String, nullable: true })
  description: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;

  @ApiProperty({ type: String, nullable: true, example: 'Figli Migli, 3 поверх' })
  venue: string | null;

  @ApiProperty({ enum: EVENT_CATEGORIES })
  category: EventCategory;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'Host tenant' })
  tenantId: string | null;

  @ApiProperty({ type: PromoTenantDto, nullable: true, description: 'Host tenant card' })
  tenant: PromoTenantDto | null;

  @ApiProperty({
    enum: EVENT_ADMISSIONS,
    description: 'registration: register in the app (ticket); external: follow externalUrl',
  })
  admission: EventAdmission;

  @ApiProperty({ type: String, nullable: true, description: 'Booking link for external admission' })
  externalUrl: string | null;

  @ApiProperty({
    description:
      'Effective persons limit per registration (event value, else the events.registration flag payload, else 4)',
    example: 4,
  })
  maxPersonsPerRegistration: number;

  @ApiProperty({ type: Number, nullable: true, description: 'Max persons; null = unlimited' })
  capacity: number | null;

  @ApiProperty({ description: 'Persons of active registrations' })
  registeredCount: number;

  @ApiProperty({ type: Number, nullable: true })
  seatsLeft: number | null;

  @ApiProperty({ description: 'Admin flag: registrations accepted' })
  registrationOpen: boolean;

  @ApiProperty({ description: 'Effective: published, open, not started and seats left' })
  canRegister: boolean;

  @ApiProperty({ type: Number, nullable: true, description: 'Legacy minimum age; see ageMin' })
  ageLimit: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 5 })
  ageMin: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 10 })
  ageMax: number | null;

  @ApiProperty({ type: String, nullable: true })
  imageKey: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Public poster URL (S3_PUBLIC_BASE_URL + imageKey); null without image or base URL',
  })
  imageUrl: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Members may cancel a registration before this moment (11:00 Kyiv on the event day or the start); null for external admission',
  })
  cancelDeadline: Date | null;

  @ApiProperty({ enum: EVENT_STATUSES })
  status: EventStatus;

  @ApiProperty({ enum: ['upcoming', 'ongoing', 'past'] })
  window: 'upcoming' | 'ongoing' | 'past';

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  @ApiProperty({
    type: RegistrationDto,
    nullable: true,
    description:
      'The authenticated member registration for this event (null when none and always for guests)',
  })
  registration: RegistrationDto | null;
}

export class EventPageDto {
  @ApiProperty({ type: [EventDto] })
  items: EventDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

export class RegistrationPageDto {
  @ApiProperty({ type: [RegistrationDto] })
  items: RegistrationDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}
