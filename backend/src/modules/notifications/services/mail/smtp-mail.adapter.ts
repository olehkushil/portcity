import { type MailMessage, MailPort, type MailSendResult } from './mail.port';

/** Thrown when MAIL_PROVIDER=smtp is selected before the adapter is implemented. */
export class MailProviderNotImplementedError extends Error {
  constructor(provider: string) {
    super(
      `MAIL_PROVIDER=${provider} is not implemented yet: use MAIL_PROVIDER=log or implement SmtpMailAdapter (src/modules/notifications/services/mail/smtp-mail.adapter.ts)`,
    );
    this.name = 'MailProviderNotImplementedError';
  }
}

/**
 * TODO(notifications): SMTP delivery for the support desk e-mails.
 *
 * Planned design (Node built-ins only, no new dependency): `node:tls` (port 465) or `node:net`
 * with STARTTLS (port 587), EHLO, AUTH LOGIN with SMTP_USER / SMTP_PASSWORD, MAIL FROM (MAIL_FROM),
 * RCPT TO per recipient, DATA with a UTF-8 text/plain body (quoted-printable) and an RFC 2047
 * encoded subject; reply codes checked per step, one connection per message, timeout per step.
 * An HTTP API of a transactional mail provider is the alternative (decision for the customer).
 *
 * Until then the adapter refuses to be constructed, so selecting it fails at boot instead of
 * silently dropping support requests.
 */
export class SmtpMailAdapter extends MailPort {
  readonly provider = 'smtp';

  constructor() {
    super();
    throw new MailProviderNotImplementedError('smtp');
  }

  send(_message: MailMessage): Promise<MailSendResult> {
    return Promise.reject(new MailProviderNotImplementedError('smtp'));
  }
}
