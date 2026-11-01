import type { TransformFnParams } from 'class-transformer';

/**
 * Query strings arrive as text and the global ValidationPipe does not convert implicitly
 * (`enableImplicitConversion: false`), so boolean filters are converted here and then
 * validated with `@IsBoolean()`. Anything unrecognised is passed through to fail validation.
 */
export function toOptionalBoolean({ value }: TransformFnParams): unknown {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value === true || value === 'true' || value === '1') {
    return true;
  }
  if (value === false || value === 'false' || value === '0') {
    return false;
  }
  return value;
}

export function trimmed({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * `?status=issued,active` and `?status=issued&status=active` both become
 * `['issued', 'active']` (trimmed, empty parts dropped, duplicates removed); an empty value
 * means no filter. Unknown values survive to fail `@IsIn(..., { each: true })`.
 */
export function toCommaList({ value }: TransformFnParams): unknown {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parts = (Array.isArray(value) ? value : [value]).flatMap((item: unknown) =>
    typeof item === 'string' ? item.split(',') : [item],
  );
  const cleaned = parts
    .map((part) => (typeof part === 'string' ? part.trim() : part))
    .filter((part) => part !== '');
  return cleaned.length === 0 ? undefined : [...new Set(cleaned)];
}

/** ISO 8601 strings become Dates after validation; null and undefined pass through. */
export function toDateOrNull({ value }: TransformFnParams): unknown {
  if (value === undefined || value === null || value === '') {
    return value === '' ? null : value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string') {
    const time = Date.parse(value);
    return Number.isNaN(time) ? value : new Date(time);
  }
  return value;
}
