import { NOTIFICATION_KINDS, type NotificationKind } from '../../../common/contracts/notifications';
import {
  MAX_TITLE_LENGTH,
  TEMPLATE_KINDS,
  type TemplateParams,
  daysUk,
  formatDayKey,
  personsUk,
  renderTemplate,
} from './templates';

// 2026-03-01 is winter time in Kyiv (UTC+2): 12:00Z -> 14:00.
const at = new Date('2026-03-01T12:00:00Z');

const samples: { [K in NotificationKind]: TemplateParams[K] } = {
  receipt_credited: { totalKopecks: 600_000, points: 180 },
  receipt_held: { totalKopecks: 1_250_000, points: 375, availableAt: at },
  receipt_needs_moderation: { totalKopecks: 1_250_000 },
  receipt_approved: { totalKopecks: null },
  receipt_rejected: { reason: 'чек старший за 7 днів' },
  points_released: { points: 375, availableBalance: 695 },
  points_expiring: { points: 120, expiresOn: '2026-03-31', daysLeft: 30 },
  points_expired: { points: 120, expiredOn: '2026-03-31', availableBalance: 200 },
  points_adjusted: { amount: -50, reason: 'помилкове нарахування' },
  voucher_issued: { voucherKind: 'coupon', title: '-20 % INTERTOP', expiresAt: at },
  voucher_redeemed: { title: 'Кава з собою', redeemedAt: at },
  voucher_expiring: { title: 'Кава з собою', expiresAt: at },
  voucher_cancelled: { title: 'Квиток у кіно', reason: 'скасовано учасником', pointsRefunded: 450 },
  ticket_reminder: { title: 'Майстер-клас для дітей', startsAt: at, venue: 'атріум, 3 поверх' },
  event_registered: { title: 'Майстер-клас для дітей', startsAt: at, venue: 'Атріум', persons: 3 },
  event_published: {
    title: 'Майстер-клас «Розпис пряників»',
    startsAt: at,
    venue: 'Figli Migli, 3 поверх',
    admission: 'registration',
  },
  parking_opened: {
    enteredAt: new Date('2026-03-01T11:30:00Z'),
    freeUntil: at,
    plate: 'AC1234BC',
  },
  parking_free_ending: { freeUntil: at, freeMinutes: 30 },
  parking_payable: { amountDueKopecks: 2000, currentHourEndsAt: at },
  parking_paid: { amountPaidKopecks: 6000, paidUntil: at },
  parking_exit_soon: { paidUntil: at, minutesLeft: 10 },
  parking_overstay: { amountDueKopecks: 4000, paidUntil: at },
  parking_still_inside: { amountDueKopecks: 6000 },
  parking_disputed: { sessionId: 'session-1', plate: 'AC1234BC', reason: 'not_my_car' },
  parking_closed: {
    sessionId: 'session-1',
    exitedAt: at,
    amountPaidKopecks: 6000,
    status: 'closed',
    closedReason: null,
  },
  payment_succeeded: { amountKopecks: 6000, purpose: 'other' },
  payment_failed: { amountKopecks: 6000, failureCode: 'card_declined' },
  payment_refunded: {
    refundedKopecks: 6000,
    amountKopecks: 6000,
    partial: false,
    plate: 'AC1234BC',
  },
  account_deletion_scheduled: { executeAfter: at },
  account_deletion_cancelled: { cancelledAt: at },
  promo_published: { title: '1+1 Aroma Kava', validTo: at },
  support_request_received: { number: 1042 },
  system: { title: 'Технічні роботи', body: 'Застосунок буде недоступний з 02:00 до 03:00.' },
};

