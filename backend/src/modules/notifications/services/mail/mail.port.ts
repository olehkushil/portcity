import type { MailMessage } from '../../domain/support-mail';

export type { MailMessage } from '../../domain/support-mail';

export interface MailSendResult {
  /** Provider message id, when the provider returns one. */
  messageId: string | null;
}

/**
 * Port to the e-mail provider (support desk notifications). Implementations: LogMailAdapter
 * (development, tests: logs and records in memory) and SmtpMailAdapter (documented TODO, refuses
 * to start). The abstract class doubles as the Nest injection token, like PushPort.
 * `send` throws when the message could not be handed over; the BullMQ job then retries.
 */
export abstract class MailPort {
  /** For logs, e.g. `log`, `smtp`. */
  abstract readonly provider: string;

  abstract send(message: MailMessage): Promise<MailSendResult>;
}
