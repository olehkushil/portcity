import { Processor, WorkerHost } from '@nestjs/bullmq';
import { QUEUES } from '../queue/queue.constants';
import { OutboxDispatcher } from './outbox-dispatcher';
import type { OutboxDispatchResult } from './outbox.types';

/** BullMQ wiring only; the logic lives in OutboxDispatcher (unit tested). */
@Processor(QUEUES.outboxDispatch, { concurrency: 1 })
export class OutboxDispatchProcessor extends WorkerHost {
  constructor(private readonly dispatcher: OutboxDispatcher) {
    super();
  }

  async process(): Promise<OutboxDispatchResult> {
    return this.dispatcher.tick();
  }
}
