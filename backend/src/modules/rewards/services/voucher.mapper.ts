import type { Voucher } from '@prisma/client';
import type { TenantSummary } from '../../../common/contracts/content';
import type { VoucherSummary } from '../../../common/contracts/rewards';
import {
  signStaticVoucherQr,
  voucherDisplayNumber,
  voucherKindHasStaticQr,
} from '../domain/static-qr';
import { effectiveVoucherStatus, isLiveVoucherStatus } from '../domain/voucher-state';
import { type TenantView, publicMediaUrl, toTenantView } from './media-url';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function voucherMeta(voucher: Pick<Voucher, 'meta'>): Record<string, unknown> {
  return isPlainObject(voucher.meta) ? voucher.meta : {};
}

export interface VoucherSummaryOptions {
  /** VOUCHER_PEPPER; without it no static QR payload is produced. */
  pepper?: string | undefined;
}

/**
 * Projects a stored voucher to the contract summary at `now`: the status is the effective
 * one (a lapsed activation reads as `issued`, a passed `expiresAt` as `expired`) and the
 * code is exposed only while the activation is live. Tickets and certificates carry the static
 * offline QR while they are live; every voucher carries its 8-digit display number.
 */
export function toVoucherSummary(
  voucher: Voucher,
  now: Date,
  options: VoucherSummaryOptions = {},
): VoucherSummary {
  const status = effectiveVoucherStatus(voucher, now);
  const active = status === 'active';
  const staticQr =
    options.pepper !== undefined &&
    voucherKindHasStaticQr(voucher.kind) &&
    isLiveVoucherStatus(status)
      ? signStaticVoucherQr(voucher.id, voucher.expiresAt, options.pepper)
      : null;
  return {
    id: voucher.id,
    userId: voucher.userId,
    kind: voucher.kind,
    title: voucher.title,
    subtitle: voucher.subtitle,
    tenantId: voucher.tenantId,
    status,
    code: active ? voucher.code : null,
    activatedAt: active ? voucher.activatedAt : null,
    activationExpiresAt: active ? voucher.activationExpiresAt : null,
    redeemedAt: voucher.redeemedAt,
    redeemedByTenantId: voucher.redeemedByTenantId,
    expiresAt: voucher.expiresAt,
    sourceType: voucher.sourceType,
    sourceId: voucher.sourceId,
    meta: voucherMeta(voucher),
    createdAt: voucher.createdAt,
    displayNumber: voucherDisplayNumber(voucher.id),
    qrPayload: staticQr,
    imageKey: voucher.imageKey,
  };
}

/** HTTP view of a voucher (VoucherDto): the summary plus the tenant card and the image URL. */
export interface VoucherView extends VoucherSummary {
  displayNumber: string;
  qrPayload: string | null;
  imageKey: string | null;
  tenant: TenantView | null;
  imageUrl: string | null;
}

export function toVoucherView(
  summary: VoucherSummary,
  tenant: TenantSummary | null,
  publicBaseUrl: string | null | undefined,
): VoucherView {
  return {
    ...summary,
    displayNumber: summary.displayNumber ?? voucherDisplayNumber(summary.id),
    qrPayload: summary.qrPayload ?? null,
    imageKey: summary.imageKey ?? null,
    tenant: tenant ? toTenantView(tenant, publicBaseUrl) : null,
    imageUrl: publicMediaUrl(publicBaseUrl, summary.imageKey),
  };
}
