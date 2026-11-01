import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../../../common/queue/queue.constants';
import { Clock } from '../../../common/time/clock';
import { ReportsService } from '../services/reports.service';
import {
  type ReportsNightlyJobData,
  type ReportsNightlyOutcome,
  runReportsNightly,
} from './reports-nightly.job';

/** Worker-side wiring of the reports-nightly queue (brief section 9). */
@Processor(QUEUES.reportsNightly, { concurrency: 1 })
export class ReportsNightlyProcessor extends WorkerHost {
  private readonly logger = new Logger(ReportsNightlyProcessor.name);

  constructor(
    private readonly reports: ReportsService,
    private readonly clock: Clock,
  ) {
    super();
  }

  async process(job: Job<ReportsNightlyJobData | undefined>): Promise<ReportsNightlyOutcome> {
    const outcome = await runReportsNightly(job.name, job.data, {
      now: () => this.clock.now(),
      hasReport: (day) => this.reports.hasStored(day),
      computeAndStore: (day) => this.reports.computeAndStore(day, 'nightly'),
    });
    for (const entry of outcome.computed) {
      if (entry.complete) {
        this.logger.log(`Daily report ${entry.day} computed`);
      } else {
        this.logger.warn(
          `Daily report ${entry.day} computed with failed sections: ${JSON.stringify(entry.errors)}`,
        );
      }
    }
    if (outcome.skipped.length > 0) {
      this.logger.log(`Daily reports already present: ${outcome.skipped.join(', ')}`);
    }
    return outcome;
  }
}
