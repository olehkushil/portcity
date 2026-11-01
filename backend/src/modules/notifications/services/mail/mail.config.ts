import { z } from 'zod';

/** Injection token of the validated mail environment slice. */
export const MAIL_CONFIG = Symbol('MAIL_CONFIG');

export const MAIL_PROVIDERS = ['log', 'smtp'] as const;
export type MailProviderName = (typeof MAIL_PROVIDERS)[number];

/**
 * Mail environment (its own section, validated like notificationsEnvSchema; documented in the
 * module README). The recipient of support e-mails is the shared `SUPPORT_EMAIL`.
 */
export const mailEnvSchema = z.object({
  /** `log` records and logs messages; `smtp` is a documented TODO and refuses to start. */
  MAIL_PROVIDER: z.enum(MAIL_PROVIDERS).default('log'),
  /** Sender address of outgoing e-mails. */
  MAIL_FROM: z.string().min(3).max(200).default('Порт City <no-reply@portcity.local>'),
});

export type MailConfig = z.output<typeof mailEnvSchema>;
