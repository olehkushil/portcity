import type { SupportRequestCreatedPayload } from '../../../common/contracts/events';
import { parseMailRecipients, renderSupportRequestMail } from './support-mail';

const request: SupportRequestCreatedPayload = {
  requestId: '01900000-0000-7000-8000-0000000005a1',
  number: 1042,
  userId: '01900000-0000-7000-8000-000000000001',
  topic: 'voucher',
  relatedType: 'voucher',
  relatedId: '01900000-0000-7000-8000-0000000000v1',
  message: 'Код не спрацював на касі.\nКасир сказав звернутися в підтримку.',
  photoKey: null,
  // 14:05 Kyiv (UTC+2).
  createdAt: '2026-11-01T12:05:00.000Z',
};

describe('support request e-mail', () => {
  it.each<[string | null | undefined, string[]]>([
    [undefined, []],
    ['', []],
    ['support@portcity.ua', ['support@portcity.ua']],
    [' a@portcity.ua ; b@portcity.ua,a@portcity.ua ', ['a@portcity.ua', 'b@portcity.ua']],
    ['not an address, c@portcity.ua', ['c@portcity.ua']],
  ])('parses SUPPORT_EMAIL %j', (value, expected) => {
    expect(parseMailRecipients(value)).toEqual(expected);
  });

  it('puts the number and topic in the subject and the facts in the body', () => {
    const mail = renderSupportRequestMail({
      request,
      member: { name: 'Олег', phone: '+380501234567', email: null, memberCode: '734211800' },
      to: ['support@portcity.ua'],
    });
    expect(mail.subject).toBe('Звернення № 1042: Ваучер');
    expect(mail.to).toEqual(['support@portcity.ua']);
    expect(mail.replyTo).toBeNull();
    expect(mail.text).toContain('Створено: 01.11.2026 14:05 (Київ)');
    expect(mail.text).toContain('Учасник: Олег');
    expect(mail.text).toContain('Код учасника: 734211800');
    expect(mail.text).toContain('Телефон: +380501234567');
    expect(mail.text).toContain('Стосується: voucher');
    expect(mail.text).toContain('Фото: немає');
    expect(mail.text).toContain('Касир сказав звернутися в підтримку.');
    expect(mail.text).toContain(`/admin/support-requests/${request.requestId}`);
  });

  it('works without the member contact', () => {
    const mail = renderSupportRequestMail({
      request: {
        ...request,
        topic: 'other',
        relatedType: null,
        relatedId: null,
        photoKey: 'x.jpg',
      },
      member: null,
      to: ['support@portcity.ua'],
    });
    expect(mail.subject).toBe('Звернення № 1042: Інше');
    expect(mail.text).toContain('без імені');
    expect(mail.text).not.toContain('Стосується');
    expect(mail.text).toContain('Фото: додано');
  });
});
