import { Logger } from '@nestjs/common';
import { LogMailAdapter } from './log-mail.adapter';
import type { MailConfig } from './mail.config';
import type { MailPort } from './mail.port';
import { SmtpMailAdapter } from './smtp-mail.adapter';

/** Chooses the MailPort implementation from the validated environment slice. */
export function createMailAdapter(config: MailConfig): MailPort {
  const logger = new Logger('NotificationsMail');
  if (config.MAIL_PROVIDER === 'smtp') {
    // Throws MailProviderNotImplementedError: fail at boot rather than lose support e-mails.
    return new SmtpMailAdapter();
  }
  return new LogMailAdapter(config.MAIL_FROM, (message) => logger.log(message));
}
