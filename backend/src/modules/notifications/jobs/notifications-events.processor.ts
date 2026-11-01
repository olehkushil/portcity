import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../../common/config';
import { IDENTITY_PORT, type IdentityPort } from '../../../common/contracts/identity';
import { PROMOS_PORT, type PromosPort } from '../../../common/contracts/promos';
import { QUEUES } from '../../../common/queue/queue.constants';
import { Clock } from '../../../common/time/clock';
import type { SupportMailMember } from '../domain/support-mail';
import { MailPort } from '../services/mail/mail.port';
import { MarketingAudience } from '../services/marketing-audience.service';
import { NOTIFICATIONS_CONFIG, type NotificationsConfig } from '../services/notifications.config';
import { NotificationsService } from '../services/notifications.service';
import { ReminderScheduler } from '../services/reminder-scheduler.service';
import {
  type NotificationsEventOutcome,
  handleNotificationsEventJob,
} from './notifications-events.handler';

/** BullMQ wiring only; the logic lives in handleNotificationsEventJob (unit tested). */
@Processor(QUEUES.notificationsEvents, { concurrency: 4 })
export class NotificationsEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsEventsProcessor.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly reminders: ReminderScheduler,
    private readonly audience: MarketingAudience,
    private readonly clock: Clock,
    @Inject(PROMOS_PORT) private readonly promos: PromosPort,
    @Inject(NOTIFICATIONS_CONFIG) private readonly config: NotificationsConfig,
    private readonly mail: MailPort,
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
  ) {
    super();
  }

  async process(job: Job): Promise<NotificationsEventOutcome> {
    return handleNotificationsEventJob(job.name, job.data, {
      now: () => this.clock.now(),
      notify: (input) => this.notifications.notify(input),
      scheduleReminder: (request) => this.reminders.schedule(request),
      cancelReminder: (id) => this.reminders.cancel(id),
      getEvent: (eventId) => this.promos.getEvent(eventId),
      listMarketingAudience: (cursor, limit) => this.audience.page(cursor, limit),
      eraseUser: (userId) => this.notifications.eraseUserData(userId),
      reminders: {
        ticketReminderHours: this.config.NOTIFICATIONS_TICKET_REMINDER_HOURS,
        voucherExpiringHours: this.config.NOTIFICATIONS_VOUCHER_EXPIRING_HOURS,
      },
      sendMail: async (message) => {
        await this.mail.send(message);
      },
      supportEmail: this.appConfig.SUPPORT_EMAIL ?? null,
      getMemberContact: (userId) => this.memberContact(userId),
      log: (message) => this.logger.log(message),
    });
  }

  private async memberContact(userId: string): Promise<SupportMailMember | null> {
    const user = await this.identity.getUser(userId);
    if (!user) {
      return null;
    }
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
    return {
      name: name === '' ? null : name,
      phone: user.phone,
      email: user.email,
      memberCode: user.memberCode,
    };
  }
}
