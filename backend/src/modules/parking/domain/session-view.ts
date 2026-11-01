import type {
  ParkingChargeLine,
  ParkingSessionSource,
  ParkingSessionStatus,
  ParkingTariffConfig,
  ParkingZone,
} from '../../../common/contracts/parking';
import { formatKyiv } from '../../../common/time/kyiv';
import { type AirRaidAlert, freeExitUntil, isFreeExit } from './air-raid';
import type { SessionPaymentView } from './history';
import { DEFAULT_PAY_MIN_MINUTES_LEFT, payCharge } from './pay-charge';
import { formatPlate } from './plate';
import { deriveSessionState, isFinalStatus } from './session-state';
import { MINUTE_MS, isNightHour, quote } from './tariff';
import { hourPriceAt } from './tariff-describe';

/** The columns of `parking_sessions` the module reads (Prisma's ParkingSession is assignable). */
export interface SessionRecord {
  id: string;
  userId: string | null;
  vehicleId: string | null;
  plate: string | null;
  zone: ParkingZone;
  /** Level / row last reported by the operator (camera or spot sensor), e.g. "-2" / "C". */
  level: string | null;
  spot: string | null;
  enteredAt: Date;
  exitedAt: Date | null;
  status: ParkingSessionStatus;
  paidUntil: Date | null;
  amountDueKopecks: number;
  amountPaidKopecks: number;
  providerRef: string | null;
  source: ParkingSessionSource;
  lastSyncedAt: Date | null;
  closedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Last F7 «Так, я тут». */
  presenceConfirmedAt?: Date | null;
  /** F2 «Це не моє авто» and other disputes: hidden from the hero, no reminders. */
  disputedAt?: Date | null;
  disputeReason?: string | null;
  disputeComment?: string | null;
}

export interface SessionLocation {
  level: string | null;
  spot: string | null;
}

/**
 * Merges the operator's location report into the stored one: a snapshot without both fields
 * keeps the stored values, a snapshot with both empty clears them, anything else replaces them.
 */
export function mergeLocation(
  stored: SessionLocation,
  reported: { level?: string | null; spot?: string | null },
): SessionLocation {
  if (reported.level === undefined && reported.spot === undefined) {
    return { level: stored.level, spot: stored.spot };
  }
  return { level: reported.level || null, spot: reported.spot || null };
}

/** What will be charged next if the car stays («Затримаєтесь — 20 ₴ до 15:00», «+40 ₴»). */
export interface NextCharge {
  startsAt: Date;
  endsAt: Date;
  amountKopecks: number;
}

/** Everything the hero needs to render F2-F7 / I1-I4 (computed at `now`). */
export interface SessionView {
  id: string;
  source: ParkingSessionSource;
  status: ParkingSessionStatus;
  plate: string | null;
  plateDisplay: string | null;
  zone: ParkingZone;
  level: string | null;
  spot: string | null;
  enteredAt: Date;
  exitedAt: Date | null;
  freeUntil: Date;
  /** Due right now (0 when free, paid or closed). */
  amountDueKopecks: number;
  amountPaidKopecks: number;
  /** End of the running hour: what a payment made now buys («виїзд до»). */
  currentHourEndsAt: Date;
  nextCharge: NextCharge | null;
  paidUntil: Date | null;
  /** Total price of the stay so far by the tariff, ignoring payments (I4 «орієнтовна сума»). */
  stayTotalKopecks: number;
  durationMinutes: number;
  breakdown: ParkingChargeLine[];
  closedReason: string | null;
  lastSyncedAt: Date | null;
  /** `HH:mm` in Kyiv time for «оновлено 15:20», null for info timers. */
  lastSyncedAtLabel: string | null;
  /** Air-raid free exit deadline («Вільний виїзд до HH:MM») while an alert is on. */
  freeExitUntil: Date | null;
  /**
   * What «Сплатити» charges now (null when nothing is due): includes the next hour when the
   * running one ends in less than PARKING_PAY_MIN_MINUTES_LEFT.
   */
  payNow: { amountKopecks: number; paidUntil: Date; includesNextHour: boolean } | null;
  presenceConfirmedAt: Date | null;
  disputedAt: Date | null;
  /** App payments linked to the session (attempts included), oldest first. */
  payments: SessionPaymentView[];
}

