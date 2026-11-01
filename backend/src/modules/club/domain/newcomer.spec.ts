import { NEWCOMER_UNLOCK_RECEIPTS, isNewcomerLockActive, shouldLiftNewcomerLock } from './newcomer';

const now = new Date('2026-11-01T12:00:00.000Z');
const future = new Date('2026-11-03T12:00:00.000Z');
const past = new Date('2026-10-30T12:00:00.000Z');

describe('isNewcomerLockActive', () => {
  it.each([
    [null, false],
    [past, false],
    [now, false],
    [future, true],
  ])('lockUntil %p -> %p', (lockUntil, expected) => {
    expect(isNewcomerLockActive(lockUntil, now)).toBe(expected);
  });
});

describe('shouldLiftNewcomerLock', () => {
  it('requires two credited receipts by default', () => {
    expect(NEWCOMER_UNLOCK_RECEIPTS).toBe(2);
  });

  it.each([
    [future, 0, false],
    [future, 1, false],
    [future, 2, true],
    [future, 5, true],
    [past, 5, false],
    [null, 5, false],
  ])('lockUntil %p with %d receipts -> %p', (lockUntil, receipts, expected) => {
    expect(shouldLiftNewcomerLock(lockUntil, now, receipts)).toBe(expected);
  });
});
