/** Back-office principal performing an audited change. */
export interface AdminActor {
  id: string;
  ip?: string | null;
}

export interface IdCursor extends Record<string, string> {
  id: string;
}

export interface NameIdCursor extends Record<string, string> {
  name: string;
  id: string;
}

export function isIdCursor(value: unknown): value is IdCursor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

export function isNameIdCursor(value: unknown): value is NameIdCursor {
  return isIdCursor(value) && typeof (value as { name?: unknown }).name === 'string';
}

/** Picks the listed keys of an object (audit snapshots of changed fields). */
export function pick<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    result[key] = source[key];
  }
  return result;
}
