import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  PARKING_DISPUTE_REASONS,
  PARKING_SESSION_SOURCES,
  PARKING_SESSION_STATUSES,
  PARKING_ZONES,
  type ParkingChargeKind,
  type ParkingChargeLine,
  type ParkingDisputeReason,
  type ParkingSessionSource,
  type ParkingSessionStatus,
  type ParkingZone,
} from '../../../common/contracts/parking';
import { PAYMENT_STATUSES, type PaymentStatus } from '../../../common/contracts/payments';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import type { AirRaidView } from '../domain/air-raid';
import { PAID_VIA, type PaidVia } from '../domain/history';
import {
  HERO_ACTIONS,
  HERO_STATES,
  PARKING_MODES,
  type HeroAction,
  type HeroState,
  type ParkingMode,
} from '../domain/hero';
import { PARKING_NOTICES, type ParkingNotice } from '../domain/notices';
import type { NextCharge, SessionView } from '../domain/session-view';
import type {
  HistoryItem,
  HistorySummary,
  ParkingHero,
  RestrictedSessionView,
} from '../services/sessions.service';
import { VehicleDto, toVehicleDto } from './vehicle.dto';

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export class ChargeLineDto {
  @ApiProperty({ type: String, format: 'date-time' })
  from: string;

  @ApiProperty({ type: String, format: 'date-time' })
  to: string;

  @ApiProperty({ enum: ['free', 'first_hour', 'hour', 'night'], example: 'first_hour' })
  kind: ParkingChargeKind;

  @ApiProperty({ example: 2000 })
  amountKopecks: number;
}

export class NextChargeDto {
  @ApiProperty({ type: String, format: 'date-time', description: 'When the next charge starts' })
  startsAt: string;

  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: string;

  @ApiProperty({ description: '«+40 ₴» for the next hour', example: 4000 })
  amountKopecks: number;
}

export class PayNowDto {
  @ApiProperty({ description: '«Сплатити 60 ₴»: what a payment made now charges', example: 6000 })
  amountKopecks: number;

  @ApiProperty({ type: String, format: 'date-time', description: '«Виїзд до» after paying now' })
  paidUntil: string;

  @ApiProperty({
    description:
      'True when the running hour ends in less than PARKING_PAY_MIN_MINUTES_LEFT (5) minutes and the next hour is included',
  })
  includesNextHour: boolean;
}

export class SessionPaymentDto {
  @ApiProperty({ format: 'uuid', description: 'GET /payments/:id for the receipt screen' })
  id: string;

  @ApiProperty({ example: 6000 })
  amountKopecks: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidAt: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Exit deadline it bought',
  })
  paidUntil: string | null;

  @ApiProperty({ enum: PAYMENT_STATUSES })
  status: PaymentStatus;
}

