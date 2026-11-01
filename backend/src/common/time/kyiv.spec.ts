import {
  addKyivDays,
  endOfKyivDay,
  formatKyiv,
  isWithinKyivWindow,
  kyivDayKey,
  kyivLocalToUtc,
  kyivMinutesOfDay,
  kyivTimeAt,
  kyivUtcOffsetMinutes,
  parseHHmm,
  startOfKyivDay,
} from './kyiv';

describe('kyiv time helpers', () => {
  it('converts local wall-clock time to UTC in winter and summer', () => {
    expect(kyivLocalToUtc({ year: 2025, month: 1, day: 15, hour: 12 }).toISOString()).toBe(
      '2025-01-15T10:00:00.000Z',
    );
    expect(
      kyivLocalToUtc({ year: 2025, month: 7, day: 15, hour: 12, minute: 30 }).toISOString(),
    ).toBe('2025-07-15T09:30:00.000Z');
  });

  it('handles the DST switch day (last Sunday of March)', () => {
    expect(kyivLocalToUtc({ year: 2025, month: 3, day: 30, hour: 1 }).toISOString()).toBe(
      '2025-03-29T23:00:00.000Z',
    );
    expect(kyivLocalToUtc({ year: 2025, month: 3, day: 30, hour: 4 }).toISOString()).toBe(
      '2025-03-30T01:00:00.000Z',
    );
    expect(kyivUtcOffsetMinutes(new Date('2025-03-29T23:00:00Z'))).toBe(120);
    expect(kyivUtcOffsetMinutes(new Date('2025-03-30T01:00:00Z'))).toBe(180);
  });

  it('computes Kyiv day keys and boundaries', () => {
    const lateEvening = new Date('2025-06-30T22:30:00Z'); // 01:30 on 1 July in Kyiv
    expect(kyivDayKey(lateEvening)).toBe('2025-07-01');
    expect(startOfKyivDay(lateEvening).toISOString()).toBe('2025-06-30T21:00:00.000Z');
    expect(endOfKyivDay(lateEvening).toISOString()).toBe('2025-07-01T20:59:59.999Z');

    const winterNight = new Date('2025-01-15T22:30:00Z'); // 00:30 on 16 January in Kyiv
    expect(kyivDayKey(winterNight)).toBe('2025-01-16');
    expect(startOfKyivDay(winterNight).toISOString()).toBe('2025-01-15T22:00:00.000Z');
  });

  it('adds calendar days keeping wall-clock time across DST', () => {
    const saturdayNoon = new Date('2025-03-29T10:00:00Z'); // 12:00 Kyiv (UTC+2)
    expect(addKyivDays(saturdayNoon, 1).toISOString()).toBe('2025-03-30T09:00:00.000Z'); // 12:00 Kyiv (UTC+3)
    expect(addKyivDays(saturdayNoon, -1).toISOString()).toBe('2025-03-28T10:00:00.000Z');
  });

  it('computes minutes of day and wall-clock instants', () => {
    expect(kyivMinutesOfDay(new Date('2025-01-15T22:30:00Z'))).toBe(30);
    expect(kyivMinutesOfDay(new Date('2025-07-15T20:59:00Z'))).toBe(23 * 60 + 59);
    expect(kyivTimeAt(new Date('2025-01-15T22:30:00Z'), '05:00').toISOString()).toBe(
      '2025-01-16T03:00:00.000Z',
    );
    expect(kyivTimeAt(new Date('2025-07-15T12:00:00Z'), '24:00').toISOString()).toBe(
      '2025-07-15T21:00:00.000Z',
    );
  });

  it('evaluates daily and overnight windows', () => {
    const halfPastMidnight = new Date('2025-01-15T22:30:00Z'); // 00:30 Kyiv
    const tenPm = new Date('2025-01-15T20:00:00Z'); // 22:00 Kyiv
    const halfPastEleven = new Date('2025-01-15T21:30:00Z'); // 23:30 Kyiv
    const afternoon = new Date('2025-01-15T13:00:00Z'); // 15:00 Kyiv

    expect(isWithinKyivWindow(halfPastMidnight, '00:00', '05:00')).toBe(true);
    expect(isWithinKyivWindow(tenPm, '00:00', '05:00')).toBe(false);
    expect(isWithinKyivWindow(halfPastMidnight, '23:00', '05:00')).toBe(true);
    expect(isWithinKyivWindow(halfPastEleven, '23:00', '05:00')).toBe(true);
    expect(isWithinKyivWindow(afternoon, '23:00', '05:00')).toBe(false);
    expect(isWithinKyivWindow(afternoon, '08:00', '21:00')).toBe(true);
    expect(isWithinKyivWindow(afternoon, '05:00', '24:00')).toBe(true);
    expect(isWithinKyivWindow(afternoon, '10:00', '10:00')).toBe(true);
  });

  it('parses and rejects HH:mm values', () => {
    expect(parseHHmm('08:05')).toEqual({ hours: 8, minutes: 5 });
    expect(parseHHmm('24:00')).toEqual({ hours: 24, minutes: 0 });
    expect(() => parseHHmm('24:30')).toThrow();
    expect(() => parseHHmm('8h')).toThrow();
    expect(() => parseHHmm('12:60')).toThrow();
  });

  it('formats in Kyiv time', () => {
    expect(formatKyiv(new Date('2025-01-15T10:05:00Z'))).toBe('15.01.2025 12:05');
    expect(formatKyiv(new Date('2025-07-15T10:05:00Z'), 'HH:mm')).toBe('13:05');
  });
});
