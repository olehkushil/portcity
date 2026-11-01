import type { SupportRequestCreatedPayload } from '../../../common/contracts/events';
import { formatKyiv } from '../../../common/time/kyiv';

/** One e-mail handed to MailPort. Plain text only (no HTML templates yet). */
export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  replyTo?: string | null;
}

/** Member contact printed in the support e-mail (IDENTITY_PORT.getUser). */
export interface SupportMailMember {
  name: string | null;
  phone: string | null;
  email: string | null;
  memberCode: string | null;
}

export const SUPPORT_TOPIC_LABELS: Readonly<Record<SupportRequestCreatedPayload['topic'], string>> =
  Object.freeze({
    receipt: 'Чек',
    parking: 'Паркінг',
    voucher: 'Ваучер',
    other: 'Інше',
  });

/** Loose e-mail check: something@domain.tld, no spaces. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `SUPPORT_EMAIL` may list several addresses separated by commas or semicolons. */
export function parseMailRecipients(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  return [
    ...new Set(
      value
        .split(/[,;]/)
        .map((entry) => entry.trim())
        .filter((entry) => EMAIL_PATTERN.test(entry)),
    ),
  ];
}

/** Single-line subject: no line breaks can reach the mail headers. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * E-mail to the support desk about a new member request (`support.request_created`). Pure:
 * the subject carries the human number and topic, the body the member contact and the text.
 */
export function renderSupportRequestMail(input: {
  request: SupportRequestCreatedPayload;
  member: SupportMailMember | null;
  to: string[];
}): MailMessage {
  const { request, member } = input;
  const topic = SUPPORT_TOPIC_LABELS[request.topic];
  const createdAt = new Date(request.createdAt);
  const lines = [
    `Нове звернення № ${request.number} у застосунку Порт City.`,
    '',
    `Тема: ${topic}`,
    `Створено: ${Number.isNaN(createdAt.getTime()) ? request.createdAt : formatKyiv(createdAt, 'dd.MM.yyyy HH:mm')} (Київ)`,
    `ID звернення: ${request.requestId}`,
    `Учасник: ${member?.name ?? 'без імені'} (ID ${request.userId})`,
  ];
  if (member?.memberCode) {
    lines.push(`Код учасника: ${member.memberCode}`);
  }
  if (member?.phone) {
    lines.push(`Телефон: ${member.phone}`);
  }
  if (member?.email) {
    lines.push(`E-mail: ${member.email}`);
  }
  if (request.relatedType || request.relatedId) {
    lines.push(`Стосується: ${request.relatedType ?? 'об’єкт'} ${request.relatedId ?? ''}`.trim());
  }
  lines.push(`Фото: ${request.photoKey ? 'додано (дивіться в бек-офісі)' : 'немає'}`);
  lines.push('', 'Текст звернення:', request.message, '');
  lines.push(
    `Відповідь і статус: бек-офіс, GET /api/v1/admin/support-requests/${request.requestId}.`,
  );
  return {
    to: input.to,
    subject: oneLine(`Звернення № ${request.number}: ${topic}`, 150),
    text: lines.join('\n'),
    replyTo: member?.email ?? null,
  };
}
