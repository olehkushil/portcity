import type { ParkingTariffConfig } from '../../../common/contracts/parking';
import { formatUah } from '../../../common/money/money';
import { isNightHour, parseHoursRange } from './tariff';

/** One row of the tariff table on the parking service screen (S06). */
export interface TariffLine {
  kind: 'free' | 'first_hour' | 'hour' | 'night' | 'lost_ticket';
  label: string;
  price: string;
  amountKopecks: number;
}

export interface TariffDescription {
  lines: TariffLine[];
  /** «Виїзд — до кінця оплаченої години. Втрата талона — 500 ₴». */
  rules: string;
  hours: { underground: string; surface: string };
  /** «Підземний 08:00–21:00 · Наземний 05:00–00:00». */
  hoursLine: string;
  payment: string;
  airRaid: string;
}

const uah = (kopecks: number): string => formatUah(kopecks, { fraction: 'auto' });

/** `24:00` is printed as `00:00`, the dash is an en dash (canon microcopy). */
function displayRange(range: string): string {
  const parsed = parseHoursRange(range);
  if (!parsed) {
    return range;
  }
  const end = parsed.to === '24:00' ? '00:00' : parsed.to;
  return `${parsed.from}–${end}`;
}

/**
 * Human-readable tariff built from the active config, so the app never hard-codes prices
 * (design brief S06): «0–30 хв — безкоштовно», «31–60 хв — 20 ₴», «далі — 40 ₴/год»,
 * «00:00–05:00 — 500 ₴/год», «Втрата талона — 500 ₴».
 */
export function describeTariff(
  tariff: ParkingTariffConfig,
  airRaidFreeExitMinutes = 30,
): TariffDescription {
  const free = tariff.freeMinutes;
  const lines: TariffLine[] = [];
  if (free > 0) {
    lines.push({ kind: 'free', label: `0–${free} хв`, price: 'безкоштовно', amountKopecks: 0 });
  }
  if (free < 60) {
    lines.push({
      kind: 'first_hour',
      label: `${free + 1}–60 хв`,
      price: uah(tariff.firstHourKopecks),
      amountKopecks: tariff.firstHourKopecks,
    });
  }
  lines.push({
    kind: 'hour',
    label: 'далі',
    price: `${uah(tariff.nextHourKopecks)}/год`,
    amountKopecks: tariff.nextHourKopecks,
  });
  lines.push({
    kind: 'night',
    label: `${tariff.nightWindow.from}–${tariff.nightWindow.to}`,
    price: `${uah(tariff.nightWindow.hourKopecks)}/год`,
    amountKopecks: tariff.nightWindow.hourKopecks,
  });
  lines.push({
    kind: 'lost_ticket',
    label: 'Втрата талона',
    price: uah(tariff.lostTicketKopecks),
    amountKopecks: tariff.lostTicketKopecks,
  });

  const underground = displayRange(tariff.undergroundHours);
  const surface = displayRange(tariff.surfaceHours);
  const grace = tariff.exitGraceMinutes > 0 ? ` (+${tariff.exitGraceMinutes} хв на виїзд)` : '';
  return {
    lines,
    rules: `Виїзд — до кінця оплаченої години${grace}. Втрата талона — ${uah(tariff.lostTicketKopecks)}`,
    hours: { underground, surface },
    hoursLine: `Підземний ${underground} · Наземний ${surface}`,
    payment: 'Оплата — у застосунку або в паркоматі (картка чи NFC)',
    airRaid: `Повітряна тривога: в'їзд закрито, виїзд у перші ${airRaidFreeExitMinutes} хв вільний`,
  };
}

/** Price of the hour that starts at `start` («Наступна година почнеться о 16:00 (+40 ₴)»). */
export function hourPriceAt(start: Date, tariff: ParkingTariffConfig): number {
  return isNightHour(start, tariff) ? tariff.nightWindow.hourKopecks : tariff.nextHourKopecks;
}
