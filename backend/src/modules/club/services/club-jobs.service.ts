import { Injectable, Logger } from '@nestjs/common';
import { CLUB_EVENTS, OUTBOX_AGGREGATES, buildOutboxEvent } from '../../../common/contracts/events';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { Clock } from '../../../common/time/clock';
import { kyivDayKey } from '../../../common/time/kyiv';
import { type BalanceDrift, detectBalanceDrift } from '../domain/drift';
import { reminderTargets } from '../domain/expiry';
import { markReminderSent, wasReminderSent } from '../domain/reminders';
import { ClubRepository } from './club.repository';
import { LedgerService } from './ledger.service';
import { RuleSetsService } from './rule-sets.service';

export interface ReleaseHoldsResult {
  released: number;
  failed: number;
}

export interface ReminderRunResult {
  todayKey: string;
  sent: number;
  skipped: number;
  failed: number;
  targets: Array<{ dayKey: string; daysLeft: number; sent: number }>;
}

export interface DriftCheckResult {
  checked: number;
  drifted: number;
  /** First drifts found (the full list is in the logs). */
  drifts: BalanceDrift[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Batch work behind the club's scheduled jobs (brief section 9): hourly release of pending
 * holds, expiry reminders (`points.expiring`, at most once per account, bucket day and
 * threshold) and the nightly balance drift report. Expiry itself is `LedgerService.expire()`.
 * Every unit of work runs in its own short transaction; failures are counted and logged.
 */
@Injectable()
export class ClubJobsService {
  static readonly BATCH = 200;
  /** Safety valve for the release loop (200 x 50 = 10 000 holds per run). */
  static readonly MAX_RELEASE_ROUNDS = 50;
  static readonly MAX_REPORTED_DRIFTS = 50;

  private readonly logger = new Logger(ClubJobsService.name);

  constructor(
    private readonly repo: ClubRepository,
    private readonly ledger: LedgerService,
    private readonly ruleSets: RuleSetsService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  /** `points-release-holds`: pending credits whose availableAt has passed become available. */
  async releaseDueHolds(asOf?: Date): Promise<ReleaseHoldsResult> {
    const now = asOf ?? this.clock.now();
    const result: ReleaseHoldsResult = { released: 0, failed: 0 };
    const failedIds = new Set<string>();
    for (let round = 0; round < ClubJobsService.MAX_RELEASE_ROUNDS; round += 1) {
      const batch = await this.repo.listReleasableHolds(now, ClubJobsService.BATCH);
      const todo = batch.filter((entry) => !failedIds.has(entry.id));
      if (todo.length === 0) {
        break;
      }
      for (const entry of todo) {
        try {
          await this.ledger.release(entry.id);
          result.released += 1;
        } catch (error) {
          result.failed += 1;
          failedIds.add(entry.id);
          this.logger.error(`Release of hold ${entry.id} failed: ${errorMessage(error)}`);
        }
      }
      if (batch.length < ClubJobsService.BATCH) {
        break;
      }
    }
    return result;
  }

  /**
   * `points.expiring` for buckets expiring exactly `d` days from today for each configured `d`
   * (30 and 7 by default). The marker on the account makes reruns on the same day harmless.
   */
  async sendExpiryReminders(asOf?: Date): Promise<ReminderRunResult> {
    const now = asOf ?? this.clock.now();
    const todayKey = kyivDayKey(now);
    const rules = (await this.ruleSets.getActiveRules()).rules;
    const result: ReminderRunResult = { todayKey, sent: 0, skipped: 0, failed: 0, targets: [] };
    for (const target of reminderTargets(todayKey, rules.expiryReminderDays)) {
      let sentForTarget = 0;
      let after: string | null = null;
      for (;;) {
        const batch = await this.repo.listBucketsOnDay(target.dayKey, after, ClubJobsService.BATCH);
        for (const bucket of batch) {
          after = bucket.accountId;
          try {
            const sent = await this.remind(
              bucket.accountId,
              target.dayKey,
              target.daysLeft,
              todayKey,
              now,
            );
            if (sent) {
              result.sent += 1;
              sentForTarget += 1;
            } else {
              result.skipped += 1;
            }
          } catch (error) {
            result.failed += 1;
            this.logger.error(
              `Expiry reminder ${bucket.accountId}/${target.dayKey} failed: ${errorMessage(error)}`,
            );
          }
        }
        if (batch.length < ClubJobsService.BATCH) {
          break;
        }
      }
      result.targets.push({ ...target, sent: sentForTarget });
    }
    return result;
  }

  /**
   * Nightly drift report (brief section 5): recomputes balances from the ledger under the
   * account lock and checks the bucket invariant. It reports and never rewrites balances.
   */
  async checkBalanceDrift(): Promise<DriftCheckResult> {
    const result: DriftCheckResult = { checked: 0, drifted: 0, drifts: [] };
    let afterId: string | null = null;
    for (;;) {
      const accounts = await this.repo.listAccounts(afterId, ClubJobsService.BATCH);
      for (const listed of accounts) {
        afterId = listed.id;
        const drift = await this.repo.inTx(undefined, async (db) => {
          const account = await this.repo.lockAccount(db, listed.id);
          if (!account) {
            return null;
          }
          const ledger = await this.repo.recomputeBalances(account.id, db);
          const bucketsSum = await this.repo.sumBuckets(account.id, db);
          return detectBalanceDrift(account, ledger, bucketsSum);
        });
        result.checked += 1;
        if (drift) {
          result.drifted += 1;
          if (result.drifts.length < ClubJobsService.MAX_REPORTED_DRIFTS) {
            result.drifts.push(drift);
          }
          this.logger.warn(
            `Balance drift on account ${drift.accountId} (${drift.kinds.join(', ')}): cached ${JSON.stringify(drift.cached)}, ledger ${JSON.stringify(drift.ledger)}, buckets ${drift.bucketsSum}/${drift.expectedBuckets}`,
          );
        }
      }
      if (accounts.length < ClubJobsService.BATCH) {
        break;
      }
    }
    return result;
  }

  private remind(
    accountId: string,
    dayKey: string,
    daysLeft: number,
    todayKey: string,
    now: Date,
  ): Promise<boolean> {
    return this.repo.inTx(undefined, async (db) => {
      const account = await this.repo.lockAccount(db, accountId);
      if (!account || wasReminderSent(account.expiryReminders, dayKey, daysLeft)) {
        return false;
      }
      const bucket = await this.repo.findBucket(accountId, dayKey, db);
      if (!bucket || bucket.remaining <= 0) {
        return false;
      }
      await this.outbox.publish(
        db,
        buildOutboxEvent(
          CLUB_EVENTS.expiring,
          OUTBOX_AGGREGATES.loyaltyAccount,
          accountId,
          {
            userId: account.userId,
            accountId,
            points: bucket.remaining,
            expiresOn: dayKey,
            daysLeft,
          },
          now,
        ),
      );
      await this.repo.updateAccount(db, accountId, {
        expiryReminders: markReminderSent(account.expiryReminders, dayKey, daysLeft, todayKey),
      });
      return true;
    });
  }
}
