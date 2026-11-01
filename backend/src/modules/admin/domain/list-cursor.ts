import type { CursorPayload } from '../../../common/pagination/cursor';

/**
 * Keyset pagination over `(createdAt desc, id desc)` shared by the adjustment and audit lists.
 * Ids are UUID v7, so `id` is a stable tie-breaker for rows created in the same millisecond.
 */

export interface ListCursor extends CursorPayload {
  /** ISO 8601 createdAt of the last item on the previous page. */
  createdAt: string;
  id: string;
}

export function isListCursor(value: unknown): value is ListCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const createdAt = record['createdAt'];
  const id = record['id'];
  return (
    typeof createdAt === 'string' &&
    !Number.isNaN(Date.parse(createdAt)) &&
    typeof id === 'string' &&
    id.length > 0
  );
}

export function cursorOf(row: { createdAt: Date; id: string }): ListCursor {
  return { createdAt: row.createdAt.toISOString(), id: row.id };
}

/** Prisma-compatible `where` fragment selecting rows strictly after the cursor in the sort order. */
export interface KeysetWhere {
  OR: [{ createdAt: { lt: Date } }, { createdAt: Date; id: { lt: string } }];
}

export function keysetWhere(cursor: ListCursor): KeysetWhere {
  const at = new Date(cursor.createdAt);
  return { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] };
}

export const LIST_ORDER = [{ createdAt: 'desc' }, { id: 'desc' }] as const;
