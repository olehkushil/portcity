import { captureError } from '../testing/errors';
import {
  type ChildBirthVerdict,
  MAX_CHILDREN,
  assertChildBirth,
  assertChildLimit,
  childAgeMonths,
  validateChildBirth,
} from './children';

// 2026-10-31 23:30 UTC is already November in Kyiv (UTC+2 after the DST change on 25 October).
const now = new Date('2026-10-31T23:30:00.000Z');

describe('child birth rules (Kyiv calendar month)', () => {
  it('counts months in Kyiv time', () => {
    expect(childAgeMonths({ birthMonth: 11, birthYear: 2026 }, now)).toBe(0);
    expect(childAgeMonths({ birthMonth: 11, birthYear: 2025 }, now)).toBe(12);
  });

  it.each<[number, number, ChildBirthVerdict]>([
    [11, 2026, 'ok'],
    [12, 2026, 'future'],
    [1, 2027, 'future'],
    [12, 2007, 'ok'],
    [11, 2007, 'too_old'],
    [5, 2019, 'ok'],
    [0, 2019, 'malformed'],
    [13, 2019, 'malformed'],
    [6, 1800, 'malformed'],
    [2.5, 2019, 'malformed'],
  ])('month %i of %i -> %s', (birthMonth, birthYear, verdict) => {
    expect(validateChildBirth({ birthMonth, birthYear }, now)).toBe(verdict);
  });

  it('throws PC_USER_CHILD_BIRTH_INVALID with the reason', () => {
    expect(
      captureError(() => assertChildBirth({ birthMonth: 12, birthYear: 2026 }, now)),
    ).toMatchObject({
      code: 'PC_USER_CHILD_BIRTH_INVALID',
      status: 422,
      details: { reason: 'future' },
    });
    expect(() => assertChildBirth({ birthMonth: 5, birthYear: 2019 }, now)).not.toThrow();
  });

  it('allows at most six children', () => {
    expect(MAX_CHILDREN).toBe(6);
    expect(() => assertChildLimit(5)).not.toThrow();
    expect(captureError(() => assertChildLimit(6))).toMatchObject({
      code: 'PC_USER_CHILD_LIMIT',
      status: 422,
      details: { max: 6 },
    });
  });
});
