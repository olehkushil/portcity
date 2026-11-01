import { VERIFICATION_CODE_PATTERN, codeMatchesPlate } from './verification';

describe('codeMatchesPlate (emulator rule)', () => {
  it.each([
    ['1234', 'AC1234BC', true],
    ['771234', 'AC1234BC', true],
    ['T-00-1234', 'AC1234BC', true],
    ['1235', 'AC1234BC', false],
    ['234', 'AC1234BC', false],
    ['12345', 'AC1234BC', false],
    ['0123', 'BC123AB', true],
    ['123', 'BC123AB', false],
    ['1234', 'ABCDEF', false],
    ['', 'AC1234BC', false],
  ])('code %p for plate %p -> %p', (code, plate, expected) => {
    expect(codeMatchesPlate(code, plate)).toBe(expected);
  });
});

describe('VERIFICATION_CODE_PATTERN', () => {
  it.each([
    ['1234', true],
    ['T-00-1234', true],
    ['abc', false],
    ['12 34', false],
    ['x'.repeat(33), false],
  ])('%p -> %p', (code, expected) => {
    expect(VERIFICATION_CODE_PATTERN.test(code)).toBe(expected);
  });
});
