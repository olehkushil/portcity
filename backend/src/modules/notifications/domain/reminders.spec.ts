import type {
  EventRegisteredPayload,
  VoucherIssuedPayload,
} from '../../../common/contracts/events';
import {
  REMINDER_JOBS,
  isReminderJobName,
  planTicketReminder,
  planVoucherExpiringReminder,
  ticketReminderId,
  voucherExpiringReminderId,
} from './reminders';

const now = new Date('2026-03-01T10:00:00Z');
const policy = { ticketReminderHours: 24, voucherExpiringHours: 24 };

const registration: EventRegisteredPayload = {
  eventId: 'ev-1',
  registrationId: 'reg-1',
  userId: 'u-1',
  adults: 1,
  children: 2,
  voucherId: 'v-1',
  startsAt: '2026-03-07T13:00:00.000Z',
};

const voucher: VoucherIssuedPayload = {
  voucherId: 'v-2',
  userId: 'u-1',
  kind: 'coupon',
  title: '-20 % INTERTOP',
  tenantId: 't-1',
  sourceType: 'promo',
  sourceId: 'p-1',
  expiresAt: '2026-03-10T21:59:59.000Z',
};

describe('ticket reminders', () => {
  it('fires 24 hours before the event', () => {
    const plan = planTicketReminder(registration, now, policy);
    expect(plan).toEqual({
      id: 'ticket-reminder-reg-1',
      jobName: REMINDER_JOBS.ticket,
      runAt: new Date('2026-03-06T13:00:00.000Z'),
      data: {
        userId: 'u-1',
        eventId: 'ev-1',
        registrationId: 'reg-1',
        voucherId: 'v-1',
        startsAt: '2026-03-07T13:00:00.000Z',
      },
    });
  });

  it.each([
    ['event in 10 hours', '2026-03-01T20:00:00.000Z'],
    ['event in 24 hours and 5 minutes (inside the lead window)', '2026-03-02T10:05:00.000Z'],
    ['event already started', '2026-02-28T10:00:00.000Z'],
    ['garbage date', 'soon'],
  ])('is skipped for %s', (_name, startsAt) => {
    expect(planTicketReminder({ ...registration, startsAt }, now, policy)).toBeNull();
  });

  it('honours the configured lead time', () => {
    const plan = planTicketReminder(registration, now, { ...policy, ticketReminderHours: 2 });
    expect(plan?.runAt).toEqual(new Date('2026-03-07T11:00:00.000Z'));
  });
});

describe('voucher expiry reminders', () => {
  it('fires 24 hours before the hard expiry', () => {
    const plan = planVoucherExpiringReminder(voucher, now, policy);
    expect(plan?.id).toBe('voucher-expiring-v-2');
    expect(plan?.jobName).toBe(REMINDER_JOBS.voucherExpiring);
    expect(plan?.runAt).toEqual(new Date('2026-03-09T21:59:59.000Z'));
    expect(plan?.data).toEqual({
      userId: 'u-1',
      voucherId: 'v-2',
      voucherKind: 'coupon',
      title: '-20 % INTERTOP',
      expiresAt: '2026-03-10T21:59:59.000Z',
    });
  });

  it.each([
    ['no hard expiry', { expiresAt: null }],
    ['tickets (the event reminder covers them)', { kind: 'ticket' as const }],
    ['a two-hour coupon', { expiresAt: '2026-03-01T12:00:00.000Z' }],
    ['an unparsable expiry', { expiresAt: 'tomorrow' }],
  ])('is skipped for %s', (_name, overrides) => {
    expect(planVoucherExpiringReminder({ ...voucher, ...overrides }, now, policy)).toBeNull();
  });
});

describe('reminder ids and names', () => {
  it('are stable per registration / voucher', () => {
    expect(ticketReminderId('reg-9')).toBe('ticket-reminder-reg-9');
    expect(voucherExpiringReminderId('v-9')).toBe('voucher-expiring-v-9');
  });

  it('recognises reminder job names', () => {
    expect(isReminderJobName('reminder.ticket')).toBe(true);
    expect(isReminderJobName('reminder.voucher_expiring')).toBe(true);
    expect(isReminderJobName('receipt.credited')).toBe(false);
  });
});
