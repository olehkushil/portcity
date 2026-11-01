import { DomainError } from '../errors/domain-error';
import { CommonErrors } from '../errors/error-codes';
import {
  applyPercent,
  assertKopecks,
  formatPoints,
  formatUah,
  kopecksToUah,
  pluralizeUk,
  pointsFromKopecks,
  sumKopecks,
  uahToKopecks,
} from './money';

describe('money', () => {
  describe('uahToKopecks', () => {
    it.each([
      ['123.45', 12345],
      ['123,45', 12345],
      ['1 234,50', 123450],
      ['1.234,50', 123450],
      ['1,234.50', 123450],
      ['1 234', 123400],
      ['1.234.567', 123456700],
      ['0', 0],
      ['0.01', 1],
      ['12.3', 1230],
      ['12.345', 1235],
      ['12.344', 1234],
      ['12.3449', 1234],
      ['-5,5', -550],
      ['+7', 700],
      ['  99,90 грн ', 9990],
      ['150 UAH', 15000],
      ['1 500,00', 150000],
    ])('parses %s as %d kopecks', (input, expected) => {
      expect(uahToKopecks(input)).toBe(expected);
    });

    it('parses numbers with float noise', () => {
      expect(uahToKopecks(12.34)).toBe(1234);
      expect(uahToKopecks(0.1 + 0.2)).toBe(30);
      expect(uahToKopecks(1.005)).toBe(101);
      expect(uahToKopecks(0)).toBe(0);
    });

    it.each(['', '   ', 'abc', '12.ab', '.5', '1,2,3.4.5x', 'NaN'])('rejects %s', (input) => {
      expect(() => uahToKopecks(input)).toThrow(DomainError);
      try {
        uahToKopecks(input);
      } catch (error) {
        expect((error as DomainError).code).toBe(CommonErrors.PC_COMMON_MONEY_INVALID);
      }
    });

    it('rejects non-finite numbers', () => {
      expect(() => uahToKopecks(Number.POSITIVE_INFINITY)).toThrow(DomainError);
      expect(() => uahToKopecks(Number.NaN)).toThrow(DomainError);
    });
  });

  describe('formatUah', () => {
    it.each([
      [123456, undefined, '1 234,56 ₴'],
      [0, undefined, '0,00 ₴'],
      [-150, undefined, '-1,50 ₴'],
      [100000, { fraction: 'auto' as const }, '1 000 ₴'],
      [100050, { fraction: 'auto' as const }, '1 000,50 ₴'],
      [123456, { unit: 'word' as const }, '1 234,56 грн'],
      [123456789, { unit: 'none' as const }, '1 234 567,89'],
    ])('formats %d', (kopecks, options, expected) => {
      expect(formatUah(kopecks, options)).toBe(expected);
    });

    it('rejects fractional kopecks', () => {
      expect(() => formatUah(1.5)).toThrow(DomainError);
    });
  });

  describe('assertKopecks / kopecksToUah / sumKopecks', () => {
    it('accepts safe integers only', () => {
      expect(() => assertKopecks(100)).not.toThrow();
      expect(() => assertKopecks(-100)).not.toThrow();
      expect(() => assertKopecks(1.5)).toThrow(DomainError);
      expect(() => assertKopecks(Number.NaN)).toThrow(DomainError);
      expect(() => assertKopecks('100')).toThrow(DomainError);
    });

    it('converts and sums', () => {
      expect(kopecksToUah(12345)).toBe(123.45);
      expect(sumKopecks([100, 250, -50])).toBe(300);
      expect(sumKopecks([])).toBe(0);
      expect(() => sumKopecks([1, 0.5])).toThrow(DomainError);
    });
  });

  describe('pointsFromKopecks', () => {
    it.each([
      [12345, 3, 3],
      [100000, 3, 30],
      [99999, 3, 29],
      [10000, 2.5, 2],
      [3333, 3, 0],
      [0, 3, 0],
      [1_000_000_00, 3, 30000],
    ])('%d kopecks at %d%% -> %d points', (total, rate, expected) => {
      expect(pointsFromKopecks(total, rate)).toBe(expected);
    });

    it('is exact for integer results that floats would get wrong', () => {
      // 0.07 * 100 = 7.000000000000001 in floats; the integer path must give 7.
      expect(pointsFromKopecks(10000, 7)).toBe(7);
      expect(pointsFromKopecks(5700, 1)).toBe(0);
      expect(pointsFromKopecks(290000, 1.1)).toBe(31);
    });

    it('rejects negative inputs', () => {
      expect(() => pointsFromKopecks(-1, 3)).toThrow(DomainError);
      expect(() => pointsFromKopecks(100, -3)).toThrow(DomainError);
    });
  });

  describe('applyPercent', () => {
    it('applies with the requested rounding', () => {
      expect(applyPercent(10000, 20)).toBe(2000);
      expect(applyPercent(999, 33.33)).toBe(333);
      expect(applyPercent(999, 33.33, 'floor')).toBe(332);
      expect(applyPercent(999, 33.33, 'ceil')).toBe(333);
      expect(applyPercent(1, 50, 'floor')).toBe(0);
    });
  });

  describe('Ukrainian plural forms', () => {
    const forms = ['бал', 'бали', 'балів'] as const;
    it.each([
      [1, 'бал'],
      [2, 'бали'],
      [4, 'бали'],
      [5, 'балів'],
      [11, 'балів'],
      [12, 'балів'],
      [21, 'бал'],
      [22, 'бали'],
      [100, 'балів'],
      [112, 'балів'],
      [1251, 'бал'],
    ])('%d -> %s', (count, expected) => {
      expect(pluralizeUk(count, forms)).toBe(expected);
    });

    it('formats points', () => {
      expect(formatPoints(1250)).toBe('1 250 балів');
      expect(formatPoints(1)).toBe('1 бал');
      expect(formatPoints(-3)).toBe('-3 бали');
      expect(() => formatPoints(1.5)).toThrow(DomainError);
    });
  });
});
