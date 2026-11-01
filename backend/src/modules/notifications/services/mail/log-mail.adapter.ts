import { type MailMessage, MailPort, type MailSendResult } from './mail.port';

/**
 * Development and test adapter: records every message in memory and logs the recipients and the
 * subject (never the body, which carries personal data).
 */
export class LogMailAdapter extends MailPort {
  readonly provider = 'log';
  readonly sent: MailMessage[] = [];

  constructor(
    private readonly from: string,
    private readonly log?: (message: string) => void,
  ) {
    super();
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    this.sent.push(message);
    this.log?.(
      `mail (log adapter) from ${this.from} to ${message.to.join(', ')}: ${message.subject}`,
    );
    return { messageId: `log-${this.sent.length}` };
  }

  clear(): void {
    this.sent.length = 0;
  }
}
