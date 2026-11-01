import { formatHoursRange, isOpenAt, isValidHoursRange, parseHoursRange } from './mall-hours';

describe('parseHoursRange', () => {
  it.each([
    ['10:00-22:00', { from: '10:00', to: '22:00' }],
    ['10:00 - 22:00', { from: '10:00', to: '22:00' }],
    ['10:00–22:00', { from: '10:00', to: '22:00' }],
    ['8:00-21:00', { from: '08:00', to: '21:00' }],
    ['05:00-24:00', { from: '05:00', to: '24:00' }],
    ['00:00-05:00', { from: '00:00', to: '05:00' }],
    ['', null],
    [undefined, null],
    [null, null],
    ['10:00', null],
    ['10:00-25:00', null],
    ['10:60-22:00', null],
    ['24:30-01:00', null],
    ['abc', null],
  ])('%p -> %j', (input, expected) => {
    expect(parseHoursRange(input)).toEqual(expected);
    if (typeof input === 'string') {
      expect(isValidHoursRange(input)).toBe(expected !== null);
    }
  });
});

describe('isOpenAt (Kyiv wall clock)', () => {
  const mall = { from: '10:00', to: '22:00' };
  const surface = { from: '05:00', to: '24:00' };
  const night = { from: '23:00', to: '05:00' };

  it.each([
    // winter: Kyiv = UTC+2
    ['2026-01-15T07:59:00Z', mall, false],
    ['2026-01-15T08:00:00Z', mall, true],
    ['2026-01-15T19:59:00Z', mall, true],
    ['2026-01-15T20:00:00Z', mall, false],
    // summer: Kyiv = UTC+3
    ['2026-07-15T06:59:00Z', mall, false],
    ['2026-07-15T07:00:00Z', mall, true],
    ['2026-07-15T18:59:59Z', mall, true],
    ['2026-07-15T19:00:00Z', mall, false],
    // 24:00 end means until midnight
    ['2026-01-15T21:59:00Z', surface, true],
    ['2026-01-15T22:00:00Z', surface, false],
    // overnight window
    ['2026-01-15T22:00:00Z', night, true],
    ['2026-01-15T02:59:00Z', night, true],
    ['2026-01-15T03:00:00Z', night, false],
  ])('%s in %j -> %s', (iso, range, expected) => {
    expect(isOpenAt(range, new Date(iso))).toBe(expected);
  });
});

describe('formatHoursRange', () => {
  it('prints HH:mm-HH:mm', () => {
    expect(formatHoursRange({ from: '10:00', to: '22:00' })).toBe('10:00-22:00');
  });
});
