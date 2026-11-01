import { type Gender, PROFILE_FIELDS, type ProfileField } from '../../../common/contracts/identity';
import { DomainError } from '../../../common/errors/domain-error';
import { IdentityErrors } from './errors';

export const MIN_MEMBER_AGE_YEARS = 14;
export const MAX_MEMBER_AGE_YEARS = 120;

const BIRTH_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface ProfileFields {
  firstName: string | null;
  lastName: string | null;
  birthDate: Date | null;
  email: string | null;
  gender: Gender | null;
  city: string | null;
}

/** `undefined` leaves a field untouched, `null` clears it. */
export interface ProfilePatch {
  firstName?: string | null;
  lastName?: string | null;
  /** `yyyy-MM-dd` */
  birthDate?: string | null;
  email?: string | null;
  gender?: Gender | null;
  city?: string | null;
}

/** What profileCompletion is computed from: the profile plus the number of children. */
export interface ProfileCompletionInput extends ProfileFields {
  childrenCount: number;
}

export interface ProfileCompletion {
  /** Share of PROFILE_FIELDS filled, 0-100, rounded down. */
  percent: number;
  /** Fields still empty, in PROFILE_FIELDS order. */
  missing: ProfileField[];
  /** Points club awards for each field filled for the first time (display value from config). */
  bonusPerField: number;
  /** Extra points once every field has been filled (display value from config). */
  bonusComplete: number;
}

/** Fields of PROFILE_FIELDS that currently have a value; `gender` counts with any answer. */
export function filledProfileFields(input: ProfileCompletionInput): ProfileField[] {
  const filled: Record<ProfileField, boolean> = {
    firstName: input.firstName !== null,
    lastName: input.lastName !== null,
    birthDate: input.birthDate !== null,
    email: input.email !== null,
    gender: input.gender !== null,
    city: input.city !== null,
    children: input.childrenCount > 0,
  };
  return PROFILE_FIELDS.filter((field) => filled[field]);
}

export function computeProfileCompletion(
  input: ProfileCompletionInput,
  bonus: { perField: number; complete: number },
): ProfileCompletion {
  const filled = new Set(filledProfileFields(input));
  return {
    percent: Math.floor((filled.size * 100) / PROFILE_FIELDS.length),
    missing: PROFILE_FIELDS.filter((field) => !filled.has(field)),
    bonusPerField: bonus.perField,
    bonusComplete: bonus.complete,
  };
}

/**
 * Fields filled now that were never announced before (`users.completed_profile_fields`): each of
 * them gets one `user.profile_field_completed` event. Clearing and refilling a field announces
 * nothing, so the per-field bonus cannot be farmed.
 */
export function newlyCompletedFields(
  filled: readonly ProfileField[],
  announced: readonly string[],
): ProfileField[] {
  const known = new Set(announced);
  return filled.filter((field) => !known.has(field));
}

/** True when, after `added`, every profile field has been announced at least once. */
export function allProfileFieldsAnnounced(announced: readonly string[]): boolean {
  const known = new Set(announced);
  return PROFILE_FIELDS.every((field) => known.has(field));
}

export interface ProfilePatchResult {
  data: Partial<ProfileFields> & { profileCompletedAt?: Date };
  /** True when this patch made the profile complete for the first time (welcome bonus trigger). */
  completedNow: boolean;
  emailChanged: boolean;
}

/**
 * Profile completion for the welcome bonus "profile" (user.profile_completed): first name, last
 * name and birth date. The wider per-field progress is computeProfileCompletion().
 */
export function isProfileComplete(
  profile: Pick<ProfileFields, 'firstName' | 'lastName' | 'birthDate'>,
): boolean {
  return Boolean(profile.firstName && profile.lastName && profile.birthDate);
}

/** Trims, collapses inner whitespace, lower-cases; empty becomes null. */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined) {
    return null;
  }
  const trimmed = email.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/** Trims and collapses whitespace; empty becomes null. */
