import type { NotificationSummary, NotifyInput } from '../../../common/contracts/notifications';
import type { EventSummary } from '../../../common/contracts/promos';
import type { OutboxJobData } from '../../../common/outbox/outbox.types';
import type { ReminderRequest } from '../domain/reminders';
import type { MailMessage } from '../domain/support-mail';
import {
  type NotificationsEventDeps,
  handleNotificationsEventJob,
  isOutboxJobData,
} from './notifications-events.handler';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const USER = '01900000-0000-7000-8000-000000000001';

function summary(input: NotifyInput): NotificationSummary {
  return {
    id: `n-${input.dedupeKey ?? 'x'}`,
    userId: input.userId,
    kind: input.kind,
    title: input.title,
    body: input.body,
    data: input.data ?? {},
    channel: input.channel ?? 'both',
    sentAt: null,
    readAt: null,
    createdAt: NOW,
  };
}

function event(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: 'event-1',
    title: 'Майстер-клас для дітей',
    category: 'kids',
    tenantId: null,
    startsAt: new Date('2026-11-02T13:00:00.000Z'),
    endsAt: new Date('2026-11-02T14:30:00.000Z'),
    venue: 'Атріум',
    capacity: 30,
    registeredCount: 4,
    registrationOpen: true,
    admission: 'registration',
    ageLimit: null,
    ageMin: null,
    ageMax: null,
    status: 'published',
    ...overrides,
  };
}

function deps(overrides: Partial<NotificationsEventDeps> = {}) {
  const notified: NotifyInput[] = [];
  const scheduled: ReminderRequest[] = [];
  const cancelled: string[] = [];
  const logs: string[] = [];
  const base: NotificationsEventDeps = {
    now: () => NOW,
    notify: async (input) => {
      notified.push(input);
      return summary(input);
    },
    scheduleReminder: async (request) => {
      scheduled.push(request);
      return true;
    },
    cancelReminder: async (id) => {
      cancelled.push(id);
      return true;
    },
    getEvent: async () => event(),
    listMarketingAudience: async () => ({ userIds: [], nextCursor: null }),
    eraseUser: async () => ({ notifications: 0, preferences: 0 }),
    reminders: { ticketReminderHours: 24, voucherExpiringHours: 24 },
    log: (message) => logs.push(message),
    ...overrides,
  };
  return { deps: base, notified, scheduled, cancelled, logs };
}

function outbox(type: string, payload: Record<string, unknown>): OutboxJobData {
  return {
    eventId: 'evt-1',
    type,
    aggregateType: 'x',
    aggregateId: 'agg',
    payload,
    occurredAt: NOW.toISOString(),
  };
}

