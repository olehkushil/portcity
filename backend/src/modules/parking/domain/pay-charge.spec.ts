import { DEFAULT_PARKING_TARIFF } from '../../../common/contracts/parking';
import { payCharge } from './pay-charge';
import { quote } from './tariff';

const t = (hhmm: string, day = '2026-01-15'): Date => new Date(`${day}T${hhmm}:00.000+02:00`);

function chargeAt(
  now: string,
  options: { paidUntil?: Date; minutes?: number; entered?: Date } = {},
) {
  const entered = options.entered ?? t('14:00');
  const at = t(now);
  return payCharge(
    quote(entered, at, DEFAULT_PARKING_TARIFF, options.paidUntil ?? null),
    at,
    DEFAULT_PARKING_TARIFF,
    options.minutes ?? 5,
  );
}

describe('payCharge (end of the hour rule)', () => {
  it.each([
    // [now, amount, paid until, includes next hour]
    ['14:20', null, null, null],
    ['15:20', 6000, '16:00', false],
    ['15:55', 6000, '16:00', false],
    ['15:56', 10_000, '17:00', true],
    ['15:59', 10_000, '17:00', true],
    // The first paid hour: 20 UAH; at 14:57 the next hour (40 UAH) is included.
    ['14:57', 6000, '16:00', true],
    ['14:54', 2000, '15:00', false],
  ] as const)('at %s charges %s until %s (next hour %s)', (now, amount, until, next) => {
    const charge = chargeAt(now);
    if (amount === null) {
      expect(charge).toBeNull();
      return;
    }
    expect(charge).toMatchObject({ amountKopecks: amount, includesNextHour: next });
    expect(charge?.paidUntil).toEqual(t(until as string));
  });

  it('adds the next hour as a breakdown line, at the night price when it starts at night', () => {
    const late = payCharge(
      quote(t('22:00'), t('23:57'), DEFAULT_PARKING_TARIFF),
      t('23:57'),
      DEFAULT_PARKING_TARIFF,
    );
    expect(late?.includesNextHour).toBe(true);
    expect(late?.breakdown.at(-1)).toMatchObject({
      from: t('00:00', '2026-01-16'),
      to: t('01:00', '2026-01-16'),
      kind: 'night',
      amountKopecks: 50_000,
    });
    expect(late?.amountKopecks).toBe(6000 + 50_000);
  });

  it('works for an overstay and can be switched off', () => {
    expect(chargeAt('16:57', { paidUntil: t('16:00') })).toMatchObject({
      amountKopecks: 8000,
      includesNextHour: true,
    });
    expect(chargeAt('16:57', { paidUntil: t('16:00'), minutes: 0 })).toMatchObject({
      amountKopecks: 4000,
      includesNextHour: false,
    });
    expect(chargeAt('15:30', { paidUntil: t('16:00') })).toBeNull();
  });
});