export function nextChargeFor(
  status: ParkingSessionStatus,
  freeUntil: Date,
  currentHourEndsAt: Date,
  enteredAt: Date,
  tariff: ParkingTariffConfig,
): NextCharge | null {
  if (isFinalStatus(status)) {
    return null;
  }
  if (status === 'open') {
    const firstHourEnd = new Date(enteredAt.getTime() + 60 * MINUTE_MS);
    if (freeUntil.getTime() >= firstHourEnd.getTime()) {
      return {
        startsAt: freeUntil,
        endsAt: new Date(freeUntil.getTime() + 60 * MINUTE_MS),
        amountKopecks: hourPriceAt(freeUntil, tariff),
      };
    }
    return {
      startsAt: freeUntil,
      endsAt: firstHourEnd,
      amountKopecks: isNightHour(enteredAt, tariff)
        ? tariff.nightWindow.hourKopecks
        : tariff.firstHourKopecks,
    };
  }
  return {
    startsAt: currentHourEndsAt,
    endsAt: new Date(currentHourEndsAt.getTime() + 60 * MINUTE_MS),
    amountKopecks: hourPriceAt(currentHourEndsAt, tariff),
  };
}

/**
 * Builds the read model of a session at `now`. Active sessions are re-derived from their facts
 * (the stored amount may be up to a minute old); closed sessions keep their stored status and
 * are priced at the exit.
 */
export function buildSessionView(
  record: SessionRecord,
  context: {
    now: Date;
    tariff: ParkingTariffConfig;
    airRaid?: AirRaidAlert | null;
    /** PARKING_PAY_MIN_MINUTES_LEFT (default 5). */
    payMinMinutesLeft?: number;
    payments?: SessionPaymentView[];
  },
): SessionView {
  const { now, tariff } = context;
  const final = isFinalStatus(record.status);
  const end = final && record.exitedAt ? record.exitedAt : now;
  const facts = {
    enteredAt: record.enteredAt,
    exitedAt: final ? (record.exitedAt ?? now) : null,
    paidUntil: record.paidUntil,
    closedReason: record.closedReason,
  };
  const derived = deriveSessionState(facts, now, tariff);
  const status = final ? record.status : derived.status;
  const amountDueKopecks = final
    ? record.status === 'closed_unpaid'
      ? record.amountDueKopecks
      : 0
    : derived.quote.amountDueKopecks;
  const stay = quote(record.enteredAt, end, tariff);
  const alert = context.airRaid ?? null;
  const charge = final
    ? null
    : payCharge(
        {
          amountDueKopecks,
          currentHourEndsAt: derived.quote.currentHourEndsAt,
          breakdown: derived.quote.breakdown,
        },
        now,
        tariff,
        context.payMinMinutesLeft ?? DEFAULT_PAY_MIN_MINUTES_LEFT,
      );

  return {
    id: record.id,
    source: record.source,
    status,
    plate: record.plate,
    plateDisplay: record.plate ? formatPlate(record.plate) : null,
    zone: record.zone,
    level: record.level ?? null,
    spot: record.spot ?? null,
    enteredAt: record.enteredAt,
    exitedAt: record.exitedAt,
    freeUntil: derived.quote.freeUntil,
    amountDueKopecks,
    amountPaidKopecks: record.amountPaidKopecks,
    currentHourEndsAt: derived.quote.currentHourEndsAt,
    nextCharge: nextChargeFor(
      status,
      derived.quote.freeUntil,
      derived.quote.currentHourEndsAt,
      record.enteredAt,
      tariff,
    ),
    paidUntil: record.paidUntil,
    stayTotalKopecks: stay.amountDueKopecks,
    durationMinutes: Math.max(
      0,
      Math.floor((end.getTime() - record.enteredAt.getTime()) / MINUTE_MS),
    ),
    breakdown: final ? stay.breakdown : derived.quote.breakdown,
    closedReason: record.closedReason,
    lastSyncedAt: record.lastSyncedAt,
    lastSyncedAtLabel:
      record.source === 'provider' && record.lastSyncedAt
        ? formatKyiv(record.lastSyncedAt, 'HH:mm')
        : null,
    freeExitUntil: alert && !final && isFreeExit(alert, now) ? freeExitUntil(alert) : null,
    payNow: charge
      ? {
          amountKopecks: charge.amountKopecks,
          paidUntil: charge.paidUntil,
          includesNextHour: charge.includesNextHour,
        }
      : null,
    presenceConfirmedAt: record.presenceConfirmedAt ?? null,
    disputedAt: record.disputedAt ?? null,
    payments: context.payments ?? [],
  };
}
