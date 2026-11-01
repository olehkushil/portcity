import type { NotificationKind } from '../../../common/contracts/notifications';
import type { ParkingSessionStatus } from '../../../common/contracts/parking';
import type { PaymentPurpose } from '../../../common/contracts/payments';
import type { VoucherKind } from '../../../common/contracts/rewards';
import { formatPoints, formatUah, pluralizeUk } from '../../../common/money/money';
import { formatKyiv } from '../../../common/time/kyiv';

/** Notification.title is VarChar(200). */
export const MAX_TITLE_LENGTH = 200;
export const MAX_BODY_LENGTH = 2000;

/** Parameters each kind needs to render its Ukrainian title and body. */
export interface TemplateParams {
  receipt_credited: { totalKopecks: number; points: number };
  receipt_held: { totalKopecks: number; points: number; availableAt: Date };
  receipt_needs_moderation: { totalKopecks: number };
  receipt_approved: { totalKopecks: number | null };
  receipt_rejected: { reason: string };
  points_released: { points: number; availableBalance: number };
  points_expiring: { points: number; expiresOn: string; daysLeft: number };
  points_expired: { points: number; expiredOn: string; availableBalance: number };
  points_adjusted: { amount: number; reason: string };
  voucher_issued: { voucherKind: VoucherKind; title: string; expiresAt: Date | null };
  voucher_redeemed: { title: string; redeemedAt: Date };
  voucher_expiring: { title: string; expiresAt: Date };
  voucher_cancelled: { title: string; reason: string; pointsRefunded: number | null };
  ticket_reminder: { title: string; startsAt: Date; venue: string | null };
  /** `title` is null for events published before the payload carried it. */
  event_registered: { title: string | null; startsAt: Date; venue: string | null; persons: number };
  event_published: {
    title: string;
    startsAt: Date;
    venue: string | null;
    admission: 'registration' | 'external';
  };
  parking_opened: { enteredAt: Date; freeUntil: Date; plate: string | null };
  parking_free_ending: { freeUntil: Date; freeMinutes: number };
  parking_payable: { amountDueKopecks: number; currentHourEndsAt: Date };
  parking_paid: { amountPaidKopecks: number; paidUntil: Date };
  parking_exit_soon: { paidUntil: Date; minutesLeft: number };
  parking_overstay: { amountDueKopecks: number; paidUntil: Date | null };
  parking_still_inside: { amountDueKopecks: number };
  /** `reason`: not_my_car | wrong_amount | barrier (PARKING_DISPUTE_REASONS) or another value. */
  parking_disputed: { sessionId: string; plate: string | null; reason: string };
  parking_closed: {
    sessionId: string;
    exitedAt: Date;
    amountPaidKopecks: number;
    status: ParkingSessionStatus;
    closedReason: string | null;
  };
  payment_succeeded: { amountKopecks: number; purpose: PaymentPurpose };
  payment_failed: { amountKopecks: number; failureCode: string | null };
  /** Parking payments only (the event mapper ignores other purposes). */
  payment_refunded: {
    refundedKopecks: number;
    amountKopecks: number;
    partial: boolean;
    plate: string | null;
  };
  account_deletion_scheduled: { executeAfter: Date };
  account_deletion_cancelled: { cancelledAt: Date };
  promo_published: { title: string; validTo: Date };
  support_request_received: { number: number };
  system: { title: string; body: string };
}

export interface RenderedMessage {
  title: string;
  body: string;
}

type TemplateTable = { [K in NotificationKind]: (params: TemplateParams[K]) => RenderedMessage };

const uah = (kopecks: number): string => formatUah(kopecks, { fraction: 'auto' });
const day = (date: Date): string => formatKyiv(date, 'dd.MM.yyyy');
const time = (date: Date): string => formatKyiv(date, 'HH:mm');
const dayTime = (date: Date): string => formatKyiv(date, 'dd.MM.yyyy HH:mm');

/** `2026-03-15` -> `15.03.2026`; anything else is returned unchanged. */
export function formatDayKey(dayKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : dayKey;
}

export function daysUk(days: number): string {
  return `${days} ${pluralizeUk(days, ['день', 'дні', 'днів'])}`;
}

export function personsUk(persons: number): string {
  return `${persons} ${pluralizeUk(persons, ['особа', 'особи', 'осіб'])}`;
}

/** `07.11 о 15:00` (Kyiv). */
const eventWhen = (date: Date): string => formatKyiv(date, "dd.MM 'о' HH:mm");