describe('handleNotificationsEventJob', () => {
  it('stores the notification for a consumed outbox event with the event dedupe key', async () => {
    const d = deps();
    const outcome = await handleNotificationsEventJob(
      'points.expiring',
      outbox('points.expiring', {
        userId: USER,
        accountId: 'acc-1',
        points: 40,
        expiresOn: '2026-12-01',
        daysLeft: 30,
      }),
      d.deps,
    );
    expect(outcome).toEqual({
      job: 'points.expiring',
      notified: 1,
      skipped: 0,
      scheduled: 0,
      cancelled: 0,
      ignored: [],
    });
    expect(d.notified[0]).toMatchObject({
      userId: USER,
      kind: 'points_expiring',
      dedupeKey: 'outbox:evt-1',
    });
    expect(d.logs[0]).toContain('points.expiring (evt-1): notified 1');
  });

  it('counts notifications refused by preferences or consent as skipped', async () => {
    const d = deps({ notify: async () => null });
    const outcome = await handleNotificationsEventJob(
      'points.released',
      outbox('points.released', {
        userId: USER,
        accountId: 'a',
        txId: 't',
        amount: 5,
        availableBalance: 5,
      }),
      d.deps,
    );
    expect(outcome).toMatchObject({ notified: 0, skipped: 1 });
  });

  it('schedules and cancels reminders', async () => {
    const d = deps();
    const issued = await handleNotificationsEventJob(
      'voucher.issued',
      outbox('voucher.issued', {
        voucherId: 'v1',
        userId: USER,
        kind: 'coupon',
        title: '-20 %',
        tenantId: null,
        sourceType: 'promo',
        sourceId: 'claim-1',
        expiresAt: '2026-11-10T10:00:00.000Z',
      }),
      d.deps,
    );
    expect(issued).toMatchObject({ notified: 1, scheduled: 1 });
    expect(d.scheduled[0]?.id).toBe('voucher-expiring-v1');

    const expired = await handleNotificationsEventJob(
      'voucher.expired',
      outbox('voucher.expired', {
        voucherId: 'v1',
        userId: USER,
        kind: 'coupon',
        title: '-20 %',
        tenantId: null,
        sourceType: 'promo',
        sourceId: 'claim-1',
        expiresAt: null,
      }),
      d.deps,
    );
    expect(expired).toMatchObject({
      cancelled: 1,
      ignored: ['voucher.expired has no notification kind'],
    });
    expect(d.cancelled).toEqual(['voucher-expiring-v1']);
  });

  it('reports a reminder whose time already passed', async () => {
    const d = deps({ scheduleReminder: async () => false });
    const outcome = await handleNotificationsEventJob(
      'event.registered',
      outbox('event.registered', {
        eventId: 'event-1',
        registrationId: 'reg-1',
        userId: USER,
        adults: 1,
        children: 0,
        voucherId: 'ticket-1',
        startsAt: '2026-11-07T13:00:00.000Z',
      }),
      d.deps,
    );
    expect(outcome.ignored).toEqual(['reminder ticket-reminder-reg-1 is already due']);
  });

  it('fans a marketing broadcast out page by page with the event dedupe key', async () => {
    const pages: Record<string, { userIds: string[]; nextCursor: string | null }> = {
      start: { userIds: ['u1', 'u2'], nextCursor: 'u2' },
      u2: { userIds: ['u3'], nextCursor: null },
    };
    const calls: Array<[string | null, number]> = [];
    const d = deps({
      audiencePageSize: 2,
      listMarketingAudience: async (cursor, limit) => {
        calls.push([cursor, limit]);
        return pages[cursor ?? 'start'] ?? { userIds: [], nextCursor: null };
      },
    });
    const outcome = await handleNotificationsEventJob(
      'promo.published',
      outbox('promo.published', {
        promoId: 'p1',
        tenantId: null,
        title: '1+1 Aroma Kava',
        kind: 'info',
        validTo: '2026-11-30T21:59:59.000Z',
      }),
      d.deps,
    );
    expect(calls).toEqual([
      [null, 2],
      ['u2', 2],
    ]);
    expect(outcome.notified).toBe(3);
    expect(d.notified.map((input) => [input.userId, input.kind, input.dedupeKey])).toEqual([
      ['u1', 'promo_published', 'outbox:evt-1'],
      ['u2', 'promo_published', 'outbox:evt-1'],
      ['u3', 'promo_published', 'outbox:evt-1'],
    ]);
  });

  it('stops paging when the cursor does not move', async () => {
    let calls = 0;
    const d = deps({
      listMarketingAudience: async () => {
        calls += 1;
        return { userIds: ['u1'], nextCursor: 'u1' };
      },
    });
    const outcome = await handleNotificationsEventJob(
      'promo.published',
      outbox('promo.published', {
        promoId: 'p1',
        tenantId: null,
        title: 't',
        kind: 'info',
        validTo: NOW.toISOString(),
      }),
      d.deps,
    );
    expect(calls).toBe(2);
    expect(outcome.notified).toBe(2);
  });

  it('records that a broadcast had no audience', async () => {
    const d = deps();
    const outcome = await handleNotificationsEventJob(
      'promo.published',
      outbox('promo.published', {
        promoId: 'p1',
        tenantId: null,
        title: 't',
        kind: 'info',
        validTo: NOW.toISOString(),
      }),
      d.deps,
    );
    expect(outcome).toMatchObject({
      notified: 0,
      ignored: ['marketing broadcast has no audience (no marketing consents)'],
    });
  });

  it('erases the inbox of a deleted member', async () => {
    const erased: string[] = [];
    const d = deps({
      eraseUser: async (userId) => {
        erased.push(userId);
        return { notifications: 4, preferences: 1 };
      },
    });
    const outcome = await handleNotificationsEventJob(
      'user.deleted',
      outbox('user.deleted', { userId: USER, requestId: 'req-1', deletedAt: NOW.toISOString() }),
      d.deps,
    );
    expect(erased).toEqual([USER]);
    expect(outcome).toMatchObject({ notified: 0, erased: { notifications: 4, preferences: 1 } });
    expect(d.notified).toEqual([]);
  });

  it('sends the ticket reminder with the current event title', async () => {
    const d = deps();
    const outcome = await handleNotificationsEventJob(
      'reminder.ticket',
      {
        userId: USER,
        eventId: 'event-1',
        registrationId: 'reg-1',
        voucherId: 'ticket-1',
        startsAt: '2026-11-02T13:00:00.000Z',
      },
      d.deps,
    );
    expect(outcome.notified).toBe(1);
    expect(d.notified[0]).toMatchObject({
      kind: 'ticket_reminder',
      dedupeKey: 'reminder:ticket:reg-1',
      data: { eventId: 'event-1', registrationId: 'reg-1', voucherId: 'ticket-1' },
    });
    expect(d.notified[0]?.title + (d.notified[0]?.body ?? '')).toContain('Майстер-клас');
  });

  it.each([
    [null, 'event event-1 no longer exists'],
    [event({ status: 'cancelled' }), 'event event-1 is cancelled'],
    [event({ startsAt: new Date('2026-11-01T09:00:00.000Z') }), 'event event-1 already started'],
  ])('skips the ticket reminder when the event is %j', async (found, reason) => {
    const d = deps({ getEvent: async () => found });
    const outcome = await handleNotificationsEventJob(
      'reminder.ticket',
      { userId: USER, eventId: 'event-1', registrationId: 'reg-1', voucherId: null, startsAt: 'x' },
      d.deps,
    );
    expect(outcome).toMatchObject({ notified: 0, ignored: [reason] });
  });

  it('sends or skips the voucher expiry reminder', async () => {
    const d = deps();
    const live = await handleNotificationsEventJob(
      'reminder.voucher_expiring',
      {
        userId: USER,
        voucherId: 'v1',
        voucherKind: 'coupon',
        title: '-20 %',
        expiresAt: '2026-11-02T10:00:00.000Z',
      },
      d.deps,
    );
    expect(live.notified).toBe(1);
    expect(d.notified[0]).toMatchObject({
      kind: 'voucher_expiring',
      dedupeKey: 'reminder:voucher:v1',
    });

    const gone = await handleNotificationsEventJob(
      'reminder.voucher_expiring',
      {
        userId: USER,
        voucherId: 'v1',
        voucherKind: 'coupon',
        title: '-20 %',
        expiresAt: '2026-10-01T10:00:00.000Z',
      },
      d.deps,
    );
    expect(gone.ignored).toEqual(['voucher v1 already expired']);
  });

  describe('support.request_created', () => {
    const request = {
      requestId: 'request-1',
      number: 1042,
      userId: USER,
      topic: 'receipt',
      relatedType: 'receipt',
      relatedId: 'receipt-1',
      message: 'Бали за чек не нараховано',
      photoKey: `support/${USER}/2026/11/photo.jpg`,
      createdAt: NOW.toISOString(),
    };

    it('confirms in-app first and then e-mails SUPPORT_EMAIL with the member contact', async () => {
      const mails: MailMessage[] = [];
      const order: string[] = [];
      const confirmations: NotifyInput[] = [];
      const d = deps({
        notify: async (input) => {
          order.push('notify');
          confirmations.push(input);
          return summary(input);
        },
        sendMail: async (message) => {
          order.push('mail');
          mails.push(message);
        },
        supportEmail: 'support@portcity.ua, duty@portcity.ua',
        getMemberContact: async () => ({
          name: 'Олег',
          phone: '+380501234567',
          email: 'oleg@example.com',
          memberCode: '734211800',
        }),
      });
      const outcome = await handleNotificationsEventJob(
        'support.request_created',
        outbox('support.request_created', request),
        d.deps,
      );
      expect(order).toEqual(['notify', 'mail']);
      expect(outcome).toMatchObject({ notified: 1, mailed: 1, ignored: [] });
      expect(confirmations[0]).toMatchObject({
        kind: 'support_request_received',
        title: 'Звернення № 1042 прийнято',
      });
      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({
        to: ['support@portcity.ua', 'duty@portcity.ua'],
        subject: 'Звернення № 1042: Чек',
        replyTo: 'oleg@example.com',
      });
      expect(mails[0]?.text).toContain('+380501234567');
      expect(mails[0]?.text).toContain('Бали за чек не нараховано');
      expect(d.logs[0]).toContain('mailed 1');
    });

    it('skips the e-mail without SUPPORT_EMAIL but still confirms to the member', async () => {
      const sendMail = jest.fn(async () => undefined);
      const d = deps({ sendMail, supportEmail: null });
      const outcome = await handleNotificationsEventJob(
        'support.request_created',
        outbox('support.request_created', request),
        d.deps,
      );
      expect(sendMail).not.toHaveBeenCalled();
      expect(outcome.notified).toBe(1);
      expect(outcome.ignored).toEqual(['SUPPORT_EMAIL is not set; support request e-mail skipped']);
    });

    it('fails the job when the mail provider fails, so BullMQ retries it', async () => {
      const d = deps({
        sendMail: async () => {
          throw new Error('provider down');
        },
        supportEmail: 'support@portcity.ua',
      });
      await expect(
        handleNotificationsEventJob(
          'support.request_created',
          outbox('support.request_created', request),
          d.deps,
        ),
      ).rejects.toThrow('provider down');
      // The confirmation was stored before; the retry dedupes it by `outbox:<eventId>`.
      expect(d.notified[0]?.dedupeKey).toBe('outbox:evt-1');
    });
  });

  it('confirms an event registration to the member', async () => {
    const d = deps();
    const outcome = await handleNotificationsEventJob(
      'event.registered',
      outbox('event.registered', {
        eventId: 'event-1',
        registrationId: 'reg-1',
        userId: USER,
        adults: 2,
        children: 1,
        voucherId: 'ticket-1',
        startsAt: '2026-11-07T13:00:00.000Z',
        title: 'Майстер-клас для дітей',
        venue: 'Атріум',
      }),
      d.deps,
    );
    expect(outcome).toMatchObject({ notified: 1, scheduled: 1 });
    expect(d.notified[0]).toMatchObject({ kind: 'event_registered', userId: USER });
  });

  it('throws on malformed job data so the queue keeps it for inspection', async () => {
    await expect(handleNotificationsEventJob('reminder.ticket', {}, deps().deps)).rejects.toThrow(
      'reminder.ticket job carries malformed data',
    );
    await expect(
      handleNotificationsEventJob('points.expiring', { foo: 1 }, deps().deps),
    ).rejects.toThrow('does not carry outbox event data');
    expect(isOutboxJobData(outbox('x.y', {}))).toBe(true);
  });
});
