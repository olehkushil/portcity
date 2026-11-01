import { Module, type OnModuleInit } from '@nestjs/common';
import { envSectionProvider } from '../../common/config/env-section';
import { NOTIFICATIONS_PORT } from '../../common/contracts/notifications';
import { OutboxRouter } from '../../common/outbox/outbox-router';
import { QUEUES } from '../../common/queue/queue.constants';
import { QueueModule } from '../../common/queue/queue.module';
import { Clock } from '../../common/time/clock';
import { IdentityModule } from '../identity/identity.module';
import { PromosModule } from '../promos/promos.module';
import { AdminNotificationsController } from './controllers/admin-notifications.controller';
import { NotificationsController } from './controllers/notifications.controller';
import { NotificationsEventsProcessor } from './jobs/notifications-events.processor';
import { NotificationsPushProcessor } from './jobs/notifications-push.processor';
import { NOTIFICATION_OUTBOX_ROUTES } from './jobs/routes';
import { MarketingAudience } from './services/marketing-audience.service';
import { NotificationPreferencesService } from './services/notification-preferences.service';
import { NOTIFICATIONS_CONFIG, notificationsEnvSchema } from './services/notifications.config';
import { NotificationsService } from './services/notifications.service';
import { MAIL_CONFIG, mailEnvSchema } from './services/mail/mail.config';
import { createMailAdapter } from './services/mail/mail.factory';
import { MailPort } from './services/mail/mail.port';
import { PushDeliveryService } from './services/push-delivery.service';
import { createPushAdapter } from './services/push/push.factory';
import { PushPort } from './services/push/push.port';
import { ReminderScheduler } from './services/reminder-scheduler.service';

/**
 * Notifications: in-app inbox, per-kind preferences, push port (stub / FCM HTTP v1), mail port
 * (log adapter; SMTP is a documented TODO) for support desk e-mails,
 * outbox consumers (queue notifications-events) and push deliveries (queue notifications-push).
 * Provides NOTIFICATIONS_PORT (NotificationsService). Depends on identity (IDENTITY_PORT) and
 * promos (PROMOS_PORT, event titles for ticket reminders). Consumed by admin.
 */
@Module({
  imports: [
    IdentityModule,
    PromosModule,
    QueueModule.registerQueue(QUEUES.notificationsPush, QUEUES.notificationsEvents),
  ],
  controllers: [NotificationsController, AdminNotificationsController],
  providers: [
    envSectionProvider(NOTIFICATIONS_CONFIG, notificationsEnvSchema, 'notifications'),
    { provide: PushPort, inject: [NOTIFICATIONS_CONFIG, Clock], useFactory: createPushAdapter },
    envSectionProvider(MAIL_CONFIG, mailEnvSchema, 'mail'),
    { provide: MailPort, inject: [MAIL_CONFIG], useFactory: createMailAdapter },
    NotificationPreferencesService,
    NotificationsService,
    PushDeliveryService,
    ReminderScheduler,
    MarketingAudience,
    NotificationsEventsProcessor,
    NotificationsPushProcessor,
    { provide: NOTIFICATIONS_PORT, useExisting: NotificationsService },
  ],
  exports: [
    NOTIFICATIONS_PORT,
    NotificationsService,
    NotificationPreferencesService,
    PushPort,
    MailPort,
  ],
})
export class NotificationsModule implements OnModuleInit {
  constructor(private readonly router: OutboxRouter) {}

  onModuleInit(): void {
    this.router.addRoutes(NOTIFICATION_OUTBOX_ROUTES);
  }
}
