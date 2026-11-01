import type { NotifyInput } from '../../../common/contracts/notifications';
import type { OutboxJobData } from '../../../common/outbox/outbox.types';
import { NOTIFICATION_OUTBOX_ROUTES } from '../jobs/routes';
import {
  type EventAction,
  HANDLED_EVENT_TYPES,
  eventDedupeKey,
  isHandledEventType,
  mapOutboxEvent,
} from './event-mapper';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const USER = '01900000-0000-7000-8000-000000000001';
const CONTEXT = { now: NOW, reminders: { ticketReminderHours: 24, voucherExpiringHours: 24 } };

function job(type: string, payload: Record<string, unknown>, eventId = 'evt-1'): OutboxJobData {
  return {
    eventId,
    type,
    aggregateType: 'x',
    aggregateId: 'agg-1',
    payload,
    occurredAt: NOW.toISOString(),
  };
}

function notifications(actions: EventAction[]): NotifyInput[] {
  return actions.flatMap((action) => (action.type === 'notify' ? [action.input] : []));
}

const parkingBase = {
  sessionId: 'session-1',
  userId: USER,
  vehicleId: 'vehicle-1',
  plate: 'AC1234BC',
  zone: 'underground',
  status: 'payable',
  enteredAt: '2026-11-01T12:12:00.000Z',
};

const paymentBase = {
  paymentId: 'payment-1',
  userId: USER,
  amountKopecks: 6000,
  provider: 'mock',
  providerRef: 'mock_payment-1',
  status: 'succeeded',
  meta: { sessionId: 'session-1' },
};

const voucherBase = {
  voucherId: 'voucher-1',
  userId: USER,
  kind: 'reward',
  title: 'Кава з собою',
  tenantId: 'tenant-1',
  sourceType: 'redemption',
  sourceId: 'redemption-1',
  expiresAt: '2026-11-30T21:59:59.000Z',
};

