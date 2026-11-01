import type { ParkingTariffConfig, ParkingZone } from '../../../common/contracts/parking';
import { kyivMinutesOfDay, parseHHmm } from '../../../common/time/kyiv';
import { parseHoursRange } from './tariff';

/**
 * Banners for the parking screen (design brief 4.3), one at a time, highest priority first:
 * - `air_raid`: «Повітряна тривога. В'їзд закрито, виїзд безкоштовний перші 30 хвилин»;
 * - `underground_closed`: active underground session after closing time (21:00);
 * - `underground_closing_soon`: active underground session in the last 30 minutes before closing;
 * - `night_tariff_soon`: any active session in the 30 minutes before the night window (23:30).
 */
export const PARKING_NOTICES = [
  'air_raid',
  'underground_closed',
  'underground_closing_soon',
  'night_tariff_soon',
] as const;
export type ParkingNotice = (typeof PARKING_NOTICES)[number];

export const NOTICE_LEAD_MINUTES = 30;

const DAY_MINUTES = 24 * 60;

function minutesOf(hhmm: string): number {
  const { hours, minutes } = parseHHmm(hhmm);
  return hours * 60 + minutes;
}

/** True when `current` lies in [from, to) on a 24-hour circle. */
function inWindow(current: number, from: number, to: number): boolean {
  const start = ((from % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const end = ((to % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  if (start === end) {
    return false;
  }
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function parkingNotices(input: {
  now: Date;
  tariff: ParkingTariffConfig;
  airRaidActive: boolean;
  /** The zone of the active session, or null when there is none. */
  activeZone: ParkingZone | null;
}): ParkingNotice[] {
  const notices: ParkingNotice[] = [];
  if (input.airRaidActive) {
    notices.push('air_raid');
  }
  if (!input.activeZone) {
    return notices;
  }
  const current = kyivMinutesOfDay(input.now);
  if (input.activeZone === 'underground') {
    const hours = parseHoursRange(input.tariff.undergroundHours);
    if (hours) {
      const open = minutesOf(hours.from);
      const close = minutesOf(hours.to);
      if (inWindow(current, close, open)) {
        notices.push('underground_closed');
      } else if (inWindow(current, close - NOTICE_LEAD_MINUTES, close)) {
        notices.push('underground_closing_soon');
      }
    }
  }
  const night = minutesOf(input.tariff.nightWindow.from);
  if (inWindow(current, night - NOTICE_LEAD_MINUTES, night)) {
    notices.push('night_tariff_soon');
  }
  return notices;
}
