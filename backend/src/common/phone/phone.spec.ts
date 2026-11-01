import { DomainError } from '../errors/domain-error';
import { CommonErrors } from '../errors/error-codes';
import {
  formatUaPhone,
  isUaPhone,
  maskPhone,
  normalizeUaPhone,
  tryNormalizeUaPhone,
} from './phone';

describe('phone', () => {
  it.each([
    ['0501234567', '+380501234567'],
    ['+380501234567', '+380501234567'],
    ['+380 50 123 45 67', '+380501234567'],
    ['380501234567', '+380501234567'],
    ['80501234567', '+380501234567'],
    ['(050) 123-45-67', '+380501234567'],
    ['+38 (050) 123 45 67', '+380501234567'],
    ['501234567', '+380501234567'],
    ['  0 67 123 45 67 ', '+380671234567'],
    ['0332 77 55 33', '+380332775533'],
  ])('normalises %s', (input, expected) => {
    expect(normalizeUaPhone(input)).toBe(expected);
    expect(isUaPhone(input)).toBe(true);
  });

  it.each([
    '',
    '   ',
    '12345',
    'abc',
    '+1 650 253 0000',
    '+48 601 123 456',
    '050123456',
    '0501234567x',
  ])('rejects %s', (input) => {
    expect(tryNormalizeUaPhone(input)).toBeNull();
    expect(isUaPhone(input)).toBe(false);
    expect(() => normalizeUaPhone(input)).toThrow(DomainError);
    try {
      normalizeUaPhone(input);
    } catch (error) {
      expect((error as DomainError).code).toBe(CommonErrors.PC_COMMON_PHONE_INVALID);
      expect((error as DomainError).status).toBe(400);
    }
  });

  it('masks and formats', () => {
    expect(maskPhone('+380501234567')).toBe('+380 50 *** ** 67');
    expect(maskPhone('+15551234567')).toBe('+155******67');
    expect(maskPhone('12')).toBe('***');
    expect(formatUaPhone('+380501234567')).toBe('+380 50 123 45 67');
    expect(formatUaPhone('+15551234567')).toBe('+15551234567');
  });
});
