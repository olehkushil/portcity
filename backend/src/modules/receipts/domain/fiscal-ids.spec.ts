import { canonicalFiscalId, canonicalFn, numericFiscalId } from './fiscal-ids';

describe('canonicalFiscalId', () => {
  it.each([
    ['1180000001', '1180000001'],
    ['01180000001', '1180000001'],
    ['001180000001', '1180000001'],
    ['  1180000001  ', '1180000001'],
    ['118-000-0001', '1180000001'],
    ['118 000 0001', '1180000001'],
    ['118–000—0001', '1180000001'],
    ['0-1180000001', '1180000001'],
    ['0000', '0'],
    ['0', '0'],
    ['ab12-34', 'AB1234'],
    ['AB12-34', 'AB1234'],
    ['Ab 12 34', 'AB1234'],
    // Only purely numeric ids lose their leading zeros.
    ['00AB12', '00AB12'],
  ])('%p -> %p', (input, expected) => {
    expect(canonicalFiscalId(input)).toBe(expected);
  });

  it.each([
    [''],
    ['   '],
    ['---'],
    ['12.34'],
    ['12/34'],
    // Cyrillic А and В look like Latin letters; they are refused, not folded.
    ['АB12'],
    ['ABВ12'],
    ['x'.repeat(65)],
    ['1'.repeat(129)],
  ])('refuses %p', (input) => {
    expect(canonicalFiscalId(input)).toBeNull();
  });

  it('never throws on non-string input', () => {
    // Typed escape hatch: callers that bypassed validation still get null.
    expect(canonicalFiscalId(undefined as unknown as string)).toBeNull();
    expect(canonicalFiscalId(42 as unknown as string)).toBeNull();
  });
});

describe('canonicalFn', () => {
  it.each([
    ['4000100011', '4000100011'],
    ['04000100011', '4000100011'],
    ['0004000100011', '4000100011'],
    [' 4000 100 011 ', '4000100011'],
    ['4000-100-011', '4000100011'],
    ['12345678901234567890', '12345678901234567890'],
  ])('%p -> %p', (input, expected) => {
    expect(canonicalFn(input)).toBe(expected);
  });

  it.each([['12345'], ['0000012345'], ['40001000AB'], [''], ['000000'], ['123456789012345678901']])(
    'refuses %p',
    (input) => {
      expect(canonicalFn(input)).toBeNull();
    },
  );
});

describe('numericFiscalId', () => {
  it('reads numeric ids as bigint and ignores alphanumeric ones', () => {
    expect(numericFiscalId('1180000001')).toBe(1_180_000_001n);
    expect(numericFiscalId('99999999999999999999999')).toBe(99_999_999_999_999_999_999_999n);
    expect(numericFiscalId('AB12')).toBeNull();
  });
});