export class ParkingSessionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: PARKING_SESSION_SOURCES })
  source: ParkingSessionSource;

  @ApiProperty({ enum: PARKING_SESSION_STATUSES, description: 'Derived at serverTime' })
  status: ParkingSessionStatus;

  @ApiProperty({ type: String, nullable: true, example: 'AC1234BC' })
  plate: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'AC 1234 BC' })
  plateDisplay: string | null;

  @ApiProperty({ enum: PARKING_ZONES })
  zone: ParkingZone;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Level if the operator knows it',
    example: '-2',
  })
  level: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Row or spot if known', example: 'C' })
  spot: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  enteredAt: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  exitedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', description: 'End of the free period' })
  freeUntil: string;

  @ApiProperty({ description: 'Due right now, kopecks', example: 6000 })
  amountDueKopecks: number;

  @ApiProperty({ example: 0 })
  amountPaidKopecks: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'End of the running hour: the exit deadline a payment made now buys',
  })
  currentHourEndsAt: string;

  @ApiProperty({ type: NextChargeDto, nullable: true })
  nextCharge: NextChargeDto | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: '«Виїзд до»' })
  paidUntil: string | null;

  @ApiProperty({ description: 'Tariff price of the whole stay so far, ignoring payments' })
  stayTotalKopecks: number;

  @ApiProperty({ example: 80 })
  durationMinutes: number;

  @ApiProperty({ type: [ChargeLineDto], description: 'Tariff breakdown of the amount' })
  breakdown: ChargeLineDto[];

  @ApiProperty({ type: String, nullable: true, example: null })
  closedReason: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastSyncedAt: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '«оновлено HH:MM» (Kyiv time)',
    example: '15:20',
  })
  lastSyncedAtLabel: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Air raid: «Вільний виїзд до HH:MM»',
  })
  freeExitUntil: string | null;

  @ApiProperty({
    type: PayNowDto,
    nullable: true,
    description: 'What «Сплатити» charges now (null when nothing is due)',
  })
  payNow: PayNowDto | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Last F7 «Так, я тут»',
  })
  presenceConfirmedAt: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Set when the member disputed the session (back office)',
  })
  disputedAt: string | null;

  @ApiProperty({ type: [SessionPaymentDto], description: 'App payments linked to the session' })
  payments: SessionPaymentDto[];
}

export class RestrictedSessionDto {
  @ApiProperty({ format: 'uuid' })
  vehicleId: string;

  @ApiProperty({ example: 'AC1234BC' })
  plate: string;

  @ApiProperty({ example: 'AC 1234 BC' })
  plateDisplay: string;

  @ApiProperty({ example: 6000 })
  amountDueKopecks: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidUntil: string | null;
}

export class LookupQuotaDto {
  @ApiProperty({ example: 10 })
  limit: number;

  @ApiProperty({ example: 9 })
  remaining: number;

  @ApiProperty({ type: String, format: 'date-time' })
  resetAt: string;
}

export class AirRaidDto {
  @ApiProperty()
  active: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  freeExitUntil: string | null;

  @ApiProperty({ description: 'The free-exit window is still open' })
  freeExitOpen: boolean;
}

export class ParkingHeroDto {
  @ApiProperty({ enum: PARKING_MODES, description: 'info: timer mode without the operator' })
  mode: ParkingMode;

  @ApiProperty({ enum: HERO_STATES, description: 'Hero card state (design brief section 4)' })
  heroState: HeroState;

  @ApiProperty({ enum: HERO_ACTIONS, isArray: true })
  actions: HeroAction[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Base for client-side countdowns',
  })
  serverTime: string;

  @ApiProperty()
  infoModeEnabled: boolean;

  @ApiProperty({ description: 'False when the operator was unreachable (data as of lastSyncedAt)' })
  providerAvailable: boolean;

  @ApiProperty({ type: VehicleDto, nullable: true })
  defaultVehicle: VehicleDto | null;

  @ApiProperty({ type: [VehicleDto] })
  vehicles: VehicleDto[];

  @ApiProperty({ type: ParkingSessionDto, nullable: true })
  session: ParkingSessionDto | null;

  @ApiProperty({
    type: RestrictedSessionDto,
    nullable: true,
    description: 'Unverified plate: only the amount and the paid period (10 lookups per hour)',
  })
  restricted: RestrictedSessionDto | null;

  @ApiProperty({ type: LookupQuotaDto, nullable: true })
  lookupQuota: LookupQuotaDto | null;

  @ApiProperty({ type: AirRaidDto })
  airRaid: AirRaidDto;

  @ApiProperty({ enum: PARKING_NOTICES, isArray: true })
  notices: ParkingNotice[];

  @ApiProperty({ example: 1 })
  tariffVersion: number;
}

