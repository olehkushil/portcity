/**
 * What the app shows after a submission (prototype screens scan-result, scan-pending,
 * scan-rejected) and the Ukrainian texts behind it. Pure module: no Nest, no Prisma.
 */
import type { LoyaltyRules } from '../../../common/contracts/club';
import {
  type ReceiptErrorCode,
  type ReceiptStatus,
  type ReceiptSubmissionOutcome,
  SUBMISSION_SCREENS,
  type SubmissionScreen,
} from '../../../common/contracts/receipts';
import { formatPoints, formatUah } from '../../../common/money/money';
import { formatKyiv } from '../../../common/time/kyiv';
import type { QrParseErrorCode } from './qr-parser';
import { MODERATION_REASONS, type ModerationReason, REJECTION_REASONS_UK } from './rules';

/** The three result screens of the prototype (defined in the receipts contract). */
export { SUBMISSION_SCREENS };
export type { SubmissionScreen };

export interface SubmissionViewInput {
  status: ReceiptStatus;
  pointsAwarded: number | null;
  /** State of the ledger entry when the receipt is credited. */
  pointsState: 'pending' | 'available' | null;
  pointsAvailableAt: Date | null;
  rejectionCode: ReceiptErrorCode | null;
  /** Receipt.decisionReason (rule rejection text or moderator reason). */
  decisionReason: string | null;
  moderationReasons: readonly ModerationReason[];
  rules: Pick<LoyaltyRules, 'autoApproveThresholdKopecks' | 'dailyReceiptLimit'>;
}

export interface SubmissionView {
  outcome: ReceiptSubmissionOutcome;
  screen: SubmissionScreen;
  /** Screen title, e.g. "Чек зараховано". */
  title: string;
  /** One or two sentences under the title. */
  message: string;
  pointsAwarded: number | null;
  pointsAvailableAt: Date | null;
  rejectionCode: ReceiptErrorCode | null;
  /** "Причина перевірки" lines of the pending screen. */
  moderationReasons: string[];
}

export const SUBMISSION_TITLES_UK: Readonly<Record<SubmissionScreen, string>> = Object.freeze({
  credited: 'Чек зараховано',
  pending: 'Чек на перевірці',
  rejected: 'Чек відхилено',
});

export const DEFAULT_REJECTION_MESSAGE_UK = 'Чек не відповідає правилам програми';
export const APPEAL_HINT_UK =
  'Якщо вважаєте, що це помилка, оскаржте — перевіримо вручну до 24 год.';

export function moderationReasonText(
  reason: ModerationReason,
  rules: SubmissionViewInput['rules'],
): string {
  switch (reason) {
    case 'manual_submission':
      return 'Чек без QR-коду перевіряє модератор';
    case 'fn_not_whitelisted':
      return 'Каса ще не підтверджена в програмі';
    case 'fn_blocked':
      return 'Касу заблоковано для автоматичного нарахування';
    case 'total_above_threshold':
      return `Сума понад ${formatUah(rules.autoApproveThresholdKopecks, { fraction: 'auto' })}`;
    case 'daily_limit_reached':
      return `Перевищено денний ліміт чеків (${rules.dailyReceiptLimit})`;
    case 'same_fn_burst':
      return 'Кілька чеків з однієї каси за короткий час';
    case 'daily_points_cap':
      return 'Досягнуто денного ліміту балів за QR-чеки';
    // Fraud patterns: the member sees one neutral line, so the heuristics are not disclosed;
    // moderators see the codes (GET /admin/receipts).
    case 'same_total_other_user':
    case 'round_total_repeat':
    case 'fiscal_id_out_of_order':
    case 'tax_check_failed':
      return PATTERN_REVIEW_TEXT_UK;
  }
}

/** Member-facing line for every fraud-pattern reason (deduplicated in the views). */
export const PATTERN_REVIEW_TEXT_UK = 'Чек потребує додаткової перевірки';

/** Ukrainian lines of the pending screen, one per distinct text. */
export function moderationReasonTexts(
  reasons: readonly ModerationReason[],
  rules: SubmissionViewInput['rules'],
): string[] {
  return [...new Set(reasons.map((reason) => moderationReasonText(reason, rules)))];
}

function isRejectionWithAppeal(status: ReceiptStatus): boolean {
  return status === 'rejected';
}

