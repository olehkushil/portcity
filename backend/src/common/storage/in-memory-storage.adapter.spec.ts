import { DomainError } from '../errors/domain-error';
import { FakeClock } from '../time/clock';
import { InMemoryStorageAdapter } from './in-memory-storage.adapter';
import {
  MAX_PRIVATE_DOWNLOAD_TTL_SECONDS,
  buildObjectKey,
  downloadTtlSeconds,
  extensionForContentType,
  isPublicObjectKey,
  isSafeObjectKey,
} from './storage.port';

describe('InMemoryStorageAdapter', () => {
  let clock: FakeClock;
  let storage: InMemoryStorageAdapter;

  beforeEach(() => {
    clock = new FakeClock('2026-02-01T12:00:00Z');
    storage = new InMemoryStorageAdapter('test-bucket', clock, 300);
  });

  it('stores, reads, heads and deletes objects', async () => {
    await storage.putObject({
      key: 'receipts/a.jpg',
      body: Buffer.from('abc'),
      contentType: 'image/jpeg',
    });
    expect(await storage.exists('receipts/a.jpg')).toBe(true);

    const stored = await storage.getObject('receipts/a.jpg');
    expect(stored.body.toString()).toBe('abc');
    expect(stored.contentType).toBe('image/jpeg');
    expect(stored.size).toBe(3);
    expect(stored.lastModified?.toISOString()).toBe('2026-02-01T12:00:00.000Z');

    expect(await storage.headObject('receipts/a.jpg')).toMatchObject({
      size: 3,
      contentType: 'image/jpeg',
    });
    await storage.deleteObject('receipts/a.jpg');
    expect(await storage.headObject('receipts/a.jpg')).toBeNull();
    await expect(storage.getObject('receipts/a.jpg')).rejects.toBeInstanceOf(DomainError);
  });

  it('creates presigned uploads and completes them', async () => {
    const presigned = await storage.createPresignedUpload({
      key: 'receipts/b.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1024,
    });
    expect(presigned.method).toBe('PUT');
    expect(presigned.url).toBe('memory://test-bucket/receipts/b.jpg?expires=1769947500000');
    expect(presigned.headers).toEqual({ 'Content-Type': 'image/jpeg', 'Content-Length': '1024' });
    expect(presigned.expiresAt.toISOString()).toBe('2026-02-01T12:05:00.000Z');
    expect(storage.pendingUploads.has('receipts/b.jpg')).toBe(true);

    await storage.simulateUpload('receipts/b.jpg', 'payload');
    expect(storage.pendingUploads.has('receipts/b.jpg')).toBe(false);
    expect((await storage.getObject('receipts/b.jpg')).contentType).toBe('image/jpeg');

    const download = await storage.createPresignedDownload('receipts/b.jpg', 60);
    expect(download.expiresAt.toISOString()).toBe('2026-02-01T12:01:00.000Z');
    expect(storage.keys()).toEqual(['receipts/b.jpg']);
  });

  it('rejects unsafe keys', async () => {
    await expect(
      storage.putObject({ key: '../etc/passwd', body: 'x', contentType: 'text/plain' }),
    ).rejects.toThrow(/Unsafe object key/);
    expect(isSafeObjectKey('/abs')).toBe(false);
    expect(isSafeObjectKey('a//b')).toBe(false);
    expect(isSafeObjectKey('dir/')).toBe(false);
    expect(isSafeObjectKey('receipts/2026/01/file.jpg')).toBe(true);
  });

  it('caps presigned links to private objects and never makes them public', async () => {
    const receipt = await storage.createPresignedDownload('receipts/user-1/2026/01/a.jpg', 86_400);
    expect(receipt.expiresAt.toISOString()).toBe('2026-02-01T13:00:00.000Z');
    expect(storage.publicUrl('receipts/user-1/2026/01/a.jpg')).toBeNull();
    expect(storage.publicUrl('exports/user-1.json')).toBeNull();

    const logo = await storage.createPresignedDownload('tenants/2026/01/logo.png', 86_400);
    expect(logo.expiresAt.toISOString()).toBe('2026-02-02T12:00:00.000Z');
    expect(storage.publicUrl('tenants/2026/01/logo.png')).toBe(
      'memory://test-bucket/tenants/2026/01/logo.png',
    );
    await expect(storage.createPresignedDownload('../secret', 60)).rejects.toThrow(
      /Unsafe object key/,
    );
  });

  it('serves public prefixes from the configured public base URL', () => {
    const cdn = new InMemoryStorageAdapter('b', clock, 300, 'https://cdn.example/media/');
    for (const prefix of ['tenants', 'promos', 'events', 'rewards', 'banners', 'mall']) {
      expect(cdn.publicUrl(`${prefix}/2026/01/x.png`)).toBe(
        `https://cdn.example/media/${prefix}/2026/01/x.png`,
      );
    }
    expect(cdn.publicUrl('receipts/u/2026/01/x.jpg')).toBeNull();
    expect(cdn.publicUrl('tenantsx/1.png')).toBeNull();
    expect(cdn.publicUrl('tenants/../receipts/x.jpg')).toBeNull();
  });

  it('classifies keys and download lifetimes', () => {
    expect(isPublicObjectKey('mall/floor-1.png')).toBe(true);
    expect(isPublicObjectKey('receipts/u/a.jpg')).toBe(false);
    expect(isPublicObjectKey('/tenants/a.png')).toBe(false);
    expect(downloadTtlSeconds('receipts/u/a.jpg', 999_999)).toBe(MAX_PRIVATE_DOWNLOAD_TTL_SECONDS);
    expect(downloadTtlSeconds('receipts/u/a.jpg', 900)).toBe(900);
    expect(downloadTtlSeconds('promos/a.jpg', 999_999)).toBe(999_999);
  });

  it('builds month-partitioned keys', () => {
    const key = buildObjectKey('receipts', 'JPG', new Date('2026-03-05T00:00:00Z'));
    expect(key).toMatch(/^receipts\/2026\/03\/[0-9a-f-]{36}\.jpg$/);
    expect(buildObjectKey('/photos/', undefined, new Date('2026-12-31T23:59:59Z'))).toMatch(
      /^photos\/2026\/12\/[0-9a-f-]{36}$/,
    );
    expect(() => buildObjectKey('../x')).toThrow();
    expect(extensionForContentType('image/jpeg')).toBe('jpg');
    expect(extensionForContentType('application/zip')).toBeUndefined();
  });
});
