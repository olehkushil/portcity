import {
  DEFAULT_PARKING_TARIFF,
  type ParkingChargeKind,
  type ParkingTariffConfig,
} from '../../../common/contracts/parking';
import { HOUR_MS, MINUTE_MS, isNightHour, parseHoursRange, quote, startedHours } from './tariff';

/** 2026-01-15 14:12 Kyiv (winter, UTC+2). */
const ENTERED = new Date('2026-01-15T12:12:00.000Z');
const minutes = (count: number): number => count * MINUTE_MS;
const at = (base: Date, offsetMs: number): Date => new Date(base.getTime() + offsetMs);

interface Case {
  name: string;
  enteredAt: Date;
  now: Date;
  paidUntil?: Date | null;
  tariff?: ParkingTariffConfig;
  amountDueKopecks: number;
  currentHourEndsAt: Date;
  kinds: ParkingChargeKind[];
}

const CASES: Case[] = [
  {
    name: '10 min: free',
    enteredAt: ENTERED,
    now: at(ENTERED, minutes(10)),
    amountDueKopecks: 0,
    currentHourEndsAt: at(ENTERED, HOUR_MS),
    kinds: ['free'],
  },
  {
    name: '30 min: still free',
    enteredAt: ENTERED,
    now: at(ENTERED, minutes(30)),
    amountDueKopecks: 0,
    currentHourEndsAt: at(ENTERED, HOUR_MS),
    kinds: ['free'],
  },
  {
    name: '31 min: first hour 20 UAH',
    enteredAt: ENTERED,
    now: at(ENTERED, minutes(31)),
    amountDueKopecks: 2000,
    currentHourEndsAt: at(ENTERED, HOUR_MS),
    kinds: ['free', 'first_hour'],
  },
  {
    name: '59 min: first hour 20 UAH',
    enteredAt: ENTERED,
    now: at(ENTERED, minutes(59)),
    amountDueKopecks: 2000,
    currentHourEndsAt: at(ENTERED, HOUR_MS),
    kinds: ['free', 'first_hour'],
  },
  {
    name: '60 min: still the first hour',
    enteredAt: ENTERED,
    now: at(ENTERED, minutes(60)),
    amountDueKopecks: 2000,
    currentHourEndsAt: at(ENTERED, HOUR_MS),
    kinds: ['free', 'first_hour'],
  },
  {
    name: '61 min: second hour started, 60 UAH',
    enteredAt: ENTERED,
    now: at(ENTERED, minutes(61)),
    amountDueKopecks: 6000,
    currentHourEndsAt: at(ENTERED, 2 * HOUR_MS),
    kinds: ['free', 'first_hour', 'hour'],
  },
  {
    name: '2 h 05: three started hours, 100 UAH',
    enteredAt: ENTERED,
    now: at(ENTERED, minutes(125)),
    amountDueKopecks: 10_000,
    currentHourEndsAt: at(ENTERED, 3 * HOUR_MS),
    kinds: ['free', 'first_hour', 'hour', 'hour'],
  },
  {
    name: 'overnight 23:30 -> 01:10: second hour at the night rate',
    enteredAt: new Date('2026-01-15T21:30:00.000Z'),
    now: new Date('2026-01-15T23:10:00.000Z'),
    amountDueKopecks: 2000 + 50_000,
    currentHourEndsAt: new Date('2026-01-15T23:30:00.000Z'),
    kinds: ['free', 'first_hour', 'night'],
  },
  {
    name: 'entered at night: the first charged hour is a night hour',
    enteredAt: new Date('2026-01-15T22:30:00.000Z'),
    now: new Date('2026-01-15T23:15:00.000Z'),
    amountDueKopecks: 50_000,
    currentHourEndsAt: new Date('2026-01-15T23:30:00.000Z'),
    kinds: ['free', 'night'],
  },
  {
    name: 'paid until 16:12, now 16:00: nothing due',
    enteredAt: ENTERED,
    now: at(ENTERED, minutes(108)),
    paidUntil: at(ENTERED, 2 * HOUR_MS),
    amountDueKopecks: 0,
    currentHourEndsAt: at(ENTERED, 2 * HOUR_MS),
    kinds: [],
  },
  {
    name: 'paid until 16:12, now exactly 16:12: nothing due',
    enteredAt: ENTERED,
    now: at(ENTERED, 2 * HOUR_MS),
    paidUntil: at(ENTERED, 2 * HOUR_MS),
    amountDueKopecks: 0,
    currentHourEndsAt: at(ENTERED, 2 * HOUR_MS),
    kinds: [],
  },
  {
    name: 'paid then overstay 28 min: one more hour, 40 UAH',
    enteredAt: ENTERED,
    now: at(ENTERED, 2 * HOUR_MS + minutes(28)),
    paidUntil: at(ENTERED, 2 * HOUR_MS),
    amountDueKopecks: 4000,
    currentHourEndsAt: at(ENTERED, 3 * HOUR_MS),
    kinds: ['hour'],
  },
  {
    name: 'paid then overstay 61 min: two more hours, 80 UAH',
    enteredAt: ENTERED,
    now: at(ENTERED, 3 * HOUR_MS + minutes(1)),
    paidUntil: at(ENTERED, 2 * HOUR_MS),
    amountDueKopecks: 8000,
    currentHourEndsAt: at(ENTERED, 4 * HOUR_MS),
    kinds: ['hour', 'hour'],
  },
  {
    name: 'exit grace 10 min: 8 minutes after paidUntil is still free',
    enteredAt: ENTERED,
    now: at(ENTERED, 2 * HOUR_MS + minutes(8)),
    paidUntil: at(ENTERED, 2 * HOUR_MS),
    tariff: { ...DEFAULT_PARKING_TARIFF, exitGraceMinutes: 10 },
    amountDueKopecks: 0,
    currentHourEndsAt: at(ENTERED, 2 * HOUR_MS),
    kinds: [],
  },
  {
    name: 'exit grace 10 min: 11 minutes after paidUntil counts from paidUntil',
    enteredAt: ENTERED,
    now: at(ENTERED, 2 * HOUR_MS + minutes(11)),
    paidUntil: at(ENTERED, 2 * HOUR_MS),
    tariff: { ...DEFAULT_PARKING_TARIFF, exitGraceMinutes: 10 },
    amountDueKopecks: 4000,
    currentHourEndsAt: at(ENTERED, 3 * HOUR_MS),
    kinds: ['hour'],
  },
  {
    name: 'DST day 2026-03-29: 01:30 EET -> 05:30 EEST is three night hours',
    enteredAt: new Date('2026-03-28T23:30:00.000Z'),
    now: new Date('2026-03-29T02:30:00.000Z'),
    amountDueKopecks: 150_000,
    currentHourEndsAt: new Date('2026-03-29T02:30:00.000Z'),
    kinds: ['free', 'night', 'night', 'night'],
  },
  {
    name: 'DST day 2026-03-29: 02:30 EET -> 05:31 EEST, third hour starts after the window',
    enteredAt: new Date('2026-03-29T00:30:00.000Z'),
    now: new Date('2026-03-29T02:31:00.000Z'),
    amountDueKopecks: 50_000 + 50_000 + 4000,
    currentHourEndsAt: new Date('2026-03-29T03:30:00.000Z'),
    kinds: ['free', 'night', 'night', 'hour'],
  },
  {
    name: 'now before enteredAt (clock skew): free',
    enteredAt: ENTERED,
    now: at(ENTERED, -minutes(5)),
    amountDueKopecks: 0,
    currentHourEndsAt: at(ENTERED, HOUR_MS),
    kinds: ['free'],
  },
  {
    name: 'no free minutes: the first minute is charged',
    enteredAt: ENTERED,
    now: at(ENTERED, minutes(1)),
    tariff: { ...DEFAULT_PARKING_TARIFF, freeMinutes: 0 },
    amountDueKopecks: 2000,
    currentHourEndsAt: at(ENTERED, HOUR_MS),
    kinds: ['first_hour'],
  },
  {
    name: 'first hour fully free (freeMinutes 60): 61 min charges one further hour',
    enteredAt: ENTERED,
    now: at(ENTERED, minutes(61)),
    tariff: { ...DEFAULT_PARKING_TARIFF, freeMinutes: 60 },
    amountDueKopecks: 4000,
    currentHourEndsAt: at(ENTERED, 2 * HOUR_MS),
    kinds: ['free', 'hour'],
  },
];

