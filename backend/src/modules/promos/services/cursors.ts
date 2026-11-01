import type { CursorPayload } from '../../../common/pagination/cursor';

/** `GET /promos`: ordered by priority desc, id desc. */
export interface PromoCursor extends CursorPayload {
  priority: number;
  id: string;
}

/** Event lists: ordered by startsAt (asc for upcoming, desc for past), then id. */
export interface EventCursor extends CursorPayload {
  startsAt: string;
  id: string;
}

/** Admin lists ordered by id desc (UUID v7 is time-ordered). */
export interface IdCursor extends CursorPayload {
  id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPromoCursor(value: unknown): value is PromoCursor {
  return (
    isRecord(value) &&
    typeof value.priority === 'number' &&
    Number.isFinite(value.priority) &&
    typeof value.id === 'string'
  );
}

export function isEventCursor(value: unknown): value is EventCursor {
  return (
    isRecord(value) &&
    typeof value.startsAt === 'string' &&
    Number.isFinite(new Date(value.startsAt).getTime()) &&
    typeof value.id === 'string'
  );
}

export function isIdCursor(value: unknown): value is IdCursor {
  return isRecord(value) && typeof value.id === 'string';
}
