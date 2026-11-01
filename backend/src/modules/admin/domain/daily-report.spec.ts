import { DomainError } from '../../../common/errors/domain-error';
import {
  type AdjustmentRowForStats,
  MAX_REPORT_RANGE_DAYS,
  buildDailyReport,
  dateToDayKey,
  dayKeyToDate,
  dayKeysBetween,
  emptyAdjustmentStats,
  isDailyReport,
  isValidDayKey,
  kyivDayRange,
  parseDayKey,
  previousKyivDay,
  shiftDayKey,
  summariseAdjustments,
} from './daily-report';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return DomainError.is(error) ? error.code : `not-a-domain-error: ${String(error)}`;
  }
}

describe('day keys', () => {
  it.each<[unknown, boolean]>([
    ['2026-01-15', true],
    ['2026-02-28', true],
    ['2024-02-29', true],
    ['2026-02-29', false],
    ['2026-02-30', false],
    ['2026-13-01', false],
    ['2026-00-10', false],
    ['2026-1-5', false],
    ['20260115', false],
    ['2026-01-15T00:00:00Z', false],
    ['1999-12-31', false],
    ['', false],
    [20260115, false],
    [null, false],
  ])('%p is a valid day key: %s', (day, expected) => {
    expect(isValidDayKey(day)).toBe(expected);
  });

  it('parses components', () => {
    expect(parseDayKey('2026-10-30')).toEqual({ year: 2026, month: 10, dayOfMonth: 30 });
    expect(parseDayKey('garbage')).toBeNull();
  });

  it('round-trips through the DATE column representation', () => {
    expect(dayKeyToDate('2026-10-30').toISOString()).toBe('2026-10-30T00:00:00.000Z');
    expect(dateToDayKey(new Date('2026-10-30T00:00:00.000Z'))).toBe('2026-10-30');
  });
});

describe('kyivDayRange', () => {
  it.each<[string, string, string, number]>([
    ['2026-01-15', '2026-01-14T22:00:00.000Z', '2026-01-15T22:00:00.000Z', 24],
    ['2026-07-01', '2026-06-30T21:00:00.000Z', '2026-07-01T21:00:00.000Z', 24],
    // last Sunday of March: clocks jump 03:00 -> 04:00, the day has 23 hours
    ['2026-03-29', '2026-03-28T22:00:00.000Z', '2026-03-29T21:00:00.000Z', 23],
    // last Sunday of October: clocks fall back, the day has 25 hours
    ['2026-10-25', '2026-10-24T21:00:00.000Z', '2026-10-25T22:00:00.000Z', 25],
  ])('%s covers [%s, %s) = %d hours', (day, from, to, hours) => {
    const range = kyivDayRange(day);
    expect(range.from.toISOString()).toBe(from);
    expect(range.to.toISOString()).toBe(to);
    expect((range.to.getTime() - range.from.getTime()) / 3_600_000).toBe(hours);
  });

  it('rejects invalid days with PC_REPORT_DAY_INVALID', () => {
    expect(codeOf(() => kyivDayRange('2026-02-30'))).toBe('PC_REPORT_DAY_INVALID');
  });
});

