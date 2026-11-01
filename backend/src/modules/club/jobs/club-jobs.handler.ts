import type {
  DriftCheckResult,
  ReleaseHoldsResult,
  ReminderRunResult,
} from '../services/club-jobs.service';
import type { ExpireRunResult } from '../services/ledger.service';
import { CLUB_JOBS } from './job-names';

export interface ClubJobsDeps {
  now(): Date;
  releaseDueHolds(asOf: Date): Promise<ReleaseHoldsResult>;
  expire(asOf: Date): Promise<ExpireRunResult>;
  sendExpiryReminders(asOf: Date): Promise<ReminderRunResult>;
  checkBalanceDrift(): Promise<DriftCheckResult>;
  log(message: string): void;
  warn(message: string): void;
}

export type ClubJobResult =
  | { job: 'release-holds'; release: ReleaseHoldsResult }
  | { job: 'expire'; expiry: ExpireRunResult; reminders: ReminderRunResult }
  | { job: 'drift-check'; drift: DriftCheckResult };

/**
 * Logic of the club's scheduled jobs; the processors only call this. All three are safe to
 * rerun: released holds and expired buckets are skipped, reminders are marked per account.
 */
export async function runClubJob(name: string, deps: ClubJobsDeps): Promise<ClubJobResult> {
  const now = deps.now();
  switch (name) {
    case CLUB_JOBS.releaseHolds: {
      const release = await deps.releaseDueHolds(now);
      deps.log(`points-release-holds: released ${release.released}, failed ${release.failed}`);
      return { job: CLUB_JOBS.releaseHolds, release };
    }
    case CLUB_JOBS.expire: {
      const expiry = await deps.expire(now);
      deps.log(
        `points-expire: ${expiry.points} points in ${expiry.buckets} buckets of ${expiry.accounts} accounts before ${expiry.cutoffDayKey}, failed ${expiry.failed}`,
      );
      const reminders = await deps.sendExpiryReminders(now);
      deps.log(
        `points-expire reminders: sent ${reminders.sent}, skipped ${reminders.skipped}, failed ${reminders.failed}`,
      );
      return { job: CLUB_JOBS.expire, expiry, reminders };
    }
    case CLUB_JOBS.driftCheck: {
      const drift = await deps.checkBalanceDrift();
      const message = `points balance drift check: ${drift.checked} accounts, ${drift.drifted} drifted`;
      if (drift.drifted > 0) {
        deps.warn(message);
      } else {
        deps.log(message);
      }
      return { job: CLUB_JOBS.driftCheck, drift };
    }
    default:
      throw new Error(`Unknown club job "${name}"`);
  }
}