/** [event type, payload, expected kind, expected data subset] for one-notification events. */
const SINGLE_NOTIFY: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
  [
    'receipt.needs_moderation',
    {
      receiptId: 'r1',
      userId: USER,
      tenantId: null,
      totalKopecks: 450_000,
      riskFlags: [],
      riskScore: 3,
    },
    'receipt_needs_moderation',
    { receiptId: 'r1' },
  ],
  [
    'receipt.rejected',
    {
      receiptId: 'r1',
      userId: USER,
      moderatorId: null,
      reason: 'Чек нечитабельний',
      code: 'blurry',
    },
    'receipt_rejected',
    { receiptId: 'r1', code: 'blurry' },
  ],
  [
    'receipt.credited',
    {
      receiptId: 'r1',
      userId: USER,
      tenantId: null,
      totalKopecks: 60_000,
      pointsAwarded: 18,
      pointsTxId: 'tx-1',
      pointsState: 'available',
      availableAt: null,
      firstReceipt: false,
    },
    'receipt_credited',
    { receiptId: 'r1', pointsTxId: 'tx-1', points: 18 },
  ],
  [
    'points.released',
    { userId: USER, accountId: 'acc-1', txId: 'tx-1', amount: 150, availableBalance: 470 },
    'points_released',
    { txId: 'tx-1', accountId: 'acc-1' },
  ],
  [
    'points.expiring',
    { userId: USER, accountId: 'acc-1', points: 40, expiresOn: '2026-12-01', daysLeft: 30 },
    'points_expiring',
    { accountId: 'acc-1', expiresOn: '2026-12-01', daysLeft: 30 },
  ],
  [
    'points.expired',
    { userId: USER, accountId: 'acc-1', points: 40, expiredOn: '2026-11-01', availableBalance: 0 },
    'points_expired',
    { accountId: 'acc-1', expiredOn: '2026-11-01' },
  ],
  [
    'adjustment.applied',
    {
      adjustmentId: 'adj-1',
      accountId: 'acc-1',
      userId: USER,
      amount: 150,
      reason: 'Компенсація',
      requestedById: 'admin-1',
      pointsTxId: 'tx-9',
    },
    'points_adjusted',
    { adjustmentId: 'adj-1', pointsTxId: 'tx-9' },
  ],
  [
    'parking.session.payable',
    { ...parkingBase, amountDueKopecks: 6000, currentHourEndsAt: '2026-11-01T14:12:00.000Z' },
    'parking_payable',
    { sessionId: 'session-1', amountDueKopecks: 6000, plate: 'AC1234BC' },
  ],
  [
    'parking.session.paid',
    {
      ...parkingBase,
      status: 'paid',
      paymentId: 'payment-1',
      amountPaidKopecks: 6000,
      paidUntil: '2026-11-01T14:00:00.000Z',
    },
    'parking_paid',
    { sessionId: 'session-1', paymentId: 'payment-1', paidUntil: '2026-11-01T14:00:00.000Z' },
  ],
  [
    'parking.session.overstay',
    { ...parkingBase, status: 'overstay', paidUntil: null, amountDueKopecks: 4000 },
    'parking_overstay',
    { sessionId: 'session-1', amountDueKopecks: 4000 },
  ],
  [
    'parking.session.closed',
    {
      ...parkingBase,
      status: 'closed',
      exitedAt: '2026-11-01T13:52:00.000Z',
      closedReason: null,
      amountPaidKopecks: 6000,
    },
    'parking_closed',
    { sessionId: 'session-1', status: 'closed', closedReason: null },
  ],
  [
    'payment.succeeded',
    { ...paymentBase, purpose: 'other', paidAt: '2026-11-01T10:00:00.000Z' },
    'payment_succeeded',
    { paymentId: 'payment-1', purpose: 'other' },
  ],
  [
    'payment.failed',
    { ...paymentBase, purpose: 'parking', status: 'failed', failureCode: 'card_declined' },
    'payment_failed',
    { paymentId: 'payment-1', failureCode: 'card_declined', sessionId: 'session-1' },
  ],
  [
    'payment.refunded',
    {
      ...paymentBase,
      purpose: 'parking',
      status: 'refunded',
      meta: { sessionId: 'session-1', plate: 'AC1234BC' },
      refundedKopecks: 6000,
      partial: false,
    },
    'payment_refunded',
    { paymentId: 'payment-1', sessionId: 'session-1', refundedKopecks: 6000, partial: false },
  ],
  [
    'user.deletion_requested',
    { userId: USER, requestId: 'del-1', executeAfter: '2026-12-01T10:00:00.000Z' },
    'account_deletion_scheduled',
    { requestId: 'del-1', executeAfter: '2026-12-01T10:00:00.000Z' },
  ],
  [
    'user.deletion_cancelled',
    { userId: USER, requestId: 'del-1', cancelledAt: '2026-11-01T10:00:00.000Z' },
    'account_deletion_cancelled',
    { requestId: 'del-1' },
  ],
  [
    'parking.session.opened',
    { ...parkingBase, status: 'open', enteredAt: '2026-11-01T12:00:00.000Z' },
    'parking_opened',
    { sessionId: 'session-1', plate: 'AC1234BC', zone: 'underground' },
  ],
  [
    'parking.session.free_ending',
    {
      ...parkingBase,
      status: 'open',
      enteredAt: '2026-11-01T12:00:00.000Z',
      reminder: 'free_ending',
      deadline: '2026-11-01T12:30:00.000Z',
      minutesLeft: 5,
      source: 'provider',
      amountDueKopecks: 0,
      paidUntil: null,
    },
    'parking_free_ending',
    { sessionId: 'session-1', reminder: 'free_ending', deadline: '2026-11-01T12:30:00.000Z' },
  ],
  [
    'parking.session.exit_soon',
    {
      ...parkingBase,
      status: 'paid',
      reminder: 'exit_soon',
      deadline: '2026-11-01T14:00:00.000Z',
      minutesLeft: 10,
      source: 'provider',
      amountDueKopecks: 0,
      paidUntil: '2026-11-01T14:00:00.000Z',
    },
    'parking_exit_soon',
    { sessionId: 'session-1', reminder: 'exit_soon', paidUntil: '2026-11-01T14:00:00.000Z' },
  ],
  [
    'parking.session.still_inside',
    {
      ...parkingBase,
      status: 'payable',
      reminder: 'still_inside',
      deadline: '2026-11-01T17:12:00.000Z',
      minutesLeft: 0,
      source: 'provider',
      amountDueKopecks: 22000,
      paidUntil: null,
    },
    'parking_still_inside',
    { sessionId: 'session-1', reminder: 'still_inside', amountDueKopecks: 22000 },
  ],
];

