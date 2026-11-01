/**
 * Primitives shared by every contract file. Foundation-owned.
 *
 * Contract files contain only types, constants and pure functions. The single runtime-free
 * exception is the type-only import of `Tx` below: every port implementation is Prisma-based,
 * so ports accept the caller's open transaction and join it instead of opening their own.
 */
import type { Tx } from '../prisma/prisma.service';

export type { Tx };

/** UUID v7 string (`uuidv7()`); every id in the system. */
export type Uuid = string;

/** ISO 8601 timestamp in UTC (`date.toISOString()`); the only date format inside JSON payloads. */
export type IsoDateTime = string;

/** Calendar day in Kyiv time, `yyyy-MM-dd` (`kyivDayKey()`). */
export type KyivDay = string;

/** Integer number of kopecks (1 UAH = 100 kopecks). Never a float. */
export type Kopecks = number;

/** Integer number of loyalty points. */
export type Points = number;

export const ACTOR_TYPES = ['admin', 'system', 'user'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** Who performed an action: a back-office user, a member, or a job/system component. */
export interface ActorRef {
  type: ActorType;
  /** AdminUser id, User id, or a stable component name for `system` (e.g. `points-expire`). */
  id?: string | null;
}

export const SYSTEM_ACTOR: ActorRef = Object.freeze({ type: 'system', id: 'system' });

/** Half-open UTC interval `[from, to)` used by statistics methods. */
export interface DateRange {
  from: Date;
  to: Date;
}

/** Cursor page shape returned by every list endpoint (`src/common/pagination`). */
export interface PageOf<T> {
  items: T[];
  nextCursor: string | null;
}
