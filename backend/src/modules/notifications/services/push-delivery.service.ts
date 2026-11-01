import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { IDENTITY_PORT, type IdentityPort } from '../../../common/contracts/identity';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import {
  type PushDeliveryRecord,
  type PushJobOutcome,
  processPushJob,
} from '../jobs/push-delivery.handler';
import { NOTIFICATIONS_CONFIG, type NotificationsConfig } from './notifications.config';
import { NotificationsService } from './notifications.service';
import { PushPort } from './push/push.port';

/** Database side of the push job: the handler logic lives in jobs/push-delivery.handler.ts. */
@Injectable()
export class PushDeliveryService {
  private readonly logger = new Logger(PushDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly notifications: NotificationsService,
    private readonly push: PushPort,
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(NOTIFICATIONS_CONFIG) private readonly config: NotificationsConfig,
  ) {}

  deliver(notificationId: string): Promise<PushJobOutcome> {
    return processPushJob(
      { notificationId },
      {
        now: () => this.clock.now(),
        loadNotification: (id) => this.notifications.getById(id),
        listPushDevices: (userId) => this.identity.listPushDevices(userId),
        listDeliveries: async (id): Promise<PushDeliveryRecord[]> => {
          const rows = await this.prisma.pushDelivery.findMany({ where: { notificationId: id } });
          return rows.map((row) => ({
            id: row.id,
            deviceId: row.deviceId,
            status: row.status,
            attempts: row.attempts,
          }));
        },
        createDelivery: async (input): Promise<PushDeliveryRecord> => {
          const now = this.clock.now();
          const row = await this.prisma.pushDelivery.create({
            data: {
              id: uuidv7(),
              notificationId: input.notificationId,
              deviceId: input.deviceId,
              provider: input.provider,
              status: 'queued',
              attempts: 0,
              createdAt: now,
              updatedAt: now,
            },
          });
          return { id: row.id, deviceId: row.deviceId, status: row.status, attempts: row.attempts };
        },
        recordAttempt: async (deliveryId, attempt) => {
          await this.prisma.pushDelivery.update({
            where: { id: deliveryId },
            data: {
              status: attempt.status,
              error: attempt.error,
              attempts: { increment: 1 },
              sentAt: attempt.sentAt,
              updatedAt: this.clock.now(),
            },
          });
        },
        markSent: async (id, at) => {
          await this.prisma.notification.updateMany({
            where: { id, sentAt: null },
            data: { sentAt: at },
          });
        },
        send: (message) => this.push.send(message),
        provider: this.push.provider,
        maxAttempts: this.config.PUSH_MAX_ATTEMPTS,
        log: (message) => this.logger.log(message),
      },
    );
  }
}
