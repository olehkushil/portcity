import {
  fiscalNumberSearchPrefix,
  normalizeFiscalNumber,
  parseFiscalNumber,
} from './fiscal-number';

describe('parseFiscalNumber', () => {
  const cases: ReadonlyArray<[unknown, ReturnType<typeof parseFiscalNumber>]> = [
    ['4000100011', { ok: true, fn: '4000100011' }],
    ['  4000100011  ', { ok: true, fn: '4000100011' }],
    ['4000 1000 11', { ok: true, fn: '4000100011' }],
    // Canonical form shared with receipts: leading zeros stripped, dashes ignored.
    ['04000100011', { ok: true, fn: '4000100011' }],
    ['0004000100011', { ok: true, fn: '4000100011' }],
    ['4000-1000-11', { ok: true, fn: '4000100011' }],
    ['000123', { ok: false, reason: 'length', input: '000123' }],
    ['12345678901234567890', { ok: true, fn: '12345678901234567890' }],
    ['12345', { ok: false, reason: 'length', input: '12345' }],
    ['123456789012345678901', { ok: false, reason: 'length', input: '123456789012345678901' }],
    ['4000.1000.11', { ok: false, reason: 'not_digits', input: '4000.1000.11' }],
    ['40001000AB', { ok: false, reason: 'not_digits', input: '40001000AB' }],
    ['', { ok: false, reason: 'empty', input: '' }],
    ['   ', { ok: false, reason: 'empty', input: '   ' }],
    [4000100011, { ok: false, reason: 'not_a_string', input: '4000100011' }],
    [null, { ok: false, reason: 'not_a_string', input: 'null' }],
    [undefined, { ok: false, reason: 'not_a_string', input: 'undefined' }],
  ];

  it.each(cases)('parses %p', (input, expected) => {
    expect(parseFiscalNumber(input)).toEqual(expected);
  });
});

describe('normalizeFiscalNumber', () => {
  it('returns the compact number', () => {
    expect(normalizeFiscalNumber(' 4000 100 022 ')).toBe('4000100022');
  });

  it('throws PC_FISCAL_NUMBER_INVALID with the reason', () => {
    expect(() => normalizeFiscalNumber('abc')).toThrow(
      expect.objectContaining({
        code: 'PC_FISCAL_NUMBER_INVALID',
        status: 400,
        details: { reason: 'not_digits' },
      }) as Error,
    );
  });
});

describe('fiscalNumberSearchPrefix', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['abc', null],
    ['4000', '4000'],
    [' 40 00-1 ', '40001'],
    ['0040', '40'],
    ['000', null],
    ['123456789012345678901234', '12345678901234567890'],
  ])('%p -> %p', (query, expected) => {
    expect(fiscalNumberSearchPrefix(query)).toBe(expected);
  });
});