export function normalizeName(name: string | null | undefined): string | null {
  if (name === null || name === undefined) {
    return null;
  }
  const trimmed = name.trim().replace(/\s+/g, ' ');
  return trimmed === '' ? null : trimmed;
}

/** Strict `yyyy-MM-dd` -> Date at UTC midnight (how Prisma represents `@db.Date`); null when invalid. */
export function parseBirthDate(value: string): Date | null {
  const match = BIRTH_DATE_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export function formatBirthDate(date: Date | null): string | null {
  if (!date) {
    return null;
  }
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Whole years between the birth date and `now`, both read as UTC calendar dates. */
export function ageInYears(birthDate: Date, now: Date): number {
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  const hadBirthday =
    now.getUTCMonth() > birthDate.getUTCMonth() ||
    (now.getUTCMonth() === birthDate.getUTCMonth() && now.getUTCDate() >= birthDate.getUTCDate());
  if (!hadBirthday) {
    age -= 1;
  }
  return age;
}

export type BirthDateVerdict = 'ok' | 'future' | 'too_young' | 'too_old';

export function validateBirthDate(birthDate: Date, now: Date): BirthDateVerdict {
  if (birthDate.getTime() > now.getTime()) {
    return 'future';
  }
  const age = ageInYears(birthDate, now);
  if (age < MIN_MEMBER_AGE_YEARS) {
    return 'too_young';
  }
  if (age > MAX_MEMBER_AGE_YEARS) {
    return 'too_old';
  }
  return 'ok';
}

/**
 * Computes the update for PATCH /me. Throws PC_USER_BIRTHDATE_INVALID for a malformed or
 * unacceptable birth date; email uniqueness is checked by the service (database constraint).
 */
export function applyProfilePatch(
  current: ProfileFields & { profileCompletedAt: Date | null },
  patch: ProfilePatch,
  now: Date,
): ProfilePatchResult {
  const data: ProfilePatchResult['data'] = {};
  let emailChanged = false;

  if (patch.firstName !== undefined) {
    data.firstName = normalizeName(patch.firstName);
  }
  if (patch.lastName !== undefined) {
    data.lastName = normalizeName(patch.lastName);
  }
  if (patch.birthDate !== undefined) {
    if (patch.birthDate === null) {
      data.birthDate = null;
    } else {
      const parsed = parseBirthDate(patch.birthDate);
      if (!parsed) {
        throw new DomainError(
          IdentityErrors.PC_USER_BIRTHDATE_INVALID,
          'Birth date must be a real calendar date in yyyy-MM-dd format',
          { details: { reason: 'malformed' } },
        );
      }
      const verdict = validateBirthDate(parsed, now);
      if (verdict !== 'ok') {
        throw new DomainError(
          IdentityErrors.PC_USER_BIRTHDATE_INVALID,
          `Members must be between ${MIN_MEMBER_AGE_YEARS} and ${MAX_MEMBER_AGE_YEARS} years old`,
          {
            details: {
              reason: verdict,
              minAge: MIN_MEMBER_AGE_YEARS,
              maxAge: MAX_MEMBER_AGE_YEARS,
            },
          },
        );
      }
      data.birthDate = parsed;
    }
  }
  if (patch.email !== undefined) {
    const email = normalizeEmail(patch.email);
    if (email !== current.email) {
      data.email = email;
      emailChanged = true;
    }
  }
  if (patch.gender !== undefined) {
    data.gender = patch.gender;
  }
  if (patch.city !== undefined) {
    data.city = normalizeName(patch.city);
  }

  const next: ProfileFields = {
    firstName: data.firstName === undefined ? current.firstName : data.firstName,
    lastName: data.lastName === undefined ? current.lastName : data.lastName,
    birthDate: data.birthDate === undefined ? current.birthDate : data.birthDate,
    email: data.email === undefined ? current.email : data.email,
    gender: data.gender === undefined ? current.gender : data.gender,
    city: data.city === undefined ? current.city : data.city,
  };
  const completedNow = current.profileCompletedAt === null && isProfileComplete(next);
  if (completedNow) {
    data.profileCompletedAt = now;
  }
  return { data, completedNow, emailChanged };
}
