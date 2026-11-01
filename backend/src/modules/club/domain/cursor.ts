import { type CursorPayload, decodeCursor, encodeCursor } from '../../../common/pagination/cursor';

/** Cursor of the transactions list: sort key of the last returned row (createdAt desc, id desc). */
export interface TransactionCursor {
  createdAt: Date;
  id: string;
}

interface TransactionCursorPayload extends CursorPayload {
  c: string;
  i: string;
}

function isTransactionCursorPayload(value: unknown): value is TransactionCursorPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.c === 'string' &&
    typeof record.i === 'string' &&
    !Number.isNaN(new Date(record.c).getTime())
  );
}

export function encodeTransactionCursor(cursor: TransactionCursor): string {
  return encodeCursor({ c: cursor.createdAt.toISOString(), i: cursor.id });
}

export function decodeTransactionCursor(raw: string | undefined): TransactionCursor | undefined {
  const payload = decodeCursor(raw, isTransactionCursorPayload);
  return payload ? { createdAt: new Date(payload.c), id: payload.i } : undefined;
}
