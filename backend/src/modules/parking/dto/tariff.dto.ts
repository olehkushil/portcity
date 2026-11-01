import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';
import type { ParkingTariffConfig } from '../../../common/contracts/parking';
import type { TariffDescription, TariffLine } from '../domain/tariff-describe';
import { ChargeLineDto, NextChargeDto, PayNowDto } from './session.dto';

export class NightWindowDto {
  @ApiProperty({ example: '00:00' })
  from: string;

  @ApiProperty({ example: '05:00' })
  to: string;

  @ApiProperty({ example: 50000 })
  hourKopecks: number;
}

export class TariffConfigDto {
  @ApiProperty({ example: 30 })
  freeMinutes: number;

  @ApiProperty({ description: 'Minutes 31-60', example: 2000 })
  firstHourKopecks: number;

  @ApiProperty({ description: 'Every further started hour', example: 4000 })
  nextHourKopecks: number;

  @ApiProperty({ type: NightWindowDto })
  nightWindow: NightWindowDto;

  @ApiProperty({ example: 50000 })
  lostTicketKopecks: number;

  @ApiProperty({ description: 'Exit must happen by the end of the paid hour', example: 0 })
  exitGraceMinutes: number;

  @ApiProperty({ example: '08:00-21:00' })
  undergroundHours: string;

  @ApiProperty({ example: '05:00-24:00' })
  surfaceHours: string;
}

export class TariffLineDto {
  @ApiProperty({ enum: ['free', 'first_hour', 'hour', 'night', 'lost_ticket'] })
  kind: TariffLine['kind'];

  @ApiProperty({ example: '31–60 хв' })
  label: string;

  @ApiProperty({ example: '20 ₴' })
  price: string;

  @ApiProperty({ example: 2000 })
  amountKopecks: number;
}

export class ZoneHoursDto {
  @ApiProperty({ example: '08:00–21:00' })
  underground: string;

  @ApiProperty({ example: '05:00–00:00' })
  surface: string;
}

export class TariffDescriptionDto {
  @ApiProperty({ type: [TariffLineDto] })
  lines: TariffLineDto[];

  @ApiProperty({ example: 'Виїзд — до кінця оплаченої години. Втрата талона — 500 ₴' })
  rules: string;

  @ApiProperty({ type: ZoneHoursDto })
  hours: ZoneHoursDto;

  @ApiProperty({ example: 'Підземний 08:00–21:00 · Наземний 05:00–00:00' })
  hoursLine: string;

  @ApiProperty()
  payment: string;

  @ApiProperty()
  airRaid: string;
}

export class ParkingTariffDto {
  @ApiProperty({ description: '0 = built-in default (no tariff row yet)', example: 1 })
  version: number;

  @ApiProperty({ type: TariffConfigDto })
  config: TariffConfigDto;

  @ApiProperty({ type: TariffDescriptionDto, description: 'Ready-made Ukrainian lines for S06' })
  description: TariffDescriptionDto;
}

export class QuoteRequestDto {
  @ApiProperty({ type: String, format: 'date-time', example: '2026-11-01T12:00:00.000Z' })
  @IsISO8601({ strict: true })
  enteredAt: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Defaults to the server time',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  now?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'End of an already paid period (overstay calculation)',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  paidUntil?: string;
}

export class QuoteDto {
  @ApiProperty({ example: 6000 })
  amountDueKopecks: number;

  @ApiProperty({ type: String, format: 'date-time' })
  freeUntil: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: '«Орієнтовно 60 ₴ · виїзд до 16:00»',
  })
  currentHourEndsAt: string;

  @ApiProperty({ type: NextChargeDto })
  nextCharge: NextChargeDto;

  @ApiProperty({ example: 80 })
  durationMinutes: number;

  @ApiProperty({ type: [ChargeLineDto] })
  breakdown: ChargeLineDto[];

  @ApiProperty({
    type: PayNowDto,
    nullable: true,
    description:
      'What paying now would charge and until when (null when nothing is due); includes the next hour near the end of the running one',
  })
  payNow: PayNowDto | null;

  @ApiProperty({
    description: 'True when paying now also buys the next hour (fewer than 5 minutes left)',
  })
  includesNextHour: boolean;

  @ApiProperty({ example: 1 })
  tariffVersion: number;
}

export function toTariffConfigDto(config: ParkingTariffConfig): TariffConfigDto {
  return {
    freeMinutes: config.freeMinutes,
    firstHourKopecks: config.firstHourKopecks,
    nextHourKopecks: config.nextHourKopecks,
    nightWindow: { ...config.nightWindow },
    lostTicketKopecks: config.lostTicketKopecks,
    exitGraceMinutes: config.exitGraceMinutes,
    undergroundHours: config.undergroundHours,
    surfaceHours: config.surfaceHours,
  };
}

export function toTariffDescriptionDto(description: TariffDescription): TariffDescriptionDto {
  return {
    lines: description.lines.map((line) => ({ ...line })),
    rules: description.rules,
    hours: { ...description.hours },
    hoursLine: description.hoursLine,
    payment: description.payment,
    airRaid: description.airRaid,
  };
}
