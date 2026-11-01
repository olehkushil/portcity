import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../../../common/queue/queue.constants';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity.config';
import { AccountDeletionService } from '../services/account-deletion.service';
import {
  ACCOUNT_DELETION_JOBS,
  isExecuteOneJobData,
  runAccountDeletion,
} from './account-deletion.job';

/** BullMQ wiring only; the logic lives in account-deletion.job.ts and AccountDeletionService. */
@Processor(QUEUES.accountDeletion, { concurrency: 1 })
export class AccountDeletionProcessor extends WorkerHost {
  private readonly logger = new Logger(AccountDeletionProcessor.name);

  constructor(
    private readonly deletions: AccountDeletionService,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case ACCOUNT_DELETION_JOBS.run:
        return runAccountDeletion({
          batchSize: this.config.ACCOUNT_DELETION_BATCH_SIZE,
          otpRetentionDays: this.config.OTP_RETENTION_DAYS,
          refreshRetentionDays: this.config.REFRESH_RETENTION_DAYS,
          executeDue: (limit) => this.deletions.executeDue(limit),
          purge: (retention) => this.deletions.purge(retention),
          log: (message) => this.logger.log(message),
        });
      case ACCOUNT_DELETION_JOBS.executeOne:
        if (!isExecuteOneJobData(job.data)) {
          throw new Error('execute-one job requires { requestId }');
        }
        return this.deletions.execute(job.data.requestId);
      default:
        throw new Error(`Unknown account-deletion job "${job.name}"`);
    }
  }
}
