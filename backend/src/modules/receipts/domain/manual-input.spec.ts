import { parseManualIssuedAt } from './manual-input';

describe('parseManualIssuedAt', () => {
  it.each([
    ['Kyiv wall clock in winter (UTC+2)', '2026-01-15T14:30:00', '2026-01-15T12:30:00.000Z'],
    ['Kyiv wall clock in summer (UTC+3)', '2026-07-15T14:30', '2026-07-15T11:30:00.000Z'],
    ['space separator and milliseconds', '2026-01-15 14:30:05.250', '2026-01-15T12:30:05.250Z'],
    ['date only means Kyiv midnight', '2026-01-15', '2026-01-14T22:00:00.000Z'],
    ['explicit UTC', '2026-01-15T14:30:00Z', '2026-01-15T14:30:00.000Z'],
    ['explicit offset', '2026-01-15T14:30:00+02:00', '2026-01-15T12:30:00.000Z'],
    ['compact offset', '2026-01-15T14:30:00+0300', '2026-01-15T11:30:00.000Z'],
    ['surrounding whitespace', '  2026-01-15T14:30:00  ', '2026-01-15T12:30:00.000Z'],
  ])('%s', (_name, input, expected) => {
    expect(parseManualIssuedAt(input)?.toISOString()).toBe(expected);
  });

  it.each([
    '',
    'yesterday',
    '2026-02-30T10:00:00',
    '2026-13-01',
    '2026-01-15T25:00:00',
    '15.01.2026',
  ])('rejects %p', (input) => {
    expect(parseManualIssuedAt(input)).toBeNull();
  });
});