function voucherNoun(kind: VoucherKind): { issuedTitle: string; noun: string } {
  switch (kind) {
    case 'coupon':
      return { issuedTitle: 'Купон отримано', noun: 'Купон' };
    case 'ticket':
      return { issuedTitle: 'Квиток оформлено', noun: 'Квиток' };
    case 'certificate':
      return { issuedTitle: 'Сертифікат отримано', noun: 'Сертифікат' };
    case 'reward':
      return { issuedTitle: 'Винагороду отримано', noun: 'Винагороду' };
  }
}

/** `AC1234BC` -> `AC 1234 BC` (Ukrainian plate layout); other plates are returned unchanged. */
export function formatPlate(plate: string): string {
  const match = /^([A-Z]{2})(\d{4})([A-Z]{2})$/.exec(plate);
  return match ? `${match[1]} ${match[2]} ${match[3]}` : plate;
}

/** Exit of a session the member closed with "Я вже виїхав" or that timed out at the operator. */
function parkingClosedSpecialBody(params: TemplateParams['parking_closed']): string | null {
  const exit = time(params.exitedAt);
  if (params.closedReason === 'user_left') {
    const disputed =
      params.status === 'closed_unpaid'
        ? ' Сума за паркування залишилась неоплаченою в застосунку: оператор звірить її з даними камер.'
        : '';
    return `Сесію закрито о ${exit} за вашим підтвердженням «Я вже виїхав».${disputed} Якщо є питання, зверніться в підтримку й назвіть ID сесії ${params.sessionId}.`;
  }
  if (params.closedReason === 'timeout') {
    return `Оператор паркінгу не підтвердив ваш виїзд, тому сесію закрито автоматично о ${exit}. Якщо ви ще на паркінгу або бачите помилку, зверніться в підтримку з ID сесії ${params.sessionId}.`;
  }
  return null;
}

/** First sentence of the dispute confirmation, by the reason the member picked. */
function parkingDisputeLead(reason: string, plate: string | null): string {
  const car = plate ? ` ${formatPlate(plate)}` : '';
  switch (reason) {
    case 'not_my_car':
      return `Ви повідомили, що авто${car} не ваше.`;
    case 'wrong_amount':
      return `Ви повідомили про неправильну суму за паркування${car ? ` авто${car}` : ''}.`;
    case 'barrier':
      return 'Ви повідомили про проблему зі шлагбаумом.';
    default:
      return 'Ви повідомили про проблему з паркувальною сесією.';
  }
}

function parkingClosedBody(params: TemplateParams['parking_closed']): string {
  const special = parkingClosedSpecialBody(params);
  if (special) {
    return special;
  }
  const exit = time(params.exitedAt);
  if (params.status === 'closed_free') {
    return `Виїзд о ${exit}. Паркування було безкоштовним.`;
  }
  if (params.status === 'closed_unpaid') {
    return `Виїзд о ${exit}. Сесію закрито без оплати в застосунку (оплата на паркоматі або у оператора).`;
  }
  return params.amountPaidKopecks > 0
    ? `Виїзд о ${exit}. Сплачено ${uah(params.amountPaidKopecks)}. Дякуємо, що були з нами.`
    : `Виїзд о ${exit}. Сесію завершено.`;
}

