import { DomainError } from '../../../common/errors/domain-error';
import { toKyiv } from '../../../common/time/kyiv';
import { IdentityErrors } from './errors';

/** Children per member (profile: kids' events and offers). */
export const MAX_CHILDREN = 6;
/** Oldest accepted age in whole years (a child who already turned 19 is refused). */
export const MAX_CHILD_AGE_YEARS = 18;

export interface ChildBirth {
  birthMonth: number;
  birthYear: number;
}

export type ChildBirthVerdict = 'ok' | 'malformed' | 'future' | 'too_old';

/** Full months between the child's birth month and the current Kyiv month. */
export function childAgeMonths(birth: ChildBirth, now: Date): number {
  const kyiv = toKyiv(now);
  return (kyiv.getFullYear() - birth.birthYear) * 12 + (kyiv.getMonth() + 1 - birth.birthMonth);
}

/** Month 1-12, not after the current Kyiv month, at most MAX_CHILD_AGE_YEARS years ago. */
export function validateChildBirth(birth: ChildBirth, now: Date): ChildBirthVerdict {
  if (
    !Number.isInteger(birth.birthMonth) ||
    !Number.isInteger(birth.birthYear) ||
    birth.birthMonth < 1 ||
    birth.birthMonth > 12 ||
    birth.birthYear < 1900
  ) {
    return 'malformed';
  }
  const months = childAgeMonths(birth, now);
  if (months < 0) {
    return 'future';
  }
  if (months >= (MAX_CHILD_AGE_YEARS + 1) * 12) {
    return 'too_old';
  }
  return 'ok';
}

export function assertChildBirth(birth: ChildBirth, now: Date): void {
  const verdict = validateChildBirth(birth, now);
  if (verdict !== 'ok') {
    throw new DomainError(
      IdentityErrors.PC_USER_CHILD_BIRTH_INVALID,
      `A child must be born in a past or the current month and be at most ${MAX_CHILD_AGE_YEARS} years old`,
      { details: { reason: verdict, maxAgeYears: MAX_CHILD_AGE_YEARS } },
    );
  }
}

export function assertChildLimit(currentCount: number): void {
  if (currentCount >= MAX_CHILDREN) {
    throw new DomainError(
      IdentityErrors.PC_USER_CHILD_LIMIT,
      `A profile can list at most ${MAX_CHILDREN} children`,
      { details: { max: MAX_CHILDREN } },
    );
  }
}
