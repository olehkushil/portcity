import { S3StorageAdapter, type S3StorageOptions } from './s3-storage.adapter';
import { MAX_PRIVATE_DOWNLOAD_TTL_SECONDS } from './storage.port';

/**
 * Presigning is computed locally by the AWS SDK (no network call), so the download policy can
 * be checked with dummy credentials.
 */
function adapter(overrides: Partial<S3StorageOptions> = {}): S3StorageAdapter {
  return new S3StorageAdapter({
    bucket: 'portcity-test',
    region: 'eu-central-1',
    endpoint: 'http://localhost:9000',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    forcePathStyle: true,
    presignTtlSeconds: 86_400,
    publicBaseUrl: 'https://cdn.example/',
    ...overrides,
  });
}

function expiresParam(url: string): number {
  return Number(new URL(url).searchParams.get('X-Amz-Expires'));
}

describe('S3StorageAdapter download policy', () => {
  it('signs receipt photos with a short expiry even when S3_PUBLIC_BASE_URL is set', async () => {
    const s3 = adapter();
    const download = await s3.createPresignedDownload('receipts/user-1/2026/01/a.jpg');
    expect(download.url.startsWith('https://cdn.example')).toBe(false);
    expect(download.url).toContain('/portcity-test/receipts/user-1/2026/01/a.jpg');
    expect(download.url).toContain('X-Amz-Signature=');
    expect(expiresParam(download.url)).toBe(MAX_PRIVATE_DOWNLOAD_TTL_SECONDS);

    const short = await s3.createPresignedDownload('receipts/user-1/2026/01/a.jpg', 300);
    expect(expiresParam(short.url)).toBe(300);
  });

  it('returns a permanent URL only for public prefixes', () => {
    const s3 = adapter();
    expect(s3.publicUrl('tenants/2026/01/logo.png')).toBe(
      'https://cdn.example/tenants/2026/01/logo.png',
    );
    expect(s3.publicUrl('banners/main.jpg')).toBe('https://cdn.example/banners/main.jpg');
    expect(s3.publicUrl('receipts/user-1/2026/01/a.jpg')).toBeNull();
    expect(s3.publicUrl('anything/else.png')).toBeNull();
  });

  it('has no public URLs without a public base URL', async () => {
    const s3 = adapter({ publicBaseUrl: undefined });
    expect(s3.publicUrl('tenants/2026/01/logo.png')).toBeNull();
    const signed = await s3.createPresignedDownload('tenants/2026/01/logo.png', 7_200);
    expect(expiresParam(signed.url)).toBe(7_200);
  });

  it('refuses unsafe keys', async () => {
    await expect(adapter().createPresignedDownload('../etc/passwd')).rejects.toThrow(
      /Unsafe object key/,
    );
  });
});
