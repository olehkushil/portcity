import { DAY_KEY_PATTERN } from './expiry';

/**
 * Expiry reminder markers (`points.expiring` at 30 and 7 days, brief section 9).
 *
 * The daily job may run twice for the same day (retry after a partial failure, manual rerun),
 * and notifications deduplicate by outbox event id only, so the club remembers which reminders
 * it already emitted: bucket day -> the `daysLeft` values sent for it.
 *
 * Storage: the jsonb column `loyalty_accounts.expiry_reminders` (schema request club-1, applied
 * by the module_requests migration, which also moved older markers out of `welcome_state`).
 * Past days are pruned on every write, so the object stays tiny.
 */
export type ExpiryReminderState = Record<string, number[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the markers from the raw `expiry_reminders` json; malformed parts are dropped. */
export function parseExpiryReminderState(raw: unknown): ExpiryReminderState {
  if (!isRecord(raw)) {
    return {};
  }
  const result: ExpiryReminderState = {};
  for (const [dayKey, value] of Object.entries(raw)) {
    if (!DAY_KEY_PATTERN.test(dayKey) || !Array.isArray(value)) {
      continue;
    }
    const days = value.filter(
      (day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 0,
    );
    if (days.length > 0) {
      result[dayKey] = [...new Set(days)].sort((a, b) => b - a);
    }
  }
  return result;
}

export function wasReminderSent(
  state: ExpiryReminderState,
  dayKey: string,
  daysLeft: number,
): boolean {
  return state[dayKey]?.includes(daysLeft) ?? false;
}

/** Returns a new state with the marker added and every day before `todayKey` removed. */
export function markReminderSent(
  state: ExpiryReminderState,
  dayKey: string,
  daysLeft: number,
  todayKey: string,
): ExpiryReminderState {
  const result: ExpiryReminderState = {};
  for (const [key, days] of Object.entries(state)) {
    if (key >= todayKey) {
      result[key] = [...days];
    }
  }
  const current = result[dayKey] ?? [];
  if (!current.includes(daysLeft)) {
    result[dayKey] = [...current, daysLeft].sort((a, b) => b - a);
  }
  return result;
}
