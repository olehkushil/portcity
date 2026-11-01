import type { TransformFnParams } from 'class-transformer';

/** Query strings arrive as text (implicit conversion is off): accepts `true`/`false` only. */
export function transformBooleanQuery({ value }: TransformFnParams): unknown {
  if (value === 'true' || value === true) {
    return true;
  }
  if (value === 'false' || value === false) {
    return false;
  }
  return value;
}

export function transformTrim({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** Trims and turns an empty string into null (clearing optional text fields). */
export function transformTrimToNull({ value }: TransformFnParams): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Storage object key: relative path, no `..`, `//`, leading or trailing slash (see StoragePort). */
export const OBJECT_KEY_PATTERN = /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9/_.-]{0,511}(?<!\/)$/;
