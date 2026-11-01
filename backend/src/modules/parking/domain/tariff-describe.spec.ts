import { DEFAULT_PARKING_TARIFF } from '../../../common/contracts/parking';
import { describeTariff, hourPriceAt } from './tariff-describe';

describe('describeTariff', () => {
  it('renders the operator rules in canonical Ukrainian lines', () => {
    const description = describeTariff(DEFAULT_PARKING_TARIFF);
    expect(description.lines.map((line) => `${line.label} — ${line.price}`)).toEqual([
      '0–30 хв — безкоштовно',
      '31–60 хв — 20 ₴',
      'далі — 40 ₴/год',
      '00:00–05:00 — 500 ₴/год',
      'Втрата талона — 500 ₴',
    ]);
    expect(description.rules).toBe('Виїзд — до кінця оплаченої години. Втрата талона — 500 ₴');
    expect(description.hours).toEqual({ underground: '08:00–21:00', surface: '05:00–00:00' });
    expect(description.hoursLine).toBe('Підземний 08:00–21:00 · Наземний 05:00–00:00');
    expect(description.airRaid).toBe(
      "Повітряна тривога: в'їзд закрито, виїзд у перші 30 хв вільний",
    );
  });

  it('follows an edited tariff', () => {
    const description = describeTariff(
      { ...DEFAULT_PARKING_TARIFF, freeMinutes: 15, firstHourKopecks: 2550, exitGraceMinutes: 10 },
      20,
    );
    expect(description.lines[0]?.label).toBe('0–15 хв');
    expect(description.lines[1]).toMatchObject({ label: '16–60 хв', price: '25,50 ₴' });
    expect(description.rules).toContain('(+10 хв на виїзд)');
    expect(description.airRaid).toContain('перші 20 хв');
  });

  it('omits the free line when there are no free minutes', () => {
    const description = describeTariff({ ...DEFAULT_PARKING_TARIFF, freeMinutes: 0 });
    expect(description.lines[0]?.kind).toBe('first_hour');
  });

  it('prices the next hour by its start (night window)', () => {
    expect(hourPriceAt(new Date('2026-01-15T16:00:00+02:00'), DEFAULT_PARKING_TARIFF)).toBe(4000);
    expect(hourPriceAt(new Date('2026-01-16T00:00:00+02:00'), DEFAULT_PARKING_TARIFF)).toBe(50_000);
    expect(hourPriceAt(new Date('2026-01-16T05:00:00+02:00'), DEFAULT_PARKING_TARIFF)).toBe(4000);
  });
});
