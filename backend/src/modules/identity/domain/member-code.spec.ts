import {
  formatMemberCode,
  generateMemberCode,
  hasValidCheckDigit,
  isWellFormedMemberCode,
  luhnCheckDigit,
} from './member-code';

describe('member codes', () => {
  it.each([
    ['7992739871', 3],
    ['453201511283036', 6],
    ['0', 0],
    ['9', 1],
    ['73421180', 8],
  ])('luhnCheckDigit(%s) = %i', (digits, expected) => {
    expect(luhnCheckDigit(digits)).toBe(expected);
  });

  it('rejects non-digit input for the check digit', () => {
    expect(() => luhnCheckDigit('12a')).toThrow(/decimal digits/);
    expect(() => luhnCheckDigit('')).toThrow(/decimal digits/);
  });

  it.each([
    ['734211808', true, true],
    ['734211800', true, false],
    ['123456789', true, false],
    ['12345678', false, false],
    ['1234567890', false, false],
    ['73421180a', false, false],
    ['', false, false],
  ])('%s well-formed=%s check-digit=%s', (code, wellFormed, checkOk) => {
    expect(isWellFormedMemberCode(code)).toBe(wellFormed);
    expect(hasValidCheckDigit(code)).toBe(checkOk);
  });

  it('generates nine-digit codes without a leading zero and with a valid check digit', () => {
    const sequence = [0, 0, 0, 0, 0, 0, 0, 0];
    let cursor = 0;
    const randomInt = (max: number): number => {
      const value = sequence[cursor % sequence.length] ?? 0;
      cursor += 1;
      return value % max;
    };
    const code = generateMemberCode(randomInt);
    expect(code).toBe('100000009');
    expect(hasValidCheckDigit(code)).toBe(true);
  });

  it('uses the random source for every digit', () => {
    const values = [8, 7, 3, 4, 2, 1, 1, 8];
    let cursor = 0;
    const code = generateMemberCode((max) => {
      const value = values[cursor] ?? 0;
      cursor += 1;
      return value % max;
    });
    expect(code).toBe('973421183');
    expect(hasValidCheckDigit(code)).toBe(true);
    expect(cursor).toBe(8);
  });

  it('formats codes in groups of three', () => {
    expect(formatMemberCode('734211800')).toBe('734 211 800');
    expect(formatMemberCode('bad')).toBe('bad');
  });
});