describe('quote', () => {
  it.each(CASES.map((item) => [item.name, item] as const))('%s', (_name, item) => {
    const result = quote(
      item.enteredAt,
      item.now,
      item.tariff ?? DEFAULT_PARKING_TARIFF,
      item.paidUntil,
    );
    expect(result.amountDueKopecks).toBe(item.amountDueKopecks);
    expect(result.currentHourEndsAt.toISOString()).toBe(item.currentHourEndsAt.toISOString());
    expect(result.breakdown.map((line) => line.kind)).toEqual(item.kinds);
    expect(result.breakdown.reduce((sum, line) => sum + line.amountKopecks, 0)).toBe(
      item.amountDueKopecks,
    );
    expect(result.freeUntil.getTime()).toBe(
      item.enteredAt.getTime() + (item.tariff ?? DEFAULT_PARKING_TARIFF).freeMinutes * MINUTE_MS,
    );
  });

  it('produces contiguous breakdown lines', () => {
    const result = quote(ENTERED, at(ENTERED, minutes(125)), DEFAULT_PARKING_TARIFF);
    for (let index = 1; index < result.breakdown.length; index += 1) {
      const previous = result.breakdown[index - 1];
      const current = result.breakdown[index];
      expect(current?.from.getTime()).toBe(previous?.to.getTime());
    }
    expect(result.breakdown[0]?.from.toISOString()).toBe(ENTERED.toISOString());
    expect(result.breakdown.at(-1)?.to.toISOString()).toBe(result.currentHourEndsAt.toISOString());
  });

  it('reproduces the prototype timeline: 14:12 entry, 60 UAH due at 15:20', () => {
    const result = quote(ENTERED, new Date('2026-01-15T13:20:00.000Z'), DEFAULT_PARKING_TARIFF);
    expect(result.amountDueKopecks).toBe(6000);
    expect(result.freeUntil.toISOString()).toBe('2026-01-15T12:42:00.000Z');
  });
});