const TEMPLATES: TemplateTable = {
  receipt_credited: ({ totalKopecks, points }) => ({
    title: 'Бали нараховано',
    body: `Чек на ${uah(totalKopecks)} прийнято: +${formatPoints(points)} на ваш рахунок.`,
  }),
  receipt_held: ({ totalKopecks, points, availableAt }) => ({
    title: 'Чек прийнято, бали на утриманні',
    body: `Чек на ${uah(totalKopecks)} прийнято. ${formatPoints(points)} стануть доступними ${day(availableAt)}.`,
  }),
  receipt_needs_moderation: ({ totalKopecks }) => ({
    title: 'Чек на перевірці',
    body: `Чек на ${uah(totalKopecks)} перевіряє модератор. Зазвичай це займає до 24 годин.`,
  }),
  receipt_approved: ({ totalKopecks }) => ({
    title: 'Чек підтверджено',
    body:
      totalKopecks === null
        ? 'Модератор підтвердив ваш чек. Бали буде нараховано найближчим часом.'
        : `Модератор підтвердив чек на ${uah(totalKopecks)}. Бали буде нараховано найближчим часом.`,
  }),
  receipt_rejected: ({ reason }) => ({
    title: 'Чек відхилено',
    body: `Чек відхилено: ${reason}. Якщо ви не згодні, подайте апеляцію в застосунку.`,
  }),
  points_released: ({ points, availableBalance }) => ({
    title: 'Бали доступні',
    body: `${formatPoints(points)} з утримання переведено на баланс. Доступно: ${formatPoints(availableBalance)}.`,
  }),
  points_expiring: ({ points, expiresOn, daysLeft }) => ({
    title: 'Бали скоро згорять',
    body: `${formatPoints(points)} згорять ${formatDayKey(expiresOn)} (через ${daysUk(daysLeft)}). Встигніть обміняти їх на винагороди.`,
  }),
  points_expired: ({ points, expiredOn, availableBalance }) => ({
    title: 'Бали згоріли',
    body: `${formatPoints(points)} згоріли ${formatDayKey(expiredOn)}. Доступно: ${formatPoints(availableBalance)}.`,
  }),
  points_adjusted: ({ amount, reason }) => ({
    title: 'Коригування балів',
    body:
      amount >= 0
        ? `Вам нараховано ${formatPoints(amount)}. Причина: ${reason}.`
        : `З вашого рахунку списано ${formatPoints(Math.abs(amount))}. Причина: ${reason}.`,
  }),
  voucher_issued: ({ voucherKind, title, expiresAt }) => {
    const { issuedTitle, noun } = voucherNoun(voucherKind);
    return {
      title: issuedTitle,
      body: `${noun} «${title}» додано до розділу Винагороди${
        expiresAt ? `. Дійсний до ${dayTime(expiresAt)}` : ''
      }.`,
    };
  },
  voucher_redeemed: ({ title, redeemedAt }) => ({
    title: 'Ваучер використано',
    body: `«${title}» погашено ${dayTime(redeemedAt)}. Приємного відпочинку в Порт City!`,
  }),
  voucher_expiring: ({ title, expiresAt }) => ({
    title: 'Ваучер скоро закінчиться',
    body: `«${title}» дійсний до ${dayTime(expiresAt)}. Не забудьте скористатися.`,
  }),
  voucher_cancelled: ({ title, reason, pointsRefunded }) => ({
    title: 'Ваучер скасовано',
    body: `«${title}» скасовано. Причина: ${reason}.${
      pointsRefunded && pointsRefunded > 0 ? ` Повернено ${formatPoints(pointsRefunded)}.` : ''
    }`,
  }),
  ticket_reminder: ({ title, startsAt, venue }) => ({
    title: 'Нагадування про подію',
    body: `«${title}» починається ${formatKyiv(startsAt, "dd.MM 'о' HH:mm")}${
      venue ? `, ${venue}` : ''
    }. Квиток у розділі Винагороди.`,
  }),
  event_registered: ({ title, startsAt, venue, persons }) => ({
    title: 'Ви зареєстровані на подію',
    body: title
      ? `«${title}» — ${eventWhen(startsAt)}${venue ? `, ${venue}` : ''}. ${personsUk(persons)}. Квиток у розділі Винагороди.`
      : `Реєстрацію на подію ${eventWhen(startsAt)} підтверджено (${personsUk(persons)}). Квиток у розділі Винагороди.`,
  }),
  event_published: ({ title, startsAt, venue, admission }) => ({
    title: 'Нова подія в Порт City',
    body: `«${title}» — ${eventWhen(startsAt)}${venue ? `, ${venue}` : ''}. ${
      admission === 'registration'
        ? 'Реєстрація вже відкрита в застосунку.'
        : 'Деталі в застосунку.'
    }`,
  }),
  parking_opened: ({ enteredAt, freeUntil, plate }) => ({
    title: `Ви на паркінгу Порт City. Безкоштовно до ${time(freeUntil)}`,
    body: `Заїзд о ${time(enteredAt)}${plate ? ` · ${formatPlate(plate)}` : ''}. Нагадаємо, коли безкоштовний час закінчуватиметься.`,
  }),
  parking_free_ending: ({ freeUntil, freeMinutes }) => ({
    title: `Безкоштовні ${freeMinutes} хв закінчуються о ${time(freeUntil)}`,
    body: `Після ${time(freeUntil)} починається платний час. Оплатити можна в застосунку.`,
  }),
  parking_payable: ({ amountDueKopecks, currentHourEndsAt }) => ({
    title: 'Паркінг: час оплатити',
    body: `Безкоштовні 30 хвилин минули. До сплати ${uah(amountDueKopecks)} за поточну годину (до ${time(currentHourEndsAt)}). Оплатіть у застосунку, щоб виїхати без черги.`,
  }),
  parking_paid: ({ amountPaidKopecks, paidUntil }) => ({
    title: 'Паркінг оплачено',
    body: `Сплачено ${uah(amountPaidKopecks)}. Виїзд до ${time(paidUntil)}.`,
  }),
  parking_exit_soon: ({ paidUntil, minutesLeft }) => ({
    title: `Виїзд до ${time(paidUntil)} — залишилось ${minutesLeft} хв`,
    body: `Після ${time(paidUntil)} почнеться нова година паркінгу, яку треба буде доплатити.`,
  }),
  parking_overstay: ({ amountDueKopecks, paidUntil }) => ({
    title: 'Паркінг: оплачений час минув',
    body: `${paidUntil ? `Оплачений час минув о ${time(paidUntil)}. ` : ''}Розпочато нову годину, до сплати ${uah(amountDueKopecks)}.`,
  }),
  parking_still_inside: ({ amountDueKopecks }) => ({
    title: 'Ви ще на паркінгу?',
    body:
      amountDueKopecks > 0
        ? `До сплати ${uah(amountDueKopecks)}. Оплатіть у застосунку або позначте «Я вже виїхав», якщо вже поїхали.`
        : 'Якщо ви вже поїхали, позначте «Я вже виїхав» у застосунку.',
  }),
  parking_closed: (params) => ({
    title: 'Паркінг: сесію завершено',
    body: parkingClosedBody(params),
  }),
  parking_disputed: ({ sessionId, plate, reason }) => ({
    title: 'Звернення щодо паркування прийнято',
    body: `${parkingDisputeLead(reason, plate)} Ми перевіримо сесію разом з оператором паркінгу й повідомимо результат. ID сесії: ${sessionId}.`,
  }),
  payment_succeeded: ({ amountKopecks, purpose }) => ({
    title: 'Оплату отримано',
    body:
      purpose === 'parking'
        ? `Оплату паркінгу на ${uah(amountKopecks)} зараховано.`
        : `Платіж на ${uah(amountKopecks)} успішний.`,
  }),
  payment_failed: ({ amountKopecks, failureCode }) => ({
    title: 'Оплата не пройшла',
    body: `Платіж на ${uah(amountKopecks)} не пройшов${
      failureCode ? ` (код ${failureCode})` : ''
    }. Спробуйте ще раз або оберіть інший спосіб оплати.`,
  }),
  payment_refunded: ({ refundedKopecks, amountKopecks, partial, plate }) => ({
    title: 'Кошти за паркінг повернуто',
    body: `${
      partial
        ? `Повернули ${uah(refundedKopecks)} з ${uah(amountKopecks)}`
        : `Повернули ${uah(refundedKopecks)}`
    } за оплату паркінгу${plate ? ` (${formatPlate(plate)})` : ''}. Кошти надійдуть на картку, якою ви платили; строк зарахування залежить від банку. Якщо маєте питання, зверніться в підтримку.`,
  }),
  account_deletion_scheduled: ({ executeAfter }) => ({
    title: 'Видалення акаунта заплановано',
    body: `Акаунт і бали буде видалено ${day(executeAfter)}. Щоб скасувати, увійдіть у застосунок до цієї дати.`,
  }),
  account_deletion_cancelled: () => ({
    title: 'Видалення акаунта скасовано',
    body: 'Запит на видалення акаунта скасовано. Ваш акаунт, бали й ваучери збережено.',
  }),
  promo_published: ({ title, validTo }) => ({
    title: 'Нова акція в Порт City',
    body: `${title}. Діє до ${day(validTo)}.`,
  }),
  support_request_received: ({ number }) => ({
    title: `Звернення № ${number} прийнято`,
    body: 'Відповімо до 24 годин. Номер звернення допоможе, якщо ви телефонуватимете в підтримку.',
  }),
  system: ({ title, body }) => ({ title, body }),
};

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** Renders the Ukrainian title and body of a notification kind. Pure. */
export function renderTemplate<K extends NotificationKind>(
  kind: K,
  params: TemplateParams[K],
): RenderedMessage {
  const rendered = TEMPLATES[kind](params);
  return {
    title: clamp(rendered.title, MAX_TITLE_LENGTH),
    body: clamp(rendered.body, MAX_BODY_LENGTH),
  };
}

export const TEMPLATE_KINDS: readonly NotificationKind[] = Object.keys(
  TEMPLATES,
) as NotificationKind[];
