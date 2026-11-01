import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { OutboxJobData } from '../../../common/outbox/outbox.types';
import { QUEUES } from '../../../common/queue/queue.constants';
import { Clock } from '../../../common/time/clock';
import { ClubAccountService } from '../services/club-account.service';
import { ClubJobsService } from '../services/club-jobs.service';
import { LedgerService } from '../services/ledger.service';
import { type ClubEventOutcome, handleClubEvent } from './club-events.handler';
import { type ClubJobResult, type ClubJobsDeps, runClubJob } from './club-jobs.handler';

function jobsDeps(
  ledger: LedgerService,
  jobs: ClubJobsService,
  clock: Clock,
  logger: Logger,
): ClubJobsDeps {
  return {
    now: () => clock.now(),
    releaseDueHolds: (asOf) => jobs.releaseDueHolds(asOf),
    expire: (asOf) => ledger.expire(asOf),
    sendExpiryReminders: (asOf) => jobs.sendExpiryReminders(asOf),
    checkBalanceDrift: () => jobs.checkBalanceDrift(),
    log: (message) => logger.log(message),
    warn: (message) => logger.warn(message),
  };
}

/** BullMQ wiring only; the logic lives in runClubJob (unit tested). Hourly. */
@Processor(QUEUES.pointsReleaseHolds, { concurrency: 1 })
export class PointsReleaseHoldsProcessor extends WorkerHost {
  private readonly logger = new Logger(PointsReleaseHoldsProcessor.name);

  constructor(
    private readonly ledger: LedgerService,
    private readonly jobs: ClubJobsService,
    private readonly clock: Clock,
  ) {
    super();
  }

  process(job: Job): Promise<ClubJobResult> {
    return runClubJob(job.name, jobsDeps(this.ledger, this.jobs, this.clock, this.logger));
  }
}

/** BullMQ wiring only: daily expiry with reminders, nightly balance drift check. */
@Processor(QUEUES.pointsExpire, { concurrency: 1 })
export class PointsExpireProcessor extends WorkerHost {
  private readonly logger = new Logger(PointsExpireProcessor.name);

  constructor(
    private readonly ledger: LedgerService,
    private readonly jobs: ClubJobsService,
    private readonly clock: Clock,
  ) {
    super();
  }

  process(job: Job): Promise<ClubJobResult> {
    return runClubJob(job.name, jobsDeps(this.ledger, this.jobs, this.clock, this.logger));
  }
}

/** BullMQ wiring only: outbox events consumed by the club (handleClubEvent, unit tested). */
@Processor(QUEUES.clubEvents, { concurrency: 4 })
export class ClubEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(ClubEventsProcessor.name);

  constructor(private readonly accounts: ClubAccountService) {
    super();
  }

  process(job: Job<OutboxJobData>): Promise<ClubEventOutcome> {
    return handleClubEvent(job.name, job.data, {
      ensureAccount: (userId, registeredAt) => this.accounts.ensureAccount(userId, registeredAt),
      grantWelcome: (userId, kind, options) => this.accounts.grantWelcome(userId, kind, options),
      grantProfileFieldBonus: (userId, field, completedAll) =>
        this.accounts.grantProfileFieldBonus(userId, field, completedAll),
      log: (message) => this.logger.log(message),
    });
  }
}
