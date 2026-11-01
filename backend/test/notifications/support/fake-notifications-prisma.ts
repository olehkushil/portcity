import type { Notification, NotificationPreference, PushDelivery } from '@prisma/client';

type Where = Record<string, unknown>;

interface FindManyArgs {
  where?: Where;
  orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
  take?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameInstant(a: Date | null, b: unknown): boolean {
  return a !== null && b instanceof Date && a.getTime() === b.getTime();
}

/** Subset of Prisma's where semantics used by the notifications services. */
function matchesWhere(row: Record<string, unknown>, where: Where | undefined): boolean {
  if (!where) {
    return true;
  }
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'AND') {
      const list = Array.isArray(condition) ? condition : [condition];
      if (!list.every((entry) => matchesWhere(row, entry as Where))) {
        return false;
      }
      continue;
    }
    if (key === 'OR') {
      if (!(condition as Where[]).some((entry) => matchesWhere(row, entry))) {
        return false;
      }
      continue;
    }
    const value = row[key];
    if (key === 'data' && isRecord(condition)) {
      const path = condition.path as string[] | undefined;
      const field = path?.[0];
      const data = isRecord(value) ? value : {};
      if (field !== undefined && data[field] !== condition.equals) {
        return false;
      }
      continue;
    }
    if (condition === null) {
      if (value !== null) {
        return false;
      }
      continue;
    }
    if (condition instanceof Date) {
      if (!sameInstant(value as Date | null, condition)) {
        return false;
      }
      continue;
    }
    if (isRecord(condition)) {
      if ('lt' in condition) {
        const bound = condition.lt;
        if (value instanceof Date && bound instanceof Date) {
          if (!(value.getTime() < bound.getTime())) {
            return false;
          }
        } else if (!(String(value) < String(bound))) {
          return false;
        }
      }
      if ('not' in condition && condition.not === null && value === null) {
        return false;
      }
      if ('in' in condition && Array.isArray(condition.in) && !condition.in.includes(value)) {
        return false;
      }
      continue;
    }
    if (value !== condition) {
      return false;
    }
  }
  return true;
}

function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  orderBy: FindManyArgs['orderBy'],
): T[] {
  if (!orderBy) {
    return rows;
  }
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      for (const [field, direction] of Object.entries(clause)) {
        const left = a[field];
        const right = b[field];
        const l = left instanceof Date ? left.getTime() : String(left);
        const r = right instanceof Date ? right.getTime() : String(right);
        if (l === r) {
          continue;
        }
        const result = l < r ? -1 : 1;
        return direction === 'desc' ? -result : result;
      }
    }
    return 0;
  });
}

/**
 * In-memory stand-in for the three notification tables plus `withTx`/`runInTx`.
 * Covers exactly the Prisma calls made by the notifications services.
 */
