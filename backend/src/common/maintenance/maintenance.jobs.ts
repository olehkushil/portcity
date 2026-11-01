export const MAINTENANCE_JOBS = {
  idempotencyPurge: 'idempotency-purge',
  outboxPurge: 'outbox-purge',
} as const;

export type MaintenanceJobName = (typeof MAINTENANCE_JOBS)[keyof typeof MAINTENANCE_JOBS];

export const OUTBOX_RETENTION_DAYS = 7;

export interface MaintenanceDeps {
  now: () => Date;
  purgeExpiredIdempotencyKeys: (now: Date) => Promise<number>;
  purgePublishedOutboxEvents: (olderThan: Date) => Promise<number>;
}

export interface MaintenanceOutcome {
  job: string;
  removed: number;
}

/** Plain handler logic (brief section 9: processors only wire). */
export async function runMaintenanceJob(
  name: string,
  deps: MaintenanceDeps,
): Promise<MaintenanceOutcome> {
  switch (name) {
    case MAINTENANCE_JOBS.idempotencyPurge: {
      const removed = await deps.purgeExpiredIdempotencyKeys(deps.now());
      return { job: name, removed };
    }
    case MAINTENANCE_JOBS.outboxPurge: {
      const olderThan = new Date(deps.now().getTime() - OUTBOX_RETENTION_DAYS * 86_400_000);
      const removed = await deps.purgePublishedOutboxEvents(olderThan);
      return { job: name, removed };
    }
    default:
      throw new Error(`Unknown maintenance job "${name}"`);
  }
}
