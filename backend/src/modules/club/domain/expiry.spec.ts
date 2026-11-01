import {
  addDaysToDayKey,
  bucketDayKey,
  computeExpiresAt,
  dateToDayKey,
  dayKeyToDate,
  daysBetweenDayKeys,
  expiryCutoffDayKey,
  kyivDayBounds,
  reminderTargets,
} from './expiry';

describe('computeExpiresAt', () => {
  it.each([
    ['2026-01-15T10:00:00.000Z', 12, '2027-01-15T10:00:00.000Z'],
    ['2026-01-31T10:00:00.000Z', 1, '2026-02-28T10:00:00.000Z'],
    // 31 Oct 01:30 Kyiv + 6 months clamps to 30 Apr 01:30 Kyiv (summer time), whatever the machine TZ.
    ['2026-10-30T23:30:00.000Z', 6, '2027-04-29T22:30:00.000Z'],
    // Crosses the DST switch: wall-clock time is kept (12:00 Kyiv stays 12:00 Kyiv).
    ['2026-01-15T10:00:00.000Z', 6, '2026-07-15T09:00:00.000Z'],
  ])('%s + %d months = %s', (from, months, expected) => {
    expect(computeExpiresAt(new Date(from), months).toISOString()).toBe(expected);
  });

  it.each([0, -1, 1.5])('rejects ttl %p', (months) => {
    expect(() => computeExpiresAt(new Date(), months)).toThrow(RangeError);
  });
});

describe('bucket day keys', () => {
  it.each([
    ['2027-01-15T10:00:00.000Z', '2027-01-15'],
    ['2027-01-15T22:30:00.000Z', '2027-01-16'],
    ['2027-07-15T21:30:00.000Z', '2027-07-16'],
    ['2027-07-15T20:30:00.000Z', '2027-07-15'],
  ])('%s falls into Kyiv day %s', (instant, dayKey) => {
    expect(bucketDayKey(new Date(instant))).toBe(dayKey);
  });

  it('round-trips through the @db.Date representation', () => {
    const date = dayKeyToDate('2027-01-16');
    expect(date.toISOString()).toBe('2027-01-16T00:00:00.000Z');
    expect(dateToDayKey(date)).toBe('2027-01-16');
  });

  it.each(['2027-1-16', '2027-13-01', 'garbage', ''])('rejects malformed key %p', (key) => {
    expect(() => dayKeyToDate(key)).toThrow(RangeError);
  });

  it('computes UTC bounds of a Kyiv day in winter and summer', () => {
    expect(kyivDayBounds('2027-01-16')).toEqual({
      start: new Date('2027-01-15T22:00:00.000Z'),
      end: new Date('2027-01-16T22:00:00.000Z'),
    });
    expect(kyivDayBounds('2027-07-16')).toEqual({
      start: new Date('2027-07-15T21:00:00.000Z'),
      end: new Date('2027-07-16T21:00:00.000Z'),
    });
  });

  it('crosses the DST switch without losing a day', () => {
    expect(kyivDayBounds('2027-03-28')).toEqual({
      start: new Date('2027-03-27T22:00:00.000Z'),
      end: new Date('2027-03-28T21:00:00.000Z'),
    });
    expect(addDaysToDayKey('2027-03-27', 1)).toBe('2027-03-28');
    expect(addDaysToDayKey('2027-03-27', 2)).toBe('2027-03-29');
  });

  it.each([
    ['2026-01-15', 30, '2026-02-14'],
    ['2026-01-15', 7, '2026-01-22'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-03-01', -1, '2026-02-28'],
  ])('%s + %d days = %s', (key, days, expected) => {
    expect(addDaysToDayKey(key, days)).toBe(expected);
    expect(daysBetweenDayKeys(key, expected)).toBe(days);
  });
});

describe('reminderTargets', () => {
  it('maps configured days to calendar days, de-duplicated and sorted descending', () => {
    expect(reminderTargets('2026-01-15', [7, 30, 7, -1, 2.5])).toEqual([
      { dayKey: '2026-02-14', daysLeft: 30 },
      { dayKey: '2026-01-22', daysLeft: 7 },
    ]);
  });

  it('returns nothing when reminders are disabled', () => {
    expect(reminderTargets('2026-01-15', [])).toEqual([]);
  });
});

describe('expiryCutoffDayKey', () => {
  it('is the current Kyiv day: buckets before it are due', () => {
    expect(expiryCutoffDayKey(new Date('2026-01-16T01:30:00.000Z'))).toBe('2026-01-16');
    expect(expiryCutoffDayKey(new Date('2026-01-15T22:30:00.000Z'))).toBe('2026-01-16');
  });
});
