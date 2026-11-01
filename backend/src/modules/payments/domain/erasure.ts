/**
 * Personal data in payment rows (user.deleted). Payments are financial records and stay with
 * their amounts, statuses and the anonymised owner; only personal details that callers or the
 * module copied into `meta` are removed. Pure module: no Nest, no Prisma.
 */

/** Top-level caller meta keys (and `_internal` keys) that may hold personal data. */
export const PERSONAL_META_KEYS: readonly string[] = [
  'plate',
  'plateDisplay',
  'phone',
  'email',
  'name',
  'firstName',
  'lastName',
  'fullName',
  'birthDate',
];

/** Key of the module's internal block (same value as INTERNAL_META_KEY in payment.mapper). */
const INTERNAL_KEY = '_internal';

/** Neutral checkout description that replaces one built with personal details (plate). */
export function neutralDescription(purpose: string): string {
  return purpose === 'parking' ? 'Паркінг Порт City' : 'Платіж Порт City';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withoutPersonalKeys(source: Record<string, unknown>): {
  value: Record<string, unknown>;
  changed: boolean;
} {
  let changed = false;
  const value: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (PERSONAL_META_KEYS.includes(key)) {
      changed = true;
      continue;
    }
    value[key] = item;
  }
  return { value, changed };
}

export interface ErasedMeta {
  meta: Record<string, unknown>;
  changed: boolean;
}

/**
 * Returns `meta` without personal keys at the top level and inside `_internal`, with the
 * internal checkout description (which embeds the plate for parking) replaced by a neutral one.
 * Idempotent: erasing an erased meta reports `changed: false`.
 */
export function erasePersonalMeta(meta: unknown, purpose: string): ErasedMeta {
  if (!isRecord(meta)) {
    return { meta: {}, changed: meta !== null && meta !== undefined };
  }
  const top = withoutPersonalKeys(meta);
  let changed = top.changed;
  const result = top.value;
  const internal = result[INTERNAL_KEY];
  if (isRecord(internal)) {
    const inner = withoutPersonalKeys(internal);
    changed = changed || inner.changed;
    const description = neutralDescription(purpose);
    if (
      typeof inner.value['description'] === 'string' &&
      inner.value['description'] !== description
    ) {
      inner.value['description'] = description;
      changed = true;
    }
    result[INTERNAL_KEY] = inner.value;
  }
  return { meta: result, changed };
}
