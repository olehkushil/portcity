import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { OutboxJobData } from '../../../common/outbox/outbox.types';
import { QUEUES } from '../../../common/queue/queue.constants';
import { PushDeliveryService } from '../services/push-delivery.service';
import type { PushJobOutcome } from './push-delivery.handler';

/** Resolves the notification id from a `notification.created` job (or a manual `{ notificationId }`). */
export function notificationIdOf(data: unknown): string {
  if (typeof data === 'object' && data !== null) {
    const direct = (data as { notificationId?: unknown }).notificationId;
    if (typeof direct === 'string' && direct.length > 0) {
      return direct;
    }
    const payload = (data as Partial<OutboxJobData>).payload;
    const fromPayload = payload?.notificationId;
    if (typeof fromPayload === 'string' && fromPayload.length > 0) {
      return fromPayload;
    }
  }
  throw new Error('notifications-push job carries no notificationId');
}

/** BullMQ wiring only; the logic lives in processPushJob (unit tested). */
@Processor(QUEUES.notificationsPush, { concurrency: 4 })
export class NotificationsPushProcessor extends WorkerHost {
  constructor(private readonly deliveries: PushDeliveryService) {
    super();
  }

  async process(job: Job): Promise<PushJobOutcome> {
    return this.deliveries.deliver(notificationIdOf(job.data));
  }
}