describe('mapOutboxEvent', () => {
  it.each(SINGLE_NOTIFY)('%s -> one %s notification', (type, payload, kind, data) => {
    const actions = mapOutboxEvent(job(type, payload), CONTEXT);
    const [input] = notifications(actions);
    expect(actions).toHaveLength(1);
    expect(input).toMatchObject({ userId: USER, kind, dedupeKey: 'outbox:evt-1', data });
    expect(input?.title.length).toBeGreaterThan(0);
    expect(input?.body.length).toBeGreaterThan(0);
  });

  it('announces a held receipt with the release date', () => {
    const actions = mapOutboxEvent(
      job('receipt.credited', {
        receiptId: 'r1',
        userId: USER,
        tenantId: null,
        totalKopecks: 450_000,
        pointsAwarded: 135,
        pointsTxId: 'tx-1',
        pointsState: 'pending',
        availableAt: '2026-11-08T10:00:00.000Z',
        firstReceipt: false,
      }),
      CONTEXT,
    );
    expect(notifications(actions)[0]?.kind).toBe('receipt_held');
  });

  it('notifies about an issued voucher and schedules the expiry reminder', () => {
    const actions = mapOutboxEvent(job('voucher.issued', voucherBase), CONTEXT);
    expect(actions.map((action) => action.type)).toEqual(['notify', 'schedule_reminder']);
    const reminder = actions[1];
    expect(reminder).toMatchObject({
      type: 'schedule_reminder',
      request: {
        id: 'voucher-expiring-voucher-1',
        jobName: 'reminder.voucher_expiring',
        runAt: new Date('2026-11-29T21:59:59.000Z'),
      },
    });
  });

  it('does not schedule an expiry reminder for tickets or vouchers without expiry', () => {
    const ticket = mapOutboxEvent(
      job('voucher.issued', { ...voucherBase, kind: 'ticket' }),
      CONTEXT,
    );
    const forever = mapOutboxEvent(
      job('voucher.issued', { ...voucherBase, expiresAt: null }),
      CONTEXT,
    );
    expect(ticket.map((action) => action.type)).toEqual(['notify']);
    expect(forever.map((action) => action.type)).toEqual(['notify']);
  });

  it.each([
    [
      'voucher.redeemed',
      {
        ...voucherBase,
        redeemedAt: NOW.toISOString(),
        redeemedByDeviceId: null,
        redeemedByTenantId: 't',
      },
      'voucher_redeemed',
    ],
    [
      'voucher.cancelled',
      { ...voucherBase, reason: 'Скасовано учасником', pointsRefunded: 60 },
      'voucher_cancelled',
    ],
  ])('%s notifies and cancels the pending expiry reminder', (type, payload, kind) => {
    const actions = mapOutboxEvent(job(type, payload), CONTEXT);
    expect(notifications(actions)[0]?.kind).toBe(kind);
    expect(actions[1]).toEqual({
      type: 'cancel_reminder',
      reminderId: 'voucher-expiring-voucher-1',
    });
  });

  it('voucher.expired only cancels the reminder', () => {
    const actions = mapOutboxEvent(job('voucher.expired', voucherBase), CONTEXT);
    expect(actions).toEqual([
      { type: 'cancel_reminder', reminderId: 'voucher-expiring-voucher-1' },
      { type: 'ignore', reason: 'voucher.expired has no notification kind' },
    ]);
  });

  it('confirms the registration, schedules a ticket reminder 24 hours before and cancels it on cancellation', () => {
    const registered = mapOutboxEvent(
      job('event.registered', {
        eventId: 'event-1',
        registrationId: 'reg-1',
        userId: USER,
        adults: 1,
        children: 1,
        voucherId: 'ticket-1',
        startsAt: '2026-11-07T13:00:00.000Z',
        title: 'Майстер-клас для дітей',
        venue: 'Атріум',
      }),
      CONTEXT,
    );
    expect(registered).toEqual([
      {
        type: 'notify',
        input: {
          userId: USER,
          kind: 'event_registered',
          title: 'Ви зареєстровані на подію',
          body: '«Майстер-клас для дітей» — 07.11 о 15:00, Атріум. 2 особи. Квиток у розділі Винагороди.',
          data: {
            eventId: 'event-1',
            registrationId: 'reg-1',
            voucherId: 'ticket-1',
            startsAt: '2026-11-07T13:00:00.000Z',
          },
          dedupeKey: 'outbox:evt-1',
        },
      },
      {
        type: 'schedule_reminder',
        request: {
          id: 'ticket-reminder-reg-1',
          jobName: 'reminder.ticket',
          runAt: new Date('2026-11-06T13:00:00.000Z'),
          data: {
            userId: USER,
            eventId: 'event-1',
            registrationId: 'reg-1',
            voucherId: 'ticket-1',
            startsAt: '2026-11-07T13:00:00.000Z',
          },
        },
      },
    ]);
    const cancelled = mapOutboxEvent(
      job('event.registration_cancelled', {
        eventId: 'event-1',
        registrationId: 'reg-1',
        userId: USER,
        voucherId: 'ticket-1',
      }),
      CONTEXT,
    );
    expect(cancelled).toEqual([{ type: 'cancel_reminder', reminderId: 'ticket-reminder-reg-1' }]);
  });

  it('skips the ticket reminder when the event starts too soon', () => {
    const actions = mapOutboxEvent(
      job('event.registered', {
        eventId: 'event-1',
        registrationId: 'reg-1',
        userId: USER,
        adults: 1,
        children: 0,
        voucherId: null,
        startsAt: '2026-11-02T09:00:00.000Z',
      }),
      CONTEXT,
    );
    // Payloads published before title/venue were added still get a confirmation.
    expect(actions).toEqual([
      expect.objectContaining({
        type: 'notify',
        input: expect.objectContaining({
          kind: 'event_registered',
          body: 'Реєстрацію на подію 02.11 о 11:00 підтверджено (1 особа). Квиток у розділі Винагороди.',
        }),
      }),
      { type: 'ignore', reason: 'event starts too soon for a reminder' },
    ]);
  });

  it('turns event.published into a marketing broadcast', () => {
    const actions = mapOutboxEvent(
      job('event.published', {
        eventId: 'event-1',
        title: 'Майстер-клас «Розпис пряників»',
        category: 'masterclass',
        tenantId: 'tenant-1',
        venue: 'Figli Migli, 3 поверх',
        startsAt: '2026-11-07T10:00:00.000Z',
        endsAt: '2026-11-07T11:30:00.000Z',
        admission: 'registration',
      }),
      CONTEXT,
    );
    expect(actions).toEqual([
      {
        type: 'broadcast',
        kind: 'event_published',
        message: {
          title: 'Нова подія в Порт City',
          body: '«Майстер-клас «Розпис пряників»» — 07.11 о 12:00, Figli Migli, 3 поверх. Реєстрація вже відкрита в застосунку.',
        },
        data: {
          eventId: 'event-1',
          tenantId: 'tenant-1',
          category: 'masterclass',
          admission: 'registration',
          startsAt: '2026-11-07T10:00:00.000Z',
        },
        dedupeKey: 'outbox:evt-1',
      },
    ]);
  });

  it('confirms a support request in-app and e-mails the support desk', () => {
    const payload = {
      requestId: 'request-1',
      number: 1042,
      userId: USER,
      topic: 'parking',
      relatedType: 'parking_session',
      relatedId: 'session-1',
      message: 'Шлагбаум не відкрився після оплати',
      photoKey: null,
      createdAt: NOW.toISOString(),
    };
    const actions = mapOutboxEvent(job('support.request_created', payload), CONTEXT);
    expect(actions).toEqual([
      {
        type: 'notify',
        input: {
          userId: USER,
          kind: 'support_request_received',
          title: 'Звернення № 1042 прийнято',
          body: expect.stringContaining('24 годин'),
          data: { requestId: 'request-1', number: 1042, topic: 'parking' },
          dedupeKey: 'outbox:evt-1',
        },
      },
      { type: 'support_mail', request: payload },
    ]);
  });

  it('tells every registered member that the event was cancelled, deduplicated per member', () => {
    const actions = mapOutboxEvent(
      job('event.cancelled', {
        eventId: 'event-1',
        title: 'Майстер-клас',
        registeredUserIds: ['u1', 'u2'],
      }),
      CONTEXT,
    );
    const inputs = notifications(actions);
    expect(inputs.map((input) => [input.userId, input.kind, input.dedupeKey])).toEqual([
      ['u1', 'system', 'outbox:evt-1:u1'],
      ['u2', 'system', 'outbox:evt-1:u2'],
    ]);
    expect(inputs[0]?.body).toContain('Майстер-клас');
    expect(
      mapOutboxEvent(
        job('event.cancelled', { eventId: 'e', title: 't', registeredUserIds: [] }),
        CONTEXT,
      ),
    ).toEqual([{ type: 'ignore', reason: 'event.cancelled without registered users' }]);
  });

  it('turns promo.published into a marketing broadcast', () => {
    const actions = mapOutboxEvent(
      job('promo.published', {
        promoId: 'promo-1',
        tenantId: 'tenant-1',
        title: '-20 % INTERTOP',
        kind: 'coupon',
        validTo: '2026-11-15T21:59:59.000Z',
      }),
      CONTEXT,
    );
    expect(actions).toEqual([
      expect.objectContaining({
        type: 'broadcast',
        kind: 'promo_published',
        data: { promoId: 'promo-1', tenantId: 'tenant-1', promoKind: 'coupon' },
        dedupeKey: 'outbox:evt-1',
      }),
    ]);
  });

  it('confirms a parking dispute in-app and ignores sessions without a member', () => {
    const disputed = {
      ...parkingBase,
      status: 'payable',
      reason: 'wrong_amount',
      comment: 'Стояв 20 хвилин',
      disputedAt: NOW.toISOString(),
    };
    const actions = mapOutboxEvent(job('parking.session.disputed', disputed), CONTEXT);
    const [input] = notifications(actions);
    expect(input).toMatchObject({
      userId: USER,
      kind: 'parking_disputed',
      title: 'Звернення щодо паркування прийнято',
      data: { sessionId: 'session-1', reason: 'wrong_amount', disputedAt: NOW.toISOString() },
      dedupeKey: 'outbox:evt-1',
    });
    expect(input?.body).toContain('неправильну суму');
    expect(input?.body).toContain('AC 1234 BC');
    expect(
      mapOutboxEvent(job('parking.session.disputed', { ...disputed, userId: null }), CONTEXT),
    ).toEqual([{ type: 'ignore', reason: 'parking session without a member' }]);
  });

  it('leaves parking payments to parking.session.paid and anonymous sessions alone', () => {
    expect(
      mapOutboxEvent(
        job('payment.succeeded', { ...paymentBase, purpose: 'parking', paidAt: NOW.toISOString() }),
        CONTEXT,
      ),
    ).toEqual([
      { type: 'ignore', reason: 'parking payments are announced by parking.session.paid' },
    ]);
    expect(
      mapOutboxEvent(
        job('parking.session.payable', {
          ...parkingBase,
          userId: null,
          amountDueKopecks: 2000,
          currentHourEndsAt: NOW.toISOString(),
        }),
        CONTEXT,
      ),
    ).toEqual([{ type: 'ignore', reason: 'parking session without a member' }]);
  });

  it('tells the member about a parking refund and stays silent for other purposes', () => {
    const refunded = {
      ...paymentBase,
      purpose: 'parking',
      status: 'partially_refunded',
      meta: { sessionId: 'session-1', plate: 'AC1234BC' },
      refundedKopecks: 2000,
      partial: true,
    };
    const [input] = notifications(mapOutboxEvent(job('payment.refunded', refunded), CONTEXT));
    expect(input).toMatchObject({ kind: 'payment_refunded', title: 'Кошти за паркінг повернуто' });
    expect(input?.body).toContain('Повернули 20 ₴ з 60 ₴');
    expect(input?.body).toContain('AC 1234 BC');
    expect(
      mapOutboxEvent(job('payment.refunded', { ...refunded, purpose: 'other' }), CONTEXT),
    ).toEqual([{ type: 'ignore', reason: 'only parking refunds are announced to the member' }]);
  });

  it('renders the canonical parking reminder texts in Kyiv time', () => {
    const opened = notifications(
      mapOutboxEvent(
        job('parking.session.opened', {
          ...parkingBase,
          status: 'open',
          enteredAt: '2026-11-01T12:00:00.000Z',
        }),
        CONTEXT,
      ),
    )[0];
    // 2026-11-01 is winter time in Kyiv (UTC+2): 12:00Z -> 14:00, free until 14:30.
    expect(opened?.title).toBe('Ви на паркінгу Порт City. Безкоштовно до 14:30');
    const freeEnding = notifications(
      mapOutboxEvent(
        job('parking.session.free_ending', {
          ...parkingBase,
          status: 'open',
          enteredAt: '2026-11-01T12:00:00.000Z',
          reminder: 'free_ending',
          deadline: '2026-11-01T12:30:00.000Z',
          minutesLeft: 5,
          source: 'provider',
          amountDueKopecks: 0,
          paidUntil: null,
        }),
        CONTEXT,
      ),
    )[0];
    expect(freeEnding?.title).toBe('Безкоштовні 30 хв закінчуються о 14:30');
    const exitSoon = notifications(
      mapOutboxEvent(
        job('parking.session.exit_soon', {
          ...parkingBase,
          status: 'paid',
          reminder: 'exit_soon',
          deadline: '2026-11-01T14:00:00.000Z',
          minutesLeft: 10,
          source: 'provider',
          amountDueKopecks: 0,
          paidUntil: '2026-11-01T14:00:00.000Z',
        }),
        CONTEXT,
      ),
    )[0];
    expect(exitSoon?.title).toBe('Виїзд до 16:00 — залишилось 10 хв');
  });

  it('closes a disputed session with a support hint carrying the session id', () => {
    const [input] = notifications(
      mapOutboxEvent(
        job('parking.session.closed', {
          ...parkingBase,
          status: 'closed_unpaid',
          exitedAt: '2026-11-01T13:52:00.000Z',
          closedReason: 'user_left',
          amountPaidKopecks: 0,
        }),
        CONTEXT,
      ),
    );
    expect(input?.body).toMatch(/Я вже виїхав/);
    expect(input?.body).toMatch(/session-1/);
  });

  it('erases the inbox of a deleted member instead of notifying', () => {
    expect(
      mapOutboxEvent(
        job('user.deleted', { userId: USER, requestId: 'del-1', deletedAt: NOW.toISOString() }),
        CONTEXT,
      ),
    ).toEqual([{ type: 'erase_user', userId: USER }]);
  });

  it('ignores reminders of sessions without a member', () => {
    expect(
      mapOutboxEvent(
        job('parking.session.still_inside', {
          ...parkingBase,
          userId: null,
          reminder: 'still_inside',
          deadline: NOW.toISOString(),
          minutesLeft: 0,
          source: 'provider',
          amountDueKopecks: 0,
          paidUntil: null,
        }),
        CONTEXT,
      ),
    ).toEqual([{ type: 'ignore', reason: 'parking session without a member' }]);
  });

  it('ignores event types it does not handle', () => {
    expect(mapOutboxEvent(job('receipt.approved', {}), CONTEXT)).toEqual([
      { type: 'ignore', reason: 'unhandled event type "receipt.approved"' },
    ]);
    expect(isHandledEventType('receipt.approved')).toBe(false);
    expect(isHandledEventType('receipt.credited')).toBe(true);
  });

  it('routes every handled event to notifications-events and notification.created to the push queue', () => {
    for (const type of HANDLED_EVENT_TYPES) {
      expect(NOTIFICATION_OUTBOX_ROUTES[type]).toBe('notifications-events');
    }
    expect(NOTIFICATION_OUTBOX_ROUTES['notification.created']).toBe('notifications-push');
  });

  it('builds dedupe keys from the outbox event id', () => {
    expect(eventDedupeKey('evt-7')).toBe('outbox:evt-7');
    expect(eventDedupeKey('evt-7', 'u1')).toBe('outbox:evt-7:u1');
  });
});
