import type {
  PointsCounterparty,
  PointsDisplayInput,
  PointsSourceType,
  PointsTxType,
} from '../../../common/contracts/club';

/**
 * History display data of a ledger row (title, subtitle, counterparty). Callers of the ledger
 * port may supply it; otherwise a generic Ukrainian title is derived from the row type. The
 * data is written once at posting time: points_transactions is append-only.
 */

export const DISPLAY_TITLE_MAX = 200;
export const DISPLAY_SUBTITLE_MAX = 300;
const COUNTERPARTY_TEXT_MAX = 200;

export interface PointsDisplay {
  title: string;
  subtitle: string | null;
  counterparty: PointsCounterparty | null;
}

export const EXPIRE_TITLE = 'Бали згоріли';
export const REFUND_EXPIRED_SUBTITLE = 'Термін дії повернених балів уже минув';

/** Generic title for a row that was posted without display data (also used for old rows). */
export function defaultPointsTitle(
  type: PointsTxType,
  sourceType: PointsSourceType,
  amount: number,
): string {
  switch (type) {
    case 'earn':
    case 'hold':
    case 'release':
      return sourceType === 'receipt' ? 'Нарахування за чек' : 'Нарахування балів';
    case 'welcome':
      return 'Бонус';
    case 'spend':
      return sourceType === 'redemption' ? 'Обмін на винагороду' : 'Списання балів';
    case 'adjust':
      return amount >= 0 ? 'Нарахування від ТРЦ' : 'Списання балів';
    case 'expire':
      return EXPIRE_TITLE;
    case 'refund':
      return 'Повернення балів';
    case 'reverse':
      return 'Скасування нарахування';
    default: {
      const exhaustive: never = type;
      return String(exhaustive);
    }
  }
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

/** Keeps only known counterparty fields with valid values; null when nothing is left. */
export function normalizeCounterparty(
  input: PointsCounterparty | null | undefined,
): PointsCounterparty | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const result: PointsCounterparty = {};
  const tenantId = uuidOrNull(input.tenantId);
  if (tenantId) result.tenantId = tenantId;
  const tenantName = clip(input.tenantName, COUNTERPARTY_TEXT_MAX);
  if (tenantName) result.tenantName = tenantName;
  const receiptId = uuidOrNull(input.receiptId);
  if (receiptId) result.receiptId = receiptId;
  if (
    typeof input.receiptTotalKopecks === 'number' &&
    Number.isSafeInteger(input.receiptTotalKopecks) &&
    input.receiptTotalKopecks >= 0
  ) {
    result.receiptTotalKopecks = input.receiptTotalKopecks;
  }
  const rewardId = uuidOrNull(input.rewardId);
  if (rewardId) result.rewardId = rewardId;
  const rewardTitle = clip(input.rewardTitle, COUNTERPARTY_TEXT_MAX);
  if (rewardTitle) result.rewardTitle = rewardTitle;
  const voucherId = uuidOrNull(input.voucherId);
  if (voucherId) result.voucherId = voucherId;
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Display data to store with a new row: the caller's values (trimmed, clipped to the column
 * sizes) or the fallback title. `fallbackSubtitle` is used only when the caller sent none.
 */
export function resolvePointsDisplay(
  input: PointsDisplayInput | undefined,
  fallbackTitle: string,
  fallbackSubtitle: string | null = null,
): PointsDisplay {
  return {
    title: clip(input?.title, DISPLAY_TITLE_MAX) ?? clip(fallbackTitle, DISPLAY_TITLE_MAX) ?? '',
    subtitle: clip(input?.subtitle, DISPLAY_SUBTITLE_MAX) ?? fallbackSubtitle,
    counterparty: normalizeCounterparty(input?.counterparty),
  };
}
