import { buildCouponDraft, buildTicketDraft, formatEventWhen, formatPersons } from './ticket';

describe('formatPersons', () => {
  const table: Array<[number, number, string]> = [
    [1, 0, '1 дорослий'],
    [2, 0, '2 дорослих'],
    [1, 1, '1 дорослий, 1 дитина'],
    [2, 1, '2 дорослих, 1 дитина'],
    [1, 2, '1 дорослий, 2 дитини'],
    [1, 3, '1 дорослий, 3 дитини'],
    [4, 0, '4 дорослих'],
    [21, 5, '21 дорослий, 5 дітей'],
  ];

  it.each(table)('adults %d children %d -> %s', (adults, children, expected) => {
    expect(formatPersons(adults, children)).toBe(expected);
  });
});

describe('formatEventWhen', () => {
  it('formats in Kyiv time with a Ukrainian weekday and month', () => {
    // 2026-11-01 is a Sunday; 10:00Z = 12:00 Kyiv (UTC+2)
    expect(formatEventWhen(new Date('2026-11-01T10:00:00.000Z'))).toBe('Нд 1 листопада 12:00');
    // 2026-07-04 is a Saturday; 12:00Z = 15:00 Kyiv (UTC+3)
    expect(formatEventWhen(new Date('2026-07-04T12:00:00.000Z'))).toBe('Сб 4 липня 15:00');
  });
});

describe('buildTicketDraft', () => {
  const event = {
    id: 'event-1',
    title: 'Майстер-клас для дітей',
    startsAt: new Date('2026-11-01T10:00:00.000Z'),
    endsAt: new Date('2026-11-01T11:30:00.000Z'),
    venue: 'Figli Migli, 3 поверх',
    ageLimit: 4,
  };

  it('builds the wallet card text, expiry and meta', () => {
    const draft = buildTicketDraft(event, { id: 'reg-1', adults: 2, children: 1 });
    expect(draft).toEqual({
      title: 'Майстер-клас для дітей',
      subtitle: 'Нд 1 листопада 12:00 · Figli Migli, 3 поверх · 2 дорослих, 1 дитина',
      expiresAt: event.endsAt,
      meta: {
        eventId: 'event-1',
        registrationId: 'reg-1',
        adults: 2,
        children: 1,
        persons: 3,
        startsAt: '2026-11-01T10:00:00.000Z',
        endsAt: '2026-11-01T11:30:00.000Z',
        venue: 'Figli Migli, 3 поверх',
        ageLimit: 4,
      },
    });
  });

  it('omits the venue when unknown', () => {
    const draft = buildTicketDraft(
      { ...event, venue: null },
      { id: 'reg-1', adults: 1, children: 0 },
    );
    expect(draft.subtitle).toBe('Нд 1 листопада 12:00 · 1 дорослий');
  });
});

describe('buildCouponDraft', () => {
  it('uses the discount text as subtitle and carries the claim facts in meta', () => {
    const expiresAt = new Date('2026-11-04T12:00:00.000Z');
    const draft = buildCouponDraft(
      { id: 'promo-1', title: '-20 % INTERTOP до 15.11', tenantId: 'tenant-1' },
      {
        id: 'template-1',
        discountText: '-20 % на весь асортимент',
        requiresActivation: true,
        validityHoursAfterClaim: 72,
        terms: 'Один купон на покупку.',
      },
      { claimId: 'claim-1', expiresAt },
    );
    expect(draft).toEqual({
      title: '-20 % INTERTOP до 15.11',
      subtitle: '-20 % на весь асортимент',
      expiresAt,
      meta: {
        promoId: 'promo-1',
        couponTemplateId: 'template-1',
        claimId: 'claim-1',
        discountText: '-20 % на весь асортимент',
        terms: 'Один купон на покупку.',
        requiresActivation: true,
        validityHoursAfterClaim: 72,
        tenantId: 'tenant-1',
      },
    });
  });
});
