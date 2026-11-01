import {
  type TenantHours,
  isTenantOpenAt,
  kyivWeekday,
  parseTenantHours,
  rangesForDay,
  readTenantHours,
} from './tenant-hours';

const MALL = { from: '10:00', to: '22:00' };

/** Kyiv wall clock in January (UTC+2) -> UTC instant. 2026-01-15 is a Thursday. */
function kyiv(date: string, time: string): Date {
  const [hours, minutes] = time.split(':').map(Number);
  const utc = new Date(`${date}T00:00:00.000Z`);
  utc.setUTCHours((hours ?? 0) - 2, minutes ?? 0);
  return utc;
}

describe('parseTenantHours', () => {
  it('normalises ranges and sorts exceptions', () => {
    expect(
      parseTenantHours({
        mon: ['9:00-21:00'],
        sun: [],
        fri: ['10:00 - 14:00', '15:00–23:30'],
        exceptions: [
          { date: '2027-01-01', closed: true },
          { date: '2026-12-31', ranges: ['10:00-18:00'], note: ' Передноворічний ' },
        ],
      }),
    ).toEqual({
      ok: true,
      hours: {
        mon: ['09:00-21:00'],
        fri: ['10:00-14:00', '15:00-23:30'],
        sun: [],
        exceptions: [
          { date: '2026-12-31', ranges: ['10:00-18:00'], note: 'Передноворічний' },
          { date: '2027-01-01', closed: true },
        ],
      },
    });
  });

  it.each<[string, unknown]>([
    ['not an object', ['10:00-22:00']],
    ['unknown key', { monday: ['10:00-22:00'] }],
    ['day is not a list', { mon: '10:00-22:00' }],
    ['malformed range', { mon: ['10-22'] }],
    ['hour 25', { mon: ['10:00-25:00'] }],
    [
      'too many ranges',
      { mon: ['01:00-02:00', '03:00-04:00', '05:00-06:00', '07:00-08:00', '09:00-10:00'] },
    ],
    ['exception without a date', { exceptions: [{ closed: true }] }],
    ['exception with 30 February', { exceptions: [{ date: '2027-02-30', closed: true }] }],
    [
      'duplicate exception date',
      {
        exceptions: [
          { date: '2027-01-01', closed: true },
          { date: '2027-01-01', closed: true },
        ],
      },
    ],
    [
      'closed exception with ranges',
      { exceptions: [{ date: '2027-01-01', closed: true, ranges: ['10:00-12:00'] }] },
    ],
    ['open exception without ranges', { exceptions: [{ date: '2027-01-01' }] }],
    ['unknown exception key', { exceptions: [{ date: '2027-01-01', closed: true, why: 'x' }] }],
  ])('refuses %s', (_name, value) => {
    expect(parseTenantHours(value).ok).toBe(false);
  });

  it('reads stored JSON tolerantly', () => {
    expect(readTenantHours(null)).toBeNull();
    expect(readTenantHours({ mon: ['bad'] })).toBeNull();
    expect(readTenantHours({ mon: ['10:00-20:00'] })).toEqual({ mon: ['10:00-20:00'] });
  });
});

describe('isTenantOpenAt', () => {
  const hours: TenantHours = {
    mon: ['10:00-20:00'],
    tue: ['10:00-20:00'],
    wed: ['10:00-20:00'],
    thu: ['10:00-14:00', '15:00-20:00'],
    fri: ['18:00-02:00'],
    sun: [],
    exceptions: [
      { date: '2026-01-19', closed: true },
      { date: '2026-01-20', ranges: ['12:00-16:00'] },
    ],
  };

  it('knows the Kyiv weekday', () => {
    expect(kyivWeekday(kyiv('2026-01-15', '12:00'))).toBe('thu');
    // 23:30 UTC on Sunday is already Monday 01:30 in Kyiv.
    expect(kyivWeekday(new Date('2026-01-18T23:30:00.000Z'))).toBe('mon');
  });

  it.each<[string, string, string, boolean]>([
    ['thursday before opening', '2026-01-15', '09:59', false],
    ['thursday morning', '2026-01-15', '10:00', true],
    ['thursday lunch break', '2026-01-15', '14:30', false],
    ['thursday afternoon', '2026-01-15', '19:59', true],
    ['thursday closing time', '2026-01-15', '20:00', false],
    ['friday evening (overnight range)', '2026-01-16', '23:00', true],
    ['saturday 01:00 (tail of friday)', '2026-01-17', '01:00', true],
    ['saturday 02:00 (friday range ended)', '2026-01-17', '02:00', false],
    ['saturday noon: no own hours, mall hours apply', '2026-01-17', '12:00', true],
    ['saturday 23:00: mall closed', '2026-01-17', '23:00', false],
    ['sunday: closed all day', '2026-01-18', '12:00', false],
    ['monday exception: closed', '2026-01-19', '12:00', false],
    ['tuesday exception: short day', '2026-01-20', '11:00', false],
    ['tuesday exception: open', '2026-01-20', '13:00', true],
  ])('%s (%s %s) -> %s', (_name, date, time, expected) => {
    expect(isTenantOpenAt(hours, MALL, kyiv(date, time))).toBe(expected);
  });

  it('falls back to the mall hours without own hours', () => {
    expect(isTenantOpenAt(null, MALL, kyiv('2026-01-15', '09:00'))).toBe(false);
    expect(isTenantOpenAt(null, MALL, kyiv('2026-01-15', '21:59'))).toBe(true);
    expect(rangesForDay(null, kyiv('2026-01-15', '12:00'))).toBeNull();
  });

  it('handles summer time (UTC+3)', () => {
    // 2026-07-16 is a Thursday; 19:30 Kyiv = 16:30 UTC.
    expect(isTenantOpenAt(hours, MALL, new Date('2026-07-16T16:30:00.000Z'))).toBe(true);
    expect(isTenantOpenAt(hours, MALL, new Date('2026-07-16T17:30:00.000Z'))).toBe(false);
  });
});
