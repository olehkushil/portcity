import type {
  ParkingChargeLine,
  ParkingQuote,
  ParkingTariffConfig,
} from '../../../common/contracts/parking';
import { isWithinKyivWindow } from '../../../common/time/kyiv';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

/**
 * Number of started hours in `elapsedMs`: a new hour starts strictly after the previous one
 * ended, so 60:00 is one hour and 60:01 is two (brief section 7).
 */
export function startedHours(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return 0;
  }
  return Math.ceil(elapsedMs / HOUR_MS);
}

/** True when a started hour beginning at `start` is priced at the night rate (Kyiv wall clock). */
export function isNightHour(start: Date, tariff: ParkingTariffConfig): boolean {
  return isWithinKyivWindow(start, tariff.nightWindow.from, tariff.nightWindow.to);
}

/**
 * Parking tariff calculator (brief section 7).
 *
 * - the first `freeMinutes` are free;
 * - the remainder of the first hour costs `firstHourKopecks`;
 * - every further started hour costs `nextHourKopecks`;
 * - any started hour whose start falls inside the night window costs `nightWindow.hourKopecks`;
 * - a paid session is valid until `paidUntil` (plus `exitGraceMinutes`); after that every
 *   started hour counted from `paidUntil` is an overstay hour priced like a further hour.
 *
 * `now` before `enteredAt` is treated as `enteredAt` (clock skew between systems).
 */
export function quote(
  enteredAt: Date,
  now: Date,
  tariff: ParkingTariffConfig,
  paidUntil?: Date | null,
): ParkingQuote {
  const entered = enteredAt.getTime();
  const nowMs = Math.max(now.getTime(), entered);
  const freeUntil = new Date(entered + tariff.freeMinutes * MINUTE_MS);

  if (paidUntil && paidUntil.getTime() >= entered) {
    return overstayQuote(paidUntil, nowMs, freeUntil, tariff);
  }

  const elapsed = nowMs - entered;
  const breakdown: ParkingChargeLine[] = [];
  if (tariff.freeMinutes > 0) {
    breakdown.push({ from: enteredAt, to: freeUntil, kind: 'free', amountKopecks: 0 });
  }
  if (elapsed <= tariff.freeMinutes * MINUTE_MS) {
    return {
      amountDueKopecks: 0,
      freeUntil,
      currentHourEndsAt: new Date(entered + HOUR_MS),
      breakdown,
    };
  }

  const hours = startedHours(elapsed);
  let amountDueKopecks = 0;
  for (let index = 0; index < hours; index += 1) {
    const from = new Date(entered + index * HOUR_MS);
    const to = new Date(entered + (index + 1) * HOUR_MS);
    const night = isNightHour(from, tariff);
    if (index === 0) {
      const chargedFrom = freeUntil.getTime() > from.getTime() ? freeUntil : from;
      if (chargedFrom.getTime() >= to.getTime()) {
        continue;
      }
      const amountKopecks = night ? tariff.nightWindow.hourKopecks : tariff.firstHourKopecks;
      breakdown.push({
        from: chargedFrom,
        to,
        kind: night ? 'night' : 'first_hour',
        amountKopecks,
      });
      amountDueKopecks += amountKopecks;
      continue;
    }
    const amountKopecks = night ? tariff.nightWindow.hourKopecks : tariff.nextHourKopecks;
    breakdown.push({ from, to, kind: night ? 'night' : 'hour', amountKopecks });
    amountDueKopecks += amountKopecks;
  }

  return {
    amountDueKopecks,
    freeUntil,
    currentHourEndsAt: new Date(entered + hours * HOUR_MS),
    breakdown,
  };
}

function overstayQuote(
  paidUntil: Date,
  nowMs: number,
  freeUntil: Date,
  tariff: ParkingTariffConfig,
): ParkingQuote {
  const paidMs = paidUntil.getTime();
  const graceEndsAt = paidMs + Math.max(0, tariff.exitGraceMinutes) * MINUTE_MS;
  if (nowMs <= graceEndsAt) {
    return { amountDueKopecks: 0, freeUntil, currentHourEndsAt: paidUntil, breakdown: [] };
  }
  const hours = startedHours(nowMs - paidMs);
  const breakdown: ParkingChargeLine[] = [];
  let amountDueKopecks = 0;
  for (let index = 0; index < hours; index += 1) {
    const from = new Date(paidMs + index * HOUR_MS);
    const to = new Date(paidMs + (index + 1) * HOUR_MS);
    const night = isNightHour(from, tariff);
    const amountKopecks = night ? tariff.nightWindow.hourKopecks : tariff.nextHourKopecks;
    breakdown.push({ from, to, kind: night ? 'night' : 'hour', amountKopecks });
    amountDueKopecks += amountKopecks;
  }
  return {
    amountDueKopecks,
    freeUntil,
    currentHourEndsAt: new Date(paidMs + hours * HOUR_MS),
    breakdown,
  };
}

/** Parses `HH:mm-HH:mm` opening hours into minutes of day; `24:00` is accepted as the end. */
export function parseHoursRange(value: string): { from: string; to: string } | null {
  const match = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  return { from: match[1] ?? '', to: match[2] ?? '' };
}
