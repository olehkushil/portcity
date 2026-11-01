import { LogMailAdapter } from './log-mail.adapter';
import { mailEnvSchema } from './mail.config';
import { createMailAdapter } from './mail.factory';
import { MailProviderNotImplementedError, SmtpMailAdapter } from './smtp-mail.adapter';

describe('mail adapters', () => {
  it('validates the mail section with safe defaults', () => {
    expect(mailEnvSchema.parse({})).toEqual({
      MAIL_PROVIDER: 'log',
      MAIL_FROM: 'Порт City <no-reply@portcity.local>',
    });
    expect(mailEnvSchema.safeParse({ MAIL_PROVIDER: 'sendgrid' }).success).toBe(false);
  });

  it('records and logs messages with the log adapter (subject only, no body)', async () => {
    const logs: string[] = [];
    const adapter = new LogMailAdapter('noreply@portcity.ua', (line) => logs.push(line));
    const result = await adapter.send({
      to: ['support@portcity.ua'],
      subject: 'Звернення № 1: Чек',
      text: 'особисті дані',
    });
    expect(result).toEqual({ messageId: 'log-1' });
    expect(adapter.sent).toHaveLength(1);
    expect(logs[0]).toContain('Звернення № 1: Чек');
    expect(logs[0]).not.toContain('особисті дані');
    adapter.clear();
    expect(adapter.sent).toHaveLength(0);
  });

  it('builds the log adapter by default and refuses the unimplemented SMTP adapter', () => {
    expect(createMailAdapter(mailEnvSchema.parse({}))).toBeInstanceOf(LogMailAdapter);
    expect(() => createMailAdapter(mailEnvSchema.parse({ MAIL_PROVIDER: 'smtp' }))).toThrow(
      MailProviderNotImplementedError,
    );
    expect(() => new SmtpMailAdapter()).toThrow(/MAIL_PROVIDER=smtp is not implemented yet/);
  });
});
