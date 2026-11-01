import { PROFILE_FIELDS, type ProfileField } from '../../../common/contracts/identity';
import { profileCompleteBonusKey, profileFieldBonusKey } from './ledger-keys';

/**
 * Profile bonuses (product decision): PROFILE_BONUS_PER_FIELD points for every profile field
 * the member fills in and PROFILE_BONUS_COMPLETE once all fields are filled, consumed from
 * `user.profile_field_completed { userId, field, allFieldsCompleted }`. Each bonus is granted
 * once per member and field (fixed ledger keys), so redelivered events are harmless. These are
 * separate from the rule-set welcome bonus for `user.profile_completed`; set `welcome.profile`
 * to 0 in a new rule set version to pay only the per-field scheme.
 */

const FIELD_LABELS: Readonly<Record<ProfileField, string>> = Object.freeze({
  firstName: "Ім'я",
  lastName: 'Прізвище',
  birthDate: 'Дата народження',
  email: 'E-mail',
  gender: 'Стать',
  city: 'Місто',
  children: 'Діти',
});

/** Only the fields identity counts (PROFILE_FIELDS) earn a bonus; anything else is ignored. */
export function isProfileField(field: string): field is ProfileField {
  return (PROFILE_FIELDS as readonly string[]).includes(field);
}

export const PROFILE_FIELD_BONUS_TITLE = 'Бонус за профіль';
export const PROFILE_COMPLETE_BONUS_TITLE = 'Бонус за заповнений профіль';

export function profileFieldLabel(field: ProfileField): string {
  return FIELD_LABELS[field];
}

export interface ProfileBonusConfig {
  perField: number;
  complete: number;
}

export interface PlannedProfileBonus {
  kind: 'field' | 'complete';
  idempotencyKey: string;
  amount: number;
  title: string;
  subtitle: string;
}

export type ProfileBonusPlan =
  { ok: true; bonuses: PlannedProfileBonus[] } | { ok: false; reason: 'invalid_field' };

/** Which bonuses an event may grant (zero-configured bonuses are skipped). */
export function planProfileBonuses(
  userId: string,
  field: string,
  completedAll: boolean,
  config: ProfileBonusConfig,
): ProfileBonusPlan {
  if (!isProfileField(field)) {
    return { ok: false, reason: 'invalid_field' };
  }
  const bonuses: PlannedProfileBonus[] = [];
  if (Number.isSafeInteger(config.perField) && config.perField > 0) {
    bonuses.push({
      kind: 'field',
      idempotencyKey: profileFieldBonusKey(field, userId),
      amount: config.perField,
      title: PROFILE_FIELD_BONUS_TITLE,
      subtitle: profileFieldLabel(field),
    });
  }
  if (completedAll && Number.isSafeInteger(config.complete) && config.complete > 0) {
    bonuses.push({
      kind: 'complete',
      idempotencyKey: profileCompleteBonusKey(userId),
      amount: config.complete,
      title: PROFILE_COMPLETE_BONUS_TITLE,
      subtitle: 'Усі поля профілю заповнено',
    });
  }
  return { ok: true, bonuses };
}
