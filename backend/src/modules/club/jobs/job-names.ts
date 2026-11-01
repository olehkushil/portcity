import {
  IDENTITY_EVENTS,
  RECEIPT_EVENTS,
  type OutboxEventType,
} from '../../../common/contracts/events';
import { QUEUES } from '../../../common/queue/queue.constants';

/** Job names on the club's own queues (brief section 9). */
export const CLUB_JOBS = {
  /** `points-release-holds`, hourly. */
  releaseHolds: 'release-holds',
  /** `points-expire`, daily 03:30 Kyiv: FIFO bucket expiry, then the 30/7-day reminders. */
  expire: 'expire',
  /** `points-expire`, nightly 04:15 Kyiv: cached balances vs ledger and buckets. */
  driftCheck: 'drift-check',
} as const;
export type ClubJobName = (typeof CLUB_JOBS)[keyof typeof CLUB_JOBS];

export interface ClubScheduleDefinition {
  id: string;
  queue: string;
  jobName: ClubJobName;
  pattern: string;
}

/** Cron patterns are evaluated in Europe/Kyiv by WorkerSchedules. */
export const CLUB_SCHEDULES: readonly ClubScheduleDefinition[] = Object.freeze([
  {
    id: 'points-release-holds-hourly',
    queue: QUEUES.pointsReleaseHolds,
    jobName: CLUB_JOBS.releaseHolds,
    pattern: '5 * * * *',
  },
  {
    id: 'points-expire-daily',
    queue: QUEUES.pointsExpire,
    jobName: CLUB_JOBS.expire,
    pattern: '30 3 * * *',
  },
  {
    id: 'points-balance-drift-nightly',
    queue: QUEUES.pointsExpire,
    jobName: CLUB_JOBS.driftCheck,
    pattern: '15 4 * * *',
  },
]);

/** Outbox events the club consumes on `club-events` (job name = event type). */
export const CLUB_CONSUMED_EVENTS: readonly OutboxEventType[] = Object.freeze([
  IDENTITY_EVENTS.registered,
  IDENTITY_EVENTS.profileCompleted,
  IDENTITY_EVENTS.profileFieldCompleted,
  RECEIPT_EVENTS.credited,
]);
