import { DomainError } from '../errors/domain-error';
import { CommonErrors } from '../errors/error-codes';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type CursorPayload = Record<string, string | number | boolean | null>;

/** Opaque cursor: base64url(JSON). Payload keys are the sort columns of the last item. */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor<T extends CursorPayload = CursorPayload>(
  cursor: string | undefined | null,
  isValid?: (value: unknown) => value is T,
): T | undefined {
  if (cursor === undefined || cursor === null || cursor === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new DomainError(CommonErrors.PC_COMMON_CURSOR_INVALID, 'Cursor is malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DomainError(CommonErrors.PC_COMMON_CURSOR_INVALID, 'Cursor is malformed');
  }
  if (isValid && !isValid(parsed)) {
    throw new DomainError(CommonErrors.PC_COMMON_CURSOR_INVALID, 'Cursor does not match this list');
  }
  return parsed as T;
}

/**
 * Builds a page from rows fetched with `take: limit + 1`.
 * `cursorOf` receives the last returned item and yields the payload for the next cursor.
 */
export function toPage<T>(rows: T[], limit: number, cursorOf: (last: T) => CursorPayload): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null,
  };
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_LIMIT);
}
