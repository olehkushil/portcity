import type { TenantSummary } from '../../../common/contracts/content';

/**
 * Public URL of a stored object: `S3_PUBLIC_BASE_URL` + key, joined with exactly one slash.
 * Null when the key or the base URL is missing (the app then shows its placeholder); a key
 * that is already an absolute URL is returned unchanged.
 */
export function publicMediaUrl(
  baseUrl: string | null | undefined,
  key: string | null | undefined,
): string | null {
  const trimmedKey = key?.trim();
  if (!trimmedKey) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmedKey)) {
    return trimmedKey;
  }
  const base = baseUrl?.trim();
  if (!base) {
    return null;
  }
  return `${base.replace(/\/+$/, '')}/${trimmedKey.replace(/^\/+/, '')}`;
}

/** Tenant summary as the wallet and the catalogue show it. */
export interface TenantView {
  id: string;
  slug: string;
  name: string;
  floor: number | null;
  logoUrl: string | null;
}

/**
 * The content module may already resolve `logoUrl` on its summaries (it has its own logo base
 * URL); otherwise the URL is built from `logoKey` and S3_PUBLIC_BASE_URL.
 */
export function toTenantView(
  tenant: TenantSummary,
  baseUrl: string | null | undefined,
): TenantView {
  const resolved = (tenant as TenantSummary & { logoUrl?: unknown }).logoUrl;
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    floor: tenant.floor,
    logoUrl:
      typeof resolved === 'string' && resolved.length > 0
        ? resolved
        : publicMediaUrl(baseUrl, tenant.logoKey),
  };
}
