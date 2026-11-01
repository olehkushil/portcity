import { captureError } from '../testing/errors';
import {
  ageInYears,
  allProfileFieldsAnnounced,
  applyProfilePatch,
  computeProfileCompletion,
  filledProfileFields,
  formatBirthDate,
  isProfileComplete,
  newlyCompletedFields,
  normalizeEmail,
  normalizeName,
  parseBirthDate,
  validateBirthDate,
} from './profile';

const now = new Date('2026-01-15T10:00:00Z');

describe('profile normalisation', () => {
  it.each([
    ['  Oleh@Example.COM ', 'oleh@example.com'],
    ['', null],
    ['   ', null],
    [null, null],
    [undefined, null],
  ])('normalizeEmail(%p) = %p', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  it.each([
    ['  Олег   Кушіль ', 'Олег Кушіль'],
    ['', null],
    [null, null],
  ])('normalizeName(%p) = %p', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it.each([
    ['1990-05-14', '1990-05-14'],
    ['2000-02-29', '2000-02-29'],
    ['2001-02-29', null],
    ['1990-13-01', null],
    ['1990-00-10', null],
    ['14.05.1990', null],
    ['1990-5-14', null],
    ['', null],
  ])('parseBirthDate(%s) -> %p', (input, expected) => {
    const parsed = parseBirthDate(input);
    expect(formatBirthDate(parsed)).toBe(expected);
    if (parsed) {
      expect(parsed.getUTCHours()).toBe(0);
    }
  });
});

describe('birth date rules', () => {
  it.each([
    ['2012-01-15', 14],
    ['2012-01-16', 13],
    ['1990-05-14', 35],
    ['1990-01-15', 36],
  ])('age at 2026-01-15 for %s = %i', (birth, expected) => {
    expect(ageInYears(parseBirthDate(birth)!, now)).toBe(expected);
  });

  it.each([
    ['2012-01-15', 'ok'],
    ['2012-01-16', 'too_young'],
    ['2026-02-01', 'future'],
    ['1905-01-15', 'too_old'],
    ['1906-01-15', 'ok'],
    ['1990-05-14', 'ok'],
  ] as const)('validateBirthDate(%s) = %s', (birth, verdict) => {
    expect(validateBirthDate(parseBirthDate(birth)!, now)).toBe(verdict);
  });
});

describe('applyProfilePatch', () => {
  const empty = {
    firstName: null,
    lastName: null,
    birthDate: null,
    email: null,
    gender: null,
    city: null,
    profileCompletedAt: null,
  };

  it('sets gender and city (city trimmed, null clears)', () => {
    expect(applyProfilePatch(empty, { gender: 'female', city: '  Луцьк   ' }, now).data).toEqual({
      gender: 'female',
      city: 'Луцьк',
    });
    expect(
      applyProfilePatch(
        { ...empty, gender: 'male', city: 'Луцьк' },
        { gender: null, city: ' ' },
        now,
      ).data,
    ).toEqual({ gender: null, city: null });
  });

  it('marks the profile complete when name, surname and birth date are all present', () => {
    expect(isProfileComplete(empty)).toBe(false);
    const result = applyProfilePatch(
      empty,
      { firstName: ' Олег ', lastName: 'Демо', birthDate: '1990-05-14', email: 'A@B.UA' },
      now,
    );
    expect(result).toEqual({
      data: {
        firstName: 'Олег',
        lastName: 'Демо',
        birthDate: parseBirthDate('1990-05-14'),
        email: 'a@b.ua',
        profileCompletedAt: now,
      },
      completedNow: true,
      emailChanged: true,
    });
  });

  it('does not complete the profile twice and ignores unchanged e-mail', () => {
    const current = {
      firstName: 'Олег',
      lastName: 'Демо',
      birthDate: parseBirthDate('1990-05-14'),
      email: 'a@b.ua',
      gender: null,
      city: null,
      profileCompletedAt: new Date('2025-12-01T00:00:00Z'),
    };
    const result = applyProfilePatch(current, { email: ' A@B.ua ', firstName: 'Олег' }, now);
    expect(result.completedNow).toBe(false);
    expect(result.emailChanged).toBe(false);
    expect(result.data).toEqual({ firstName: 'Олег' });
  });

  it('clears fields with null and keeps the profile incomplete', () => {
    const result = applyProfilePatch(
      { ...empty, firstName: 'Олег' },
      { firstName: null, birthDate: null, email: null },
      now,
    );
    expect(result.data).toEqual({ firstName: null, birthDate: null });
    expect(result.completedNow).toBe(false);
  });

  it.each([
    ['2030-01-01', 'future'],
    ['2015-01-01', 'too_young'],
    ['1990-02-30', 'malformed'],
  ])('rejects birth date %s (%s)', (birthDate, reason) => {
    expect(captureError(() => applyProfilePatch(empty, { birthDate }, now))).toMatchObject({
      code: 'PC_USER_BIRTHDATE_INVALID',
      status: 422,
      details: { reason },
    });
  });
});

describe('profile completion', () => {
  const blank = {
    firstName: null,
    lastName: null,
    birthDate: null,
    email: null,
    gender: null,
    city: null,
    childrenCount: 0,
  };
  const bonus = { perField: 10, complete: 20 };

  it('reports 0 % and every field missing for an empty profile', () => {
    expect(computeProfileCompletion(blank, bonus)).toEqual({
      percent: 0,
      missing: ['firstName', 'lastName', 'birthDate', 'email', 'gender', 'city', 'children'],
      bonusPerField: 10,
      bonusComplete: 20,
    });
  });

  it('counts any gender answer, a city and at least one child as filled', () => {
    const partial = {
      ...blank,
      firstName: 'Олег',
      gender: 'unspecified' as const,
      city: 'Луцьк',
      childrenCount: 1,
    };
    expect(filledProfileFields(partial)).toEqual(['firstName', 'gender', 'city', 'children']);
    expect(computeProfileCompletion(partial, bonus)).toMatchObject({
      percent: 57,
      missing: ['lastName', 'birthDate', 'email'],
    });
  });

  it('reaches 100 % with all seven fields', () => {
    const full = {
      firstName: 'Олег',
      lastName: 'Демо',
      birthDate: parseBirthDate('1990-05-14'),
      email: 'a@b.ua',
      gender: 'male' as const,
      city: 'Луцьк',
      childrenCount: 2,
    };
    expect(computeProfileCompletion(full, bonus)).toMatchObject({ percent: 100, missing: [] });
  });

  it('announces a field once, even after it was cleared and filled again', () => {
    expect(newlyCompletedFields(['firstName', 'city'], [])).toEqual(['firstName', 'city']);
    expect(newlyCompletedFields(['firstName', 'city'], ['firstName'])).toEqual(['city']);
    expect(newlyCompletedFields(['firstName'], ['firstName', 'city'])).toEqual([]);
    expect(allProfileFieldsAnnounced(['firstName'])).toBe(false);
    expect(
      allProfileFieldsAnnounced([
        'children',
        'city',
        'gender',
        'email',
        'birthDate',
        'lastName',
        'firstName',
      ]),
    ).toBe(true);
  });
});
