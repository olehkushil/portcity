import type { ParkingChargeLine, ParkingTariffConfig } from '../../../common/contracts/parking';
import { HOUR_MS, MINUTE_MS, isNightHour } from './tariff';

/** Default of PARKING_PAY_MIN_MINUTES_LEFT. */
export const DEFAULT_PAY_MIN_MINUTES_LEFT = 5;

/** What «Сплатити» charges right now and the exit deadline it buys. */
export interface PayCharge {
  amountKopecks: number;
  /** Exit deadline after this payment. */
  paidUntil: Date;
  /** True when the next hour is included because the running one ends in a few minutes. */
  includesNextHour: boolean;
  breakdown: ParkingChargeLine[];
}

/**
 * End of the hour rule: paying a few minutes before the running hour ends would buy almost
 * nothing (the exit deadline is the end of that hour, the operator closes the barrier at it).
 * When less than `minMinutesLeft` remain, the next hour is charged as well and the deadline
 * moves one hour later. `minMinutesLeft = 0` switches the rule off. Null when nothing is due.
 */
export function payCharge(
  quote: { amountDueKopecks: number; currentHourEndsAt: Date; breakdown: ParkingChargeLine[] },
  now: Date,
  tariff: ParkingTariffConfig,
  minMinutesLeft: number = DEFAULT_PAY_MIN_MINUTES_LEFT,
): PayCharge | null {
  if (quote.amountDueKopecks <= 0) {
    return null;
  }
  const leftMs = quote.currentHourEndsAt.getTime() - now.getTime();
  if (minMinutesLeft <= 0 || leftMs >= minMinutesLeft * MINUTE_MS) {
    return {
      amountKopecks: quote.amountDueKopecks,
      paidUntil: quote.currentHourEndsAt,
      includesNextHour: false,
      breakdown: quote.breakdown,
    };
  }
  const from = quote.currentHourEndsAt;
  const to = new Date(from.getTime() + HOUR_MS);
  const night = isNightHour(from, tariff);
  const nextHourKopecks = night ? tariff.nightWindow.hourKopecks : tariff.nextHourKopecks;
  return {
    amountKopecks: quote.amountDueKopecks + nextHourKopecks,
    paidUntil: to,
    includesNextHour: true,
    breakdown: [
      ...quote.breakdown,
      { from, to, kind: night ? 'night' : 'hour', amountKopecks: nextHourKopecks },
    ],
  };
}