describe('day arithmetic', () => {
  it.each<[string, string]>([
    ['2026-01-15T22:30:00.000Z', '2026-01-15'], // 00:30 Kyiv on the 16th
    ['2026-01-15T21:30:00.000Z', '2026-01-14'], // 23:30 Kyiv on the 15th
    ['2026-07-01T20:59:59.000Z', '2026-06-30'], // 23:59:59 Kyiv on July 1st
    ['2026-07-01T21:00:00.000Z', '2026-07-01'], // 00:00 Kyiv on July 2nd
  ])('previousKyivDay(%s) = %s', (now, expected) => {
    expect(previousKyivDay(new Date(now))).toBe(expected);
  });

  it.each<[string, number, string]>([
    ['2026-03-28', 1, '2026-03-29'],
    ['2026-03-29', 1, '2026-03-30'],
    ['2026-10-25', 1, '2026-10-26'],
    ['2026-01-01', -1, '2025-12-31'],
    ['2026-02-28', 1, '2026-03-01'],
    ['2026-01-15', 0, '2026-01-15'],
  ])('shiftDayKey(%s, %d) = %s', (day, days, expected) => {
    expect(shiftDayKey(day, days)).toBe(expected);
  });

  it('lists inclusive ranges and rejects reversed or oversized ones', () => {
    expect(dayKeysBetween('2026-02-27', '2026-03-02')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
    expect(dayKeysBetween('2026-05-05', '2026-05-05')).toEqual(['2026-05-05']);
    expect(dayKeysBetween('2026-01-01', '2026-04-02')).toHaveLength(MAX_REPORT_RANGE_DAYS);
    expect(codeOf(() => dayKeysBetween('2026-01-01', '2026-04-03'))).toBe('PC_REPORT_DAY_INVALID');
    expect(codeOf(() => dayKeysBetween('2026-01-02', '2026-01-01'))).toBe('PC_REPORT_DAY_INVALID');
    expect(codeOf(() => dayKeysBetween('2026-01-x', '2026-01-01'))).toBe('PC_REPORT_DAY_INVALID');
  });
});

describe('summariseAdjustments', () => {
  const range = kyivDayRange('2026-01-15');
  const inside = new Date('2026-01-15T10:00:00.000Z');
  const before = new Date('2026-01-14T10:00:00.000Z');

  const row = (overrides: Partial<AdjustmentRowForStats>): AdjustmentRowForStats => ({
    status: 'pending',
    amount: 10,
    createdAt: before,
    decidedAt: null,
    appliedAt: null,
    ...overrides,
  });

  it('starts from zeros', () => {
    expect(summariseAdjustments([], range)).toEqual(emptyAdjustmentStats());
  });

  it.each<[string, AdjustmentRowForStats, Partial<ReturnType<typeof emptyAdjustmentStats>>]>([
    ['pending request created today', row({ createdAt: inside }), { requested: 1 }],
    [
      'approved today, requested yesterday',
      row({ status: 'approved', decidedAt: inside }),
      { approved: 1 },
    ],
    [
      'requested, approved and applied today',
      row({
        status: 'applied',
        amount: 100,
        createdAt: inside,
        decidedAt: inside,
        appliedAt: inside,
      }),
      { requested: 1, approved: 1, applied: 1, appliedPoints: 100 },
    ],
    ['rejected today', row({ status: 'rejected', decidedAt: inside }), { rejected: 1 }],
    [
      'negative adjustment applied today',
      row({ status: 'applied', amount: -70, decidedAt: before, appliedAt: inside }),
      { applied: 1, appliedPoints: -70 },
    ],
    [
      'appliedAt set but status not applied is ignored',
      row({ status: 'approved', appliedAt: inside }),
      {},
    ],
    [
      'created exactly at the end of the day belongs to the next day',
      row({ createdAt: range.to }),
      {},
    ],
    [
      'created exactly at the start of the day counts',
      row({ createdAt: range.from }),
      { requested: 1 },
    ],
  ])('%s', (_name, input, expected) => {
    expect(summariseAdjustments([input], range)).toEqual({
      ...emptyAdjustmentStats(),
      ...expected,
    });
  });

  it('sums over many rows', () => {
    const rows = [
      row({ createdAt: inside }),
      row({
        status: 'applied',
        amount: 30,
        createdAt: inside,
        decidedAt: inside,
        appliedAt: inside,
      }),
      row({ status: 'applied', amount: -5, decidedAt: before, appliedAt: inside }),
      row({ status: 'rejected', decidedAt: inside }),
    ];
    expect(summariseAdjustments(rows, range)).toEqual({
      requested: 2,
      approved: 1,
      applied: 2,
      rejected: 1,
      appliedPoints: 25,
    });
  });
});

describe('buildDailyReport', () => {
  const range = kyivDayRange('2026-01-15');
  const sections = {
    receipts: { submitted: 3, byStatus: { credited: 2, rejected: 1 }, pointsAwarded: 90 },
    points: { earned: 90, spent: 60, expired: 0, reversed: 0 },
    vouchers: { issued: 1, redeemed: 1, live: 4 },
    parking: { opened: 12, closed: 11, paidKopecks: 24_000 },
  };

  it('marks a report complete and closed when every source answered after the day ended', () => {
    const report = buildDailyReport({
      day: '2026-01-15',
      range,
      sections,
      adjustments: emptyAdjustmentStats(),
      errors: {},
      source: 'nightly',
      computedAt: new Date('2026-01-15T22:20:00.000Z'),
    });
    expect(report).toEqual({
      day: '2026-01-15',
      range: { from: '2026-01-14T22:00:00.000Z', to: '2026-01-15T22:00:00.000Z' },
      ...sections,
      adjustments: emptyAdjustmentStats(),
      errors: {},
      complete: true,
      dayClosed: true,
      source: 'nightly',
      computedAt: '2026-01-15T22:20:00.000Z',
    });
    expect(isDailyReport(report)).toBe(true);
    expect(isDailyReport(JSON.parse(JSON.stringify(report)))).toBe(true);
  });

  it('keeps failed sections null with their error code and flags partial days', () => {
    const report = buildDailyReport({
      day: '2026-01-15',
      range,
      sections: { ...sections, parking: null },
      adjustments: emptyAdjustmentStats(),
      errors: { parking: 'PC_COMMON_NOT_IMPLEMENTED' },
      source: 'manual',
      computedAt: new Date('2026-01-15T12:00:00.000Z'),
    });
    expect(report.parking).toBeNull();
    expect(report.errors).toEqual({ parking: 'PC_COMMON_NOT_IMPLEMENTED' });
    expect(report.complete).toBe(false);
    expect(report.dayClosed).toBe(false);
    expect(report.source).toBe('manual');
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['array', []],
    [
      'missing day',
      {
        range: {},
        adjustments: {},
        errors: {},
        complete: true,
        computedAt: 'x',
        source: 'nightly',
      },
    ],
    [
      'bad source',
      {
        day: '2026-01-15',
        range: {},
        adjustments: {},
        errors: {},
        complete: true,
        computedAt: 'x',
        source: 'cron',
      },
    ],
  ])('rejects %s as a stored report', (_name, value) => {
    expect(isDailyReport(value)).toBe(false);
  });
});