export class ParkingHistoryItemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: PARKING_SESSION_SOURCES })
  source: ParkingSessionSource;

  @ApiProperty({ enum: PARKING_SESSION_STATUSES })
  status: ParkingSessionStatus;

  @ApiProperty({ type: String, nullable: true })
  plate: string | null;

  @ApiProperty({ type: String, nullable: true })
  plateDisplay: string | null;

  @ApiProperty({ enum: PARKING_ZONES })
  zone: ParkingZone;

  @ApiProperty({ type: String, format: 'date-time' })
  enteredAt: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  exitedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidUntil: string | null;

  @ApiProperty({ description: '«1 год 52 хв»', example: 112 })
  durationMinutes: number;

  @ApiProperty({ example: 6000 })
  amountPaidKopecks: number;

  @ApiProperty({ example: 6000 })
  stayTotalKopecks: number;

  @ApiProperty({ type: String, nullable: true })
  closedReason: string | null;

  @ApiProperty({
    enum: PAID_VIA,
    description: 'app: paid in the app; paymat: paid outside the app; free; none',
  })
  paidVia: PaidVia;

  @ApiProperty({
    type: [String],
    description: 'App payments of the stay (kept or refunded): GET /payments/:id',
  })
  paymentIds: string[];

  @ApiProperty({ description: 'The member disputed this session (F2 «Це не моє авто»)' })
  disputed: boolean;
}

export class ParkingHistoryPageDto {
  @ApiProperty({ type: [ParkingHistoryItemDto] })
  items: ParkingHistoryItemDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

export class ParkingHistoryQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Sessions entered at or after this instant',
    example: '2026-10-01T00:00:00+03:00',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Sessions entered before this instant',
    example: '2026-11-01T00:00:00+02:00',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}

export class ParkingHistorySummaryQueryDto {
  @ApiProperty({ description: 'Kyiv calendar month', example: '2026-10' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month: string;
}

export class ParkingHistorySummaryDto {
  @ApiProperty({ example: '2026-10' })
  month: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'Start of the month (Kyiv)' })
  from: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'Start of the next month (Kyiv)' })
  to: string;

  @ApiProperty({ description: 'Stays entered in the month (disputed ones excluded)', example: 6 })
  visits: number;

  @ApiProperty({ description: 'Paid in the app and at the paymat, kopecks', example: 34000 })
  totalPaidKopecks: number;

  @ApiProperty({ description: 'Total time parked, minutes', example: 580 })
  totalDurationMinutes: number;
}

export class ClaimSessionDto {
  @ApiProperty({
    description: 'Number printed on the entry talon',
    example: 'PC-0418227',
  })
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  talonCode: string;
}