describe('startedHours', () => {
  it.each([
    [0, 0],
    [-1, 0],
    [1, 1],
    [HOUR_MS, 1],
    [HOUR_MS + 1, 2],
    [3 * HOUR_MS, 3],
    [Number.NaN, 0],
  ])('%p ms -> %p hours', (elapsed, hours) => {
    expect(startedHours(elapsed)).toBe(hours);
  });
});

describe('isNightHour', () => {
  it.each([
    ['2026-01-15T21:59:00.000Z', false], // 23:59 Kyiv
    ['2026-01-15T22:00:00.000Z', true], // 00:00 Kyiv
    ['2026-01-16T02:59:00.000Z', true], // 04:59 Kyiv
    ['2026-01-16T03:00:00.000Z', false], // 05:00 Kyiv
    ['2026-07-15T21:00:00.000Z', true], // 00:00 Kyiv in summer (UTC+3)
    ['2026-07-15T20:59:00.000Z', false],
  ])('%s -> %p', (iso, expected) => {
    expect(isNightHour(new Date(iso), DEFAULT_PARKING_TARIFF)).toBe(expected);
  });
});

describe('parseHoursRange', () => {
  it('parses opening hours', () => {
    expect(parseHoursRange('08:00-21:00')).toEqual({ from: '08:00', to: '21:00' });
    expect(parseHoursRange('05:00-24:00')).toEqual({ from: '05:00', to: '24:00' });
  });

  it('rejects garbage', () => {
    expect(parseHoursRange('all day')).toBeNull();
    expect(parseHoursRange('08:00')).toBeNull();
  });
});
