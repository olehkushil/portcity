import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../../../common/queue/queue.constants';
import {
  type ParkingPaymentsSweepSummary,
  ParkingPaymentsService,
} from '../services/parking-payments.service';
import { SessionSyncService } from '../services/session-sync.service';
import { PARKING_JOBS } from './job-names';
import { type ParkingSyncSummary, runParkingSync } from './parking-sync.job';

/** BullMQ wiring only; the logic lives in parking-sync.job.ts and ParkingPaymentsService.sweep. */
@Processor(QUEUES.parkingSync, { concurrency: 1 })
export class ParkingSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(ParkingSyncProcessor.name);

  constructor(
    private readonly sync: SessionSyncService,
    private readonly payments: ParkingPaymentsService,
  ) {
    super();
  }

  async process(job: Job): Promise<ParkingSyncSummary | ParkingPaymentsSweepSummary> {
    switch (job.name) {
      case PARKING_JOBS.sync:
        return runParkingSync({
          listActiveSnapshots: () => this.sync.listActiveSnapshots(),
          filterTracked: (snapshots) => this.sync.filterTracked(snapshots),
          applySnapshot: (snapshot) => this.sync.applySnapshot(snapshot),
          reconcileMissing: (seenRefs) => this.sync.reconcileMissing(seenRefs),
          tickInfoTimers: () => this.sync.tickInfoTimers(),
          log: (text) => this.logger.warn(text),
        });
      case PARKING_JOBS.paymentsSweep: {
        const summary = await this.payments.sweep();
        if (summary.failed > 0 || summary.refunds > 0 || summary.alerts > 0) {
          this.logger.warn(`parking payments sweep: ${JSON.stringify(summary)}`);
        }
        return summary;
      }
      default:
        throw new Error(`Unknown parking-sync job "${job.name}"`);
    }
  }
}