describe('notification templates', () => {
  it('has a template for every kind', () => {
    expect([...TEMPLATE_KINDS].sort()).toEqual([...NOTIFICATION_KINDS].sort());
  });

  it.each(NOTIFICATION_KINDS)('%s renders a non-empty Ukrainian title and body', (kind) => {
    const rendered = renderTemplate(kind, samples[kind]);
    expect(rendered.title.length).toBeGreaterThan(0);
    expect(rendered.title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(rendered.body.length).toBeGreaterThan(0);
    expect(rendered.body).not.toMatch(/undefined|null|NaN|Invalid/);
  });

  const expectations: Array<[NotificationKind, RegExp[]]> = [
    ['receipt_credited', [/6 000 ₴/, /\+180 балів/]],
    ['receipt_held', [/12 500 ₴/, /375 балів/, /01\.03\.2026/]],
    ['receipt_needs_moderation', [/12 500 ₴/, /модератор/]],
    ['receipt_rejected', [/чек старший за 7 днів/, /апеляцію/]],
    ['points_released', [/375 балів/, /695 балів/]],
    ['points_expiring', [/120 балів/, /31\.03\.2026/, /30 днів/]],
    ['points_expired', [/згоріли 31\.03\.2026/, /200 балів/]],
    ['points_adjusted', [/списано 50 балів/, /помилкове нарахування/]],
    ['voucher_issued', [/Купон/, /-20 % INTERTOP/, /01\.03\.2026 14:00/]],
    ['voucher_redeemed', [/Кава з собою/, /14:00/]],
    ['voucher_cancelled', [/Квиток у кіно/, /Повернено 450 балів/]],
    ['ticket_reminder', [/Майстер-клас для дітей/, /01\.03 о 14:00/, /атріум/]],
    ['parking_opened', [/Ви на паркінгу Порт City\. Безкоштовно до 14:00/, /13:30 · AC 1234 BC/]],
    ['parking_free_ending', [/Безкоштовні 30 хв закінчуються о 14:00/]],
    ['parking_payable', [/20 ₴/, /до 14:00/]],
    ['parking_exit_soon', [/Виїзд до 14:00 — залишилось 10 хв/]],
    ['parking_still_inside', [/Ви ще на паркінгу\?/, /60 ₴/, /Я вже виїхав/]],
    ['parking_paid', [/60 ₴/, /Виїзд до 14:00/]],
    ['parking_overstay', [/минув о 14:00/, /40 ₴/]],
    ['parking_closed', [/Виїзд о 14:00/, /Сплачено 60 ₴/]],
    ['payment_succeeded', [/60 ₴/]],
    ['payment_failed', [/60 ₴/, /card_declined/]],
    ['payment_refunded', [/Повернули 60 ₴ за оплату паркінгу \(AC 1234 BC\)/, /картку/]],
    ['account_deletion_scheduled', [/01\.03\.2026/]],
    ['account_deletion_cancelled', [/Видалення акаунта скасовано/]],
    ['promo_published', [/1\+1 Aroma Kava/, /01\.03\.2026/]],
    ['event_registered', [/зареєстровані/, /Майстер-клас для дітей/, /01\.03 о 14:00/, /3 особи/]],
    ['event_published', [/Нова подія/, /Розпис пряників/, /01\.03 о 14:00/, /Figli Migli/]],
    ['support_request_received', [/Звернення № 1042 прийнято/, /24 годин/]],
    ['parking_disputed', [/прийнято/, /авто AC 1234 BC не ваше/, /session-1/]],
  ];

  it('confirms a registration without a title and announces external events', () => {
    expect(
      renderTemplate('event_registered', { ...samples.event_registered, title: null, persons: 1 })
        .body,
    ).toMatch(/Реєстрацію на подію 01\.03 о 14:00 підтверджено \(1 особа\)/);
    expect(
      renderTemplate('event_published', { ...samples.event_published, admission: 'external' }).body,
    ).toMatch(/Деталі в застосунку/);
    expect(personsUk(5)).toBe('5 осіб');
  });

  it.each(expectations)('%s mentions the right facts', (kind, patterns) => {
    const rendered = renderTemplate(kind, samples[kind]);
    for (const pattern of patterns) {
      expect(`${rendered.title} ${rendered.body}`).toMatch(pattern);
    }
  });

  it('uses Ukrainian plural forms for points', () => {
    expect(renderTemplate('points_released', { points: 1, availableBalance: 2 }).body).toMatch(
      /1 бал з утримання.*2 бали/,
    );
    expect(renderTemplate('points_released', { points: 21, availableBalance: 11 }).body).toMatch(
      /21 бал .*11 балів/,
    );
  });

  it('positive adjustments read as a credit', () => {
    expect(renderTemplate('points_adjusted', { amount: 100, reason: 'компенсація' }).body).toMatch(
      /нараховано 100 балів/,
    );
  });

  it('varies the voucher wording by kind', () => {
    expect(
      renderTemplate('voucher_issued', { ...samples.voucher_issued, voucherKind: 'ticket' }).title,
    ).toBe('Квиток оформлено');
    expect(
      renderTemplate('voucher_issued', {
        ...samples.voucher_issued,
        voucherKind: 'reward',
        expiresAt: null,
      }).body,
    ).not.toMatch(/Дійсний до/);
  });

  it('describes free and unpaid parking exits', () => {
    expect(
      renderTemplate('parking_closed', { ...samples.parking_closed, status: 'closed_free' }).body,
    ).toMatch(/безкоштовним/);
    expect(
      renderTemplate('parking_closed', { ...samples.parking_closed, status: 'closed_unpaid' }).body,
    ).toMatch(/без оплати/);
  });

  it('explains sessions closed by "Я вже виїхав" and by timeout with the session id', () => {
    const userLeft = renderTemplate('parking_closed', {
      ...samples.parking_closed,
      status: 'closed_unpaid',
      closedReason: 'user_left',
    }).body;
    expect(userLeft).toMatch(/Я вже виїхав/);
    expect(userLeft).toMatch(/оператор звірить/);
    expect(userLeft).toMatch(/підтримку.*session-1/);
    const timeout = renderTemplate('parking_closed', {
      ...samples.parking_closed,
      status: 'closed_unpaid',
      closedReason: 'timeout',
    }).body;
    expect(timeout).toMatch(/автоматично о 14:00/);
    expect(timeout).toMatch(/session-1/);
  });

  it('asks a member still inside without an amount due to confirm the exit', () => {
    expect(renderTemplate('parking_still_inside', { amountDueKopecks: 0 }).body).not.toMatch(/₴/);
  });

  it('system notifications pass the caller text through', () => {
    expect(renderTemplate('system', samples.system)).toEqual(samples.system);
  });

  it('clamps overlong titles to the column size', () => {
    const rendered = renderTemplate('system', { title: 'x'.repeat(300), body: 'y' });
    expect(rendered.title.length).toBe(MAX_TITLE_LENGTH);
  });

  it('formats day keys and day counts', () => {
    expect(formatDayKey('2026-03-15')).toBe('15.03.2026');
    expect(formatDayKey('not-a-day')).toBe('not-a-day');
    expect(daysUk(1)).toBe('1 день');
    expect(daysUk(3)).toBe('3 дні');
    expect(daysUk(7)).toBe('7 днів');
    expect(daysUk(21)).toBe('21 день');
  });
});