/** Maps a receipt state to the result screen and its texts. */
export function buildSubmissionView(input: SubmissionViewInput): SubmissionView {
  const base = {
    pointsAwarded: input.pointsAwarded,
    pointsAvailableAt: null as Date | null,
    rejectionCode: null as ReceiptErrorCode | null,
    moderationReasons: [] as string[],
  };

  if (input.status === 'credited') {
    const points = input.pointsAwarded ?? 0;
    if (points <= 0) {
      return {
        ...base,
        outcome: 'credited',
        screen: 'credited',
        title: SUBMISSION_TITLES_UK.credited,
        message: 'Чек зараховано, але денний ліміт балів для цього магазину вже вичерпано.',
      };
    }
    if (input.pointsState === 'pending') {
      const when = input.pointsAvailableAt
        ? ` ${formatKyiv(input.pointsAvailableAt, 'dd.MM.yyyy')}`
        : ' після періоду утримання';
      return {
        ...base,
        outcome: 'held',
        screen: 'credited',
        title: SUBMISSION_TITLES_UK.credited,
        message: `Нараховано +${formatPoints(points)}. Бали стануть доступні${when}.`,
        pointsAvailableAt: input.pointsAvailableAt,
      };
    }
    return {
      ...base,
      outcome: 'credited',
      screen: 'credited',
      title: SUBMISSION_TITLES_UK.credited,
      message: `Нараховано +${formatPoints(points)}. Бали вже можна обміняти на винагороди.`,
    };
  }

  if (isRejectionWithAppeal(input.status)) {
    const reason = input.decisionReason?.trim() || DEFAULT_REJECTION_MESSAGE_UK;
    return {
      ...base,
      pointsAwarded: null,
      outcome: 'rejected',
      screen: 'rejected',
      title: SUBMISSION_TITLES_UK.rejected,
      message: `Відхилено: ${lowerFirst(reason)}. ${APPEAL_HINT_UK}`,
      rejectionCode: input.rejectionCode,
    };
  }

  // needs_moderation and appealed wait for a moderator; the transient parsed / auto_approved /
  // approved states (credit still running in the receipts-process job) are `processing`. Both
  // show the "pending" screen.
  const inModeration = input.status === 'needs_moderation' || input.status === 'appealed';
  return {
    ...base,
    pointsAwarded: null,
    outcome: inModeration ? 'needs_moderation' : 'processing',
    screen: 'pending',
    title: SUBMISSION_TITLES_UK.pending,
    message: inModeration
      ? 'На перевірці · відповімо до 24 год. Бали нарахуємо після підтвердження — надішлемо сповіщення.'
      : 'Чек прийнято, бали нараховуються. Надішлемо сповіщення, щойно вони з’являться.',
    moderationReasons: inModeration
      ? moderationReasonTexts(input.moderationReasons, input.rules)
      : [],
  };
}

/** "Магазин не бере участі." -> "магазин не бере участі"; acronyms ("INTERTOP ...") stay as is. */
function lowerFirst(text: string): string {
  const trimmed = text.replace(/[.\s]+$/, '');
  const first = trimmed.charAt(0);
  const second = trimmed.charAt(1);
  const isWordStart =
    second !== '' && second === second.toLowerCase() && second !== second.toUpperCase();
  return isWordStart ? first.toLowerCase() + trimmed.slice(1) : trimmed;
}

// ---------------------------------------------------------------------------
// Persisted decision details: receipts.moderation_reasons (JSON array) and
// receipts.rejection_code. Unknown values are dropped so a renamed reason never breaks a view.
// ---------------------------------------------------------------------------

/** Reads the `moderation_reasons` JSON column; unknown or malformed entries are dropped. */
export function parseModerationReasons(value: unknown): ModerationReason[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const known = new Set<string>(MODERATION_REASONS);
  const reasons: ModerationReason[] = [];
  for (const item of value) {
    if (
      typeof item === 'string' &&
      known.has(item) &&
      !reasons.includes(item as ModerationReason)
    ) {
      reasons.push(item as ModerationReason);
    }
  }
  return reasons;
}

/** Reads the `rejection_code` column; only rule rejection codes are accepted. */
export function parseRejectionCode(value: string | null | undefined): ReceiptErrorCode | null {
  return value !== null && value !== undefined && value in REJECTION_REASONS_UK
    ? (value as ReceiptErrorCode)
    : null;
}

// ---------------------------------------------------------------------------
// Member-facing error messages
// ---------------------------------------------------------------------------

export const QR_ERROR_MESSAGES_UK: Readonly<Record<QrParseErrorCode, string>> = Object.freeze({
  NOT_A_TAX_URL: 'Це не QR-код фіскального чека. Відскануйте QR-код унизу чека.',
  MISSING_PARAM:
    'У QR-коді чека бракує даних. Спробуйте відсканувати ще раз або додайте чек вручну.',
  BAD_DATE: 'Некоректна дата або час у QR-коді чека.',
  BAD_SUM: 'Некоректна сума в QR-коді чека.',
});

export const DUPLICATE_MESSAGE_UK = 'Цей чек уже зареєстровано в програмі.';
export const MANUAL_DISABLED_MESSAGE_UK = 'Додавання чеків без QR-коду тимчасово недоступне.';
export const APPEAL_NOT_ALLOWED_MESSAGE_UK = 'Оскаржити можна лише відхилений чек, один раз.';
export const PHOTO_REQUIRED_MESSAGE_UK = 'Фото чека не знайдено: спершу завантажте фото.';
