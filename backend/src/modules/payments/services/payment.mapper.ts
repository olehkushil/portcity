import type { Prisma, Payment } from '@prisma/client';
import { PAYMENT_CURRENCY, type PaymentSummary } from '../../../common/contracts/payments';
import type { CursorPayload } from '../../../common/pagination/cursor';
import { visibleCheckoutUrl } from '../domain/state-machine';

/**
 * `Payment.meta` layout: the caller's business context (`{ sessionId }`) stays at the top
 * level, exactly as `CreatePaymentInput.meta` gave it and as the seed writes it; the module's
 * own bookkeeping lives under one reserved key so it never collides with caller fields and is
 * stripped from `PaymentSummary.meta` and outbox payloads.
 */
export const INTERNAL_META_KEY = '_internal';

export interface RefundRecord {
  refundRef: string | null;
  kopecks: number;
  reason: string;
  /** `system`: an automatic refund (PaymentsPort.requestRefund). */
  source: 'admin' | 'provider' | 'system';
  actorId: string | null;
  at: string;
}

/**
 * A refund reserved under the row lock before the provider is called (so two refunds can never
 * pass the remainder check at once). `reserved`: the provider call is running or crashed;
 * `failed`: the provider call threw (a retry resumes with the same `requestId`, which the
 * provider de-duplicates); `awaiting_provider`: the provider accepted it and confirms with a
 * `refunded` webhook.
 */
export interface PendingRefundRecord {
  requestId?: string;
  state?: 'reserved' | 'failed' | 'awaiting_provider';
  refundRef: string | null;
  kopecks: number;
  reason: string;
  actorId: string | null;
  requestedAt: string;
  lastError?: string | null;
}

/** Automatic refund asked for by the purpose module (PaymentsPort.requestRefund). */
export interface AutoRefundRecord {
  state: 'queued' | 'done' | 'skipped';
  reason: string;
  source: string;
  amountKopecks: number | null;
  requestedAt: string;
  completedAt?: string | null;
  detail?: string | null;
}

export interface FiscalizationRecord {
  state: 'done' | 'skipped' | 'failed';
  adapter: string;
  fiscalRef?: string | null;
  reason?: string;
  at: string;
}

export interface InternalMeta {
  description?: string;
  returnUrl?: string | null;
  checkoutExpiresAt?: string | null;
  refunds?: RefundRecord[];
  pendingRefund?: PendingRefundRecord | null;
  autoRefund?: AutoRefundRecord | null;
  fiscalization?: FiscalizationRecord | null;
  lastEvent?: { source: string; externalId: string; at: string } | null;
  /** Logical key the attempt belongs to and its number (1 = the key itself). */
  baseKey?: string;
  attempt?: number;
  /** Set when the provider captured the money after the payment was closed. */
  lateSuccess?: { from: string; at: string } | null;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Caller-visible meta: everything except the reserved key. */
export function callerMeta(
  meta: Prisma.JsonValue | Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainRecord(meta)) {
    return {};
  }
  const { [INTERNAL_META_KEY]: _internal, ...rest } = meta;
  return rest;
}

export function internalMeta(meta: Prisma.JsonValue | Record<string, unknown>): InternalMeta {
  if (!isPlainRecord(meta)) {
    return {};
  }
  const internal = meta[INTERNAL_META_KEY];
  return isPlainRecord(internal) ? internal : {};
}

/** Returns a new meta object with the internal block replaced by `patch` merged over the old one. */
export function withInternalMeta(
  meta: Prisma.JsonValue | Record<string, unknown>,
  patch: Partial<InternalMeta>,
): Prisma.InputJsonObject {
  const base = isPlainRecord(meta) ? meta : {};
  const merged: InternalMeta = { ...internalMeta(base), ...patch };
  return JSON.parse(
    JSON.stringify({ ...base, [INTERNAL_META_KEY]: merged }),
  ) as Prisma.InputJsonObject;
}

export function buildInitialMeta(
  caller: Record<string, unknown>,
  internal: InternalMeta,
): Prisma.InputJsonObject {
  return withInternalMeta(callerMeta(caller), internal);
}

export function toPaymentSummary(row: Payment): PaymentSummary {
  return {
    id: row.id,
    userId: row.userId,
    purpose: row.purpose,
    amountKopecks: row.amountKopecks,
    currency: PAYMENT_CURRENCY,
    provider: row.provider,
    providerRef: row.providerRef,
    status: row.status,
    checkoutUrl: visibleCheckoutUrl(row.status, row.checkoutUrl),
    fiscalReceiptUrl: row.fiscalReceiptUrl,
    failureCode: row.failureCode,
    refundedKopecks: row.refundedKopecks,
    paidAt: row.paidAt,
    meta: callerMeta(row.meta),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// --- cursor pagination over (createdAt desc, id desc) ------------------------------------------

export interface PaymentCursor extends CursorPayload {
  createdAt: string;
  id: string;
}

export function isPaymentCursor(value: unknown): value is PaymentCursor {
  return (
    isPlainRecord(value) &&
    typeof value.createdAt === 'string' &&
    !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.id === 'string' &&
    value.id.length > 0
  );
}

export function paymentCursorOf(last: { createdAt: Date; id: string }): PaymentCursor {
  return { createdAt: last.createdAt.toISOString(), id: last.id };
}

/** Prisma `where` fragment selecting rows strictly after the cursor in (createdAt desc, id desc). */
export function cursorWhere(cursor: PaymentCursor | undefined): Prisma.PaymentWhereInput[] {
  if (!cursor) {
    return [];
  }
  const createdAt = new Date(cursor.createdAt);
  return [
    {
      OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }],
    },
  ];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