export class DisputeSessionDto {
  @ApiProperty({
    enum: PARKING_DISPUTE_REASONS,
    description: 'not_my_car: «Це не моє авто»; wrong_amount; barrier: the barrier did not open',
  })
  @IsIn(PARKING_DISPUTE_REASONS)
  reason: ParkingDisputeReason;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

export function toHistorySummaryDto(summary: HistorySummary): ParkingHistorySummaryDto {
  return {
    month: summary.month,
    from: summary.from.toISOString(),
    to: summary.to.toISOString(),
    visits: summary.visits,
    totalPaidKopecks: summary.totalPaidKopecks,
    totalDurationMinutes: summary.totalDurationMinutes,
  };
}

function toChargeLineDto(line: ParkingChargeLine): ChargeLineDto {
  return {
    from: line.from.toISOString(),
    to: line.to.toISOString(),
    kind: line.kind,
    amountKopecks: line.amountKopecks,
  };
}

export function toChargeLines(lines: ParkingChargeLine[]): ChargeLineDto[] {
  return lines.map(toChargeLineDto);
}

function toNextChargeDto(charge: NextCharge | null): NextChargeDto | null {
  return charge
    ? {
        startsAt: charge.startsAt.toISOString(),
        endsAt: charge.endsAt.toISOString(),
        amountKopecks: charge.amountKopecks,
      }
    : null;
}

export function toSessionDto(view: SessionView): ParkingSessionDto {
  return {
    id: view.id,
    source: view.source,
    status: view.status,
    plate: view.plate,
    plateDisplay: view.plateDisplay,
    zone: view.zone,
    level: view.level,
    spot: view.spot,
    enteredAt: view.enteredAt.toISOString(),
    exitedAt: iso(view.exitedAt),
    freeUntil: view.freeUntil.toISOString(),
    amountDueKopecks: view.amountDueKopecks,
    amountPaidKopecks: view.amountPaidKopecks,
    currentHourEndsAt: view.currentHourEndsAt.toISOString(),
    nextCharge: toNextChargeDto(view.nextCharge),
    paidUntil: iso(view.paidUntil),
    stayTotalKopecks: view.stayTotalKopecks,
    durationMinutes: view.durationMinutes,
    breakdown: toChargeLines(view.breakdown),
    closedReason: view.closedReason,
    lastSyncedAt: iso(view.lastSyncedAt),
    lastSyncedAtLabel: view.lastSyncedAtLabel,
    freeExitUntil: iso(view.freeExitUntil),
    payNow: view.payNow
      ? {
          amountKopecks: view.payNow.amountKopecks,
          paidUntil: view.payNow.paidUntil.toISOString(),
          includesNextHour: view.payNow.includesNextHour,
        }
      : null,
    presenceConfirmedAt: iso(view.presenceConfirmedAt),
    disputedAt: iso(view.disputedAt),
    payments: view.payments.map((payment) => ({
      id: payment.id,
      amountKopecks: payment.amountKopecks,
      paidAt: iso(payment.paidAt),
      paidUntil: iso(payment.paidUntil),
      status: payment.status,
    })),
  };
}

function toRestrictedDto(view: RestrictedSessionView | null): RestrictedSessionDto | null {
  return view
    ? {
        vehicleId: view.vehicleId,
        plate: view.plate,
        plateDisplay: view.plateDisplay,
        amountDueKopecks: view.amountDueKopecks,
        paidUntil: iso(view.paidUntil),
      }
    : null;
}

function toAirRaidDto(view: AirRaidView): AirRaidDto {
  return {
    active: view.active,
    startedAt: iso(view.startedAt),
    freeExitUntil: iso(view.freeExitUntil),
    freeExitOpen: view.freeExitOpen,
  };
}

export function toHeroDto(hero: ParkingHero): ParkingHeroDto {
  return {
    mode: hero.mode,
    heroState: hero.heroState,
    actions: hero.actions,
    serverTime: hero.serverTime.toISOString(),
    infoModeEnabled: hero.infoModeEnabled,
    providerAvailable: hero.providerAvailable,
    defaultVehicle: hero.defaultVehicle ? toVehicleDto(hero.defaultVehicle) : null,
    vehicles: hero.vehicles.map(toVehicleDto),
    session: hero.session ? toSessionDto(hero.session) : null,
    restricted: toRestrictedDto(hero.restricted),
    lookupQuota: hero.lookupQuota
      ? {
          limit: hero.lookupQuota.limit,
          remaining: hero.lookupQuota.remaining,
          resetAt: hero.lookupQuota.resetAt.toISOString(),
        }
      : null,
    airRaid: toAirRaidDto(hero.airRaid),
    notices: hero.notices,
    tariffVersion: hero.tariffVersion,
  };
}

export function toHistoryItemDto(item: HistoryItem): ParkingHistoryItemDto {
  return {
    id: item.id,
    source: item.source,
    status: item.status,
    plate: item.plate,
    plateDisplay: item.plateDisplay,
    zone: item.zone,
    enteredAt: item.enteredAt.toISOString(),
    exitedAt: iso(item.exitedAt),
    paidUntil: iso(item.paidUntil),
    durationMinutes: item.durationMinutes,
    amountPaidKopecks: item.amountPaidKopecks,
    stayTotalKopecks: item.stayTotalKopecks,
    closedReason: item.closedReason,
    paidVia: item.paidVia,
    paymentIds: item.paymentIds,
    disputed: item.disputed,
  };
}
