/**
 * Public URL of a stored image (promo banner, event poster): `S3_PUBLIC_BASE_URL` + key.
 * Null when the key or the base URL is missing, so clients fall back to a placeholder. An
 * absolute http(s) URL stored as the key (WordPress import) is returned as is, like rewards does.
 */
export function publicImageUrl(
  baseUrl: string | null | undefined,
  key: string | null | undefined,
): string | null {
  const trimmedKey = key?.trim() ?? '';
  if (/^https?:\/\//i.test(trimmedKey)) {
    return trimmedKey;
  }
  const base = baseUrl?.trim().replace(/\/+$/, '') ?? '';
  const path = trimmedKey.replace(/^\/+/, '');
  if (base === '' || path === '') {
    return null;
  }
  const encoded = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${base}/${encoded}`;
}
