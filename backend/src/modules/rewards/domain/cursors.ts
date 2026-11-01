import type { CursorPayload } from '../../../common/pagination/cursor';

/**
 * Cursor payload shapes used by the rewards lists. Lists are ordered deterministically:
 * catalogue by (sortOrder asc, id asc); vouchers, devices and logs by (createdAt desc, id desc).
 */

export interface SortOrderCursor extends CursorPayload {
  sortOrder: number;
  id: string;
}

export interface CreatedAtCursor extends CursorPayload {
  /** ISO 8601 UTC. */
  createdAt: string;
  id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSortOrderCursor(value: unknown): value is SortOrderCursor {
  return (
    isRecord(value) &&
    typeof value['sortOrder'] === 'number' &&
    Number.isInteger(value['sortOrder']) &&
    typeof value['id'] === 'string'
  );
}

export function isCreatedAtCursor(value: unknown): value is CreatedAtCursor {
  return (
    isRecord(value) &&
    typeof value['createdAt'] === 'string' &&
    !Number.isNaN(Date.parse(value['createdAt'])) &&
    typeof value['id'] === 'string'
  );
}

export function sortOrderCursorOf(item: { sortOrder: number; id: string }): SortOrderCursor {
  return { sortOrder: item.sortOrder, id: item.id };
}

export function createdAtCursorOf(item: { createdAt: Date; id: string }): CreatedAtCursor {
  return { createdAt: item.createdAt.toISOString(), id: item.id };
}

/** Comparator for (createdAt desc, id desc) used by in-memory implementations and tests. */
export function compareCreatedAtDesc(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
}

/** Comparator for (sortOrder asc, id asc). */
export function compareSortOrderAsc(
  a: { sortOrder: number; id: string },
  b: { sortOrder: number; id: string },
): number {
  if (a.sortOrder !== b.sortOrder) {
    return a.sortOrder - b.sortOrder;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** True when `item` comes strictly after the cursor position in (createdAt desc, id desc). */
export function isAfterCreatedAtCursor(
  item: { createdAt: Date; id: string },
  cursor: CreatedAtCursor,
): boolean {
  const cursorTime = Date.parse(cursor.createdAt);
  const time = item.createdAt.getTime();
  return time < cursorTime || (time === cursorTime && item.id < cursor.id);
}

/** True when `item` comes strictly after the cursor position in (sortOrder asc, id asc). */
export function isAfterSortOrderCursor(
  item: { sortOrder: number; id: string },
  cursor: SortOrderCursor,
): boolean {
  return (
    item.sortOrder > cursor.sortOrder ||
    (item.sortOrder === cursor.sortOrder && item.id > cursor.id)
  );
}
