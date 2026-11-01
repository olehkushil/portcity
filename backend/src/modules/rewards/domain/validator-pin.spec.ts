import {
  NEW_PIN_PATTERN,
  SHIFT_PIN_PATTERN,
  VALIDATOR_PIN_LOCK_MINUTES,
  VALIDATOR_PIN_MAX_FAILURES,
  decidePinFailure,
  isPinLocked,
} from './validator-pin';

const NOW = new Date('2026-11-01T10:00:00.000Z');

describe('validator PIN rules', () => {
  it.each([
    ['123456', true],
    ['123456789012', true],
    ['12345', false],
    ['1234', false],
    ['12345a', false],
    ['1234567890123', false],
  ])('new PIN %s accepted: %p', (pin, expected) => {
    expect(NEW_PIN_PATTERN.test(pin)).toBe(expected);
  });

  it.each([
    ['1234', true],
    ['123456', true],
    ['123', false],
  ])('shift PIN %s accepted: %p', (pin, expected) => {
    expect(SHIFT_PIN_PATTERN.test(pin)).toBe(expected);
  });

  it.each([1, 2, 3, 4])('failure %i of 5 only counts', (attempts) => {
    expect(decidePinFailure(attempts, NOW)).toEqual({ lock: false, failedPinAttempts: attempts });
  });

  it.each([5, 6])('failure %i locks for 15 minutes and restarts the counter', (attempts) => {
    expect(decidePinFailure(attempts, NOW)).toEqual({
      lock: true,
      failedPinAttempts: 0,
      pinLockedUntil: new Date('2026-11-01T10:15:00.000Z'),
    });
    expect(VALIDATOR_PIN_MAX_FAILURES).toBe(5);
    expect(VALIDATOR_PIN_LOCK_MINUTES).toBe(15);
  });

  it.each([
    [null, false],
    [new Date('2026-11-01T10:00:01.000Z'), true],
    [NOW, false],
    [new Date('2026-11-01T09:59:59.000Z'), false],
  ])('locked until %p: %p', (pinLockedUntil, expected) => {
    expect(isPinLocked({ pinLockedUntil }, NOW)).toBe(expected);
  });
});
