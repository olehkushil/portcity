export { NotificationsModule } from './notifications.module';
export { NotificationsService } from './services/notifications.service';
export type {
  ListNotificationsInput,
  NotifyResult,
  PushDeliverySummary,
} from './services/notifications.service';
export { NotificationPreferencesService } from './services/notification-preferences.service';
export type { PreferenceView } from './services/notification-preferences.service';
export { PushPort } from './services/push/push.port';
export type { PushFailureCode, PushMessage, PushSendResult } from './services/push/push.port';
export { StubPushAdapter } from './services/push/stub-push.adapter';
export { FcmPushAdapter } from './services/push/fcm-push.adapter';
export { MailPort } from './services/mail/mail.port';
export type { MailMessage, MailSendResult } from './services/mail/mail.port';
export { LogMailAdapter } from './services/mail/log-mail.adapter';
export {
  MailProviderNotImplementedError,
  SmtpMailAdapter,
} from './services/mail/smtp-mail.adapter';
export { MAIL_CONFIG, mailEnvSchema } from './services/mail/mail.config';
export type { MailConfig } from './services/mail/mail.config';
export { parseMailRecipients, renderSupportRequestMail } from './domain/support-mail';
export { NOTIFICATIONS_CONFIG, notificationsEnvSchema } from './services/notifications.config';
export type { NotificationsConfig } from './services/notifications.config';
export { NOTIFICATION_OUTBOX_ROUTES } from './jobs/routes';
export { handleNotificationsEventJob } from './jobs/notifications-events.handler';
export type {
  NotificationsEventDeps,
  NotificationsEventOutcome,
} from './jobs/notifications-events.handler';
export { PushRetryError, processPushJob } from './jobs/push-delivery.handler';
export type { PushJobDeps, PushJobOutcome } from './jobs/push-delivery.handler';
export { REMINDER_JOBS } from './domain/reminders';
export { HANDLED_EVENT_TYPES, mapOutboxEvent } from './domain/event-mapper';
export { NOTIFICATION_KIND_SPECS, canOptOut, defaultChannelFor } from './domain/kinds';
export { renderTemplate } from './domain/templates';
export { NotificationErrors } from './domain/errors';