export class FakeNotificationsPrisma {
  readonly notifications: Notification[] = [];
  readonly preferences: NotificationPreference[] = [];
  readonly deliveries: PushDelivery[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  readonly notification = {
    findFirst: async (args: FindManyArgs): Promise<Notification | null> =>
      (sortRows(this.notifications as unknown as Record<string, unknown>[], args.orderBy).find(
        (row) => matchesWhere(row, args.where),
      ) as unknown as Notification | null) ?? null,
    findUnique: async (args: { where: { id: string } }): Promise<Notification | null> =>
      this.notifications.find((row) => row.id === args.where.id) ?? null,
    findMany: async (args: FindManyArgs): Promise<Notification[]> => {
      const rows = sortRows(
        this.notifications as unknown as Record<string, unknown>[],
        args.orderBy,
      ).filter((row) => matchesWhere(row, args.where)) as unknown as Notification[];
      return args.take !== undefined ? rows.slice(0, args.take) : rows;
    },
    count: async (args: { where?: Where }): Promise<number> =>
      this.notifications.filter((row) =>
        matchesWhere(row as unknown as Record<string, unknown>, args.where),
      ).length,
    create: async (args: { data: Record<string, unknown> }): Promise<Notification> => {
      const row = this.toNotification(args.data);
      if (this.violatesDedupe(row)) {
        throw Object.assign(new Error('Unique constraint failed on (user_id, dedupe_key)'), {
          code: 'P2002',
        });
      }
      this.notifications.push(row);
      return row;
    },
    /** ON CONFLICT DO NOTHING semantics of `skipDuplicates` on the (userId, dedupeKey) index. */
    createMany: async (args: {
      data: Array<Record<string, unknown>>;
      skipDuplicates?: boolean;
    }): Promise<{ count: number }> => {
      let count = 0;
      for (const entry of args.data) {
        const row = this.toNotification(entry);
        if (this.violatesDedupe(row)) {
          if (args.skipDuplicates) {
            continue;
          }
          throw Object.assign(new Error('Unique constraint failed on (user_id, dedupe_key)'), {
            code: 'P2002',
          });
        }
        this.notifications.push(row);
        count += 1;
      }
      return { count };
    },
    /** Deleting notifications cascades to their push deliveries (ON DELETE CASCADE). */
    deleteMany: async (args: { where?: Where }): Promise<{ count: number }> => {
      const removed = this.notifications.filter((row) =>
        matchesWhere(row as unknown as Record<string, unknown>, args.where),
      );
      const ids = new Set(removed.map((row) => row.id));
      this.remove(this.notifications, (row) => ids.has(row.id));
      this.remove(this.deliveries, (row) => ids.has(row.notificationId));
      return { count: removed.length };
    },
    update: async (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<Notification> => {
      const row = this.notifications.find((entry) => entry.id === args.where.id);
      if (!row) {
        throw new Error(`notification ${args.where.id} not found`);
      }
      Object.assign(row, args.data);
      return row;
    },
    updateMany: async (args: {
      where?: Where;
      data: Record<string, unknown>;
    }): Promise<{ count: number }> => {
      let count = 0;
      for (const row of this.notifications) {
        if (matchesWhere(row, args.where)) {
          Object.assign(row, args.data);
          count += 1;
        }
      }
      return { count };
    },
  };

  readonly notificationPreference = {
    deleteMany: async (args: { where?: Where }): Promise<{ count: number }> => ({
      count: this.remove(this.preferences, (row) =>
        matchesWhere(row as unknown as Record<string, unknown>, args.where),
      ),
    }),
    findUnique: async (args: {
      where: { userId_kind: { userId: string; kind: string } };
    }): Promise<NotificationPreference | null> =>
      this.preferences.find(
        (row) =>
          row.userId === args.where.userId_kind.userId && row.kind === args.where.userId_kind.kind,
      ) ?? null,
    findMany: async (args: { where?: Where }): Promise<NotificationPreference[]> =>
      this.preferences.filter((row) =>
        matchesWhere(row as unknown as Record<string, unknown>, args.where),
      ),
    upsert: async (args: {
      where: { userId_kind: { userId: string; kind: string } };
      create: { userId: string; kind: string; enabled: boolean; updatedAt?: Date };
      update: { enabled: boolean; updatedAt?: Date };
    }): Promise<NotificationPreference> => {
      const existing = this.preferences.find(
        (row) =>
          row.userId === args.where.userId_kind.userId && row.kind === args.where.userId_kind.kind,
      );
      if (existing) {
        existing.enabled = args.update.enabled;
        existing.updatedAt = args.update.updatedAt ?? this.now();
        return existing;
      }
      const row: NotificationPreference = {
        userId: args.create.userId,
        kind: args.create.kind,
        enabled: args.create.enabled,
        updatedAt: args.create.updatedAt ?? this.now(),
      };
      this.preferences.push(row);
      return row;
    },
  };

  readonly pushDelivery = {
    findMany: async (args: FindManyArgs): Promise<PushDelivery[]> =>
      sortRows(this.deliveries as unknown as Record<string, unknown>[], args.orderBy).filter(
        (row) => matchesWhere(row, args.where),
      ) as unknown as PushDelivery[],
    create: async (args: { data: Record<string, unknown> }): Promise<PushDelivery> => {
      const data = args.data;
      const row: PushDelivery = {
        id: String(data.id),
        notificationId: String(data.notificationId),
        deviceId: String(data.deviceId),
        provider: typeof data.provider === 'string' ? data.provider : 'fcm',
        status: (data.status ?? 'queued') as PushDelivery['status'],
        error: (data.error as string | null | undefined) ?? null,
        attempts: Number(data.attempts ?? 0),
        sentAt: (data.sentAt as Date | null | undefined) ?? null,
        createdAt: (data.createdAt as Date | undefined) ?? this.now(),
        updatedAt: (data.updatedAt as Date | undefined) ?? this.now(),
      };
      this.deliveries.push(row);
      return row;
    },
    update: async (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<PushDelivery> => {
      const row = this.deliveries.find((entry) => entry.id === args.where.id);
      if (!row) {
        throw new Error(`push delivery ${args.where.id} not found`);
      }
      const { attempts, ...rest } = args.data;
      Object.assign(row, rest);
      if (isRecord(attempts) && typeof attempts.increment === 'number') {
        row.attempts += attempts.increment;
      } else if (typeof attempts === 'number') {
        row.attempts = attempts;
      }
      return row;
    },
  };

  private toNotification(data: Record<string, unknown>): Notification {
    return {
      id: String(data.id),
      userId: String(data.userId),
      kind: String(data.kind),
      title: String(data.title),
      body: String(data.body),
      data: data.data ?? {},
      channel: (data.channel ?? 'inapp') as Notification['channel'],
      sentAt: (data.sentAt as Date | null | undefined) ?? null,
      readAt: (data.readAt as Date | null | undefined) ?? null,
      dedupeKey: typeof data.dedupeKey === 'string' ? data.dedupeKey : null,
      createdAt: (data.createdAt as Date | undefined) ?? this.now(),
    };
  }

  private violatesDedupe(row: Notification): boolean {
    return (
      row.dedupeKey !== null &&
      this.notifications.some(
        (existing) => existing.userId === row.userId && existing.dedupeKey === row.dedupeKey,
      )
    );
  }

  /** Removes matching rows in place and returns how many were removed. */
  private remove<T>(rows: T[], predicate: (row: T) => boolean): number {
    let removed = 0;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row !== undefined && predicate(row)) {
        rows.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }

  withTx<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  runInTx<T>(tx: unknown, fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }
}
