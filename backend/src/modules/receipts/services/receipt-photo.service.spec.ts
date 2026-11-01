import { expectDomainError } from '../../../../test/receipts/support/assertions';
import { InMemoryStorageAdapter } from '../../../common/storage/in-memory-storage.adapter';
import { FakeClock } from '../../../common/time/clock';
import { DEFAULT_RECEIPTS_CONFIG } from '../receipts.config';
import { ReceiptPhotoService } from './receipt-photo.service';

const USER = '0192f3a0-1111-7000-8000-000000000001';
const OTHER = '0192f3a0-1111-7000-8000-000000000002';
const MAX = DEFAULT_RECEIPTS_CONFIG.RECEIPTS_PHOTO_MAX_BYTES;

describe('ReceiptPhotoService', () => {
  let clock: FakeClock;
  let storage: InMemoryStorageAdapter;
  let photos: ReceiptPhotoService;

  beforeEach(() => {
    clock = new FakeClock('2026-01-15T10:00:00.000Z');
    storage = new InMemoryStorageAdapter('memory', clock);
    photos = new ReceiptPhotoService(storage, clock, { ...DEFAULT_RECEIPTS_CONFIG });
  });

  it('issues a presigned PUT under the member folder', async () => {
    const upload = await photos.createUploadUrl(USER, {
      contentType: 'image/jpeg',
      sizeBytes: 245_000,
    });
    expect(upload).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '245000' },
      expiresAt: '2026-01-15T10:10:00.000Z',
      maxBytes: 5 * 1024 * 1024,
    });
    expect(upload.key).toMatch(new RegExp(`^receipts/${USER}/2026/01/[0-9a-f-]{36}\\.jpg$`));
    expect(upload.url).toContain(upload.key);
    expect(storage.pendingUploads.get(upload.key)).toMatchObject({ sizeBytes: 245_000 });
  });

  it.each([
    ['image/png', 'png'],
    ['image/heic', 'heic'],
    ['IMAGE/JPEG; charset=binary', 'jpg'],
  ])('accepts %s', async (contentType, extension) => {
    const upload = await photos.createUploadUrl(USER, { contentType, sizeBytes: 1_000 });
    expect(upload.key.endsWith(`.${extension}`)).toBe(true);
  });

  it.each(['image/webp', 'image/gif', 'application/pdf', ''])(
    'refuses content type "%s"',
    async (contentType) => {
      const error = await expectDomainError(
        photos.createUploadUrl(USER, { contentType, sizeBytes: 1_000 }),
        'PC_RECEIPT_PHOTO_INVALID',
        422,
      );
      expect(error.details).toMatchObject({ problem: 'content_type' });
      expect(error.message).toContain('JPEG, PNG або HEIC');
    },
  );

  it('refuses files above 5 MB and empty files', async () => {
    const big = await expectDomainError(
      photos.createUploadUrl(USER, { contentType: 'image/jpeg', sizeBytes: MAX + 1 }),
      'PC_RECEIPT_PHOTO_INVALID',
    );
    expect(big.details).toMatchObject({ problem: 'too_large', maxBytes: MAX });
    await expect(
      photos.createUploadUrl(USER, { contentType: 'image/jpeg', sizeBytes: MAX }),
    ).resolves.toMatchObject({ maxBytes: MAX });
    const empty = await expectDomainError(
      photos.createUploadUrl(USER, { contentType: 'image/jpeg', sizeBytes: 0 }),
      'PC_RECEIPT_PHOTO_INVALID',
    );
    expect(empty.details).toMatchObject({ problem: 'empty' });
  });

  it('accepts an uploaded photo of the member and refuses foreign or missing ones', async () => {
    const upload = await photos.createUploadUrl(USER, { contentType: 'image/png', sizeBytes: 10 });
    await expectDomainError(
      photos.assertUploaded(USER, upload.key),
      'PC_RECEIPT_PHOTO_REQUIRED',
      422,
    );

    await storage.simulateUpload(upload.key, Buffer.alloc(10, 7));
    await expect(photos.assertUploaded(USER, upload.key)).resolves.toBeUndefined();

    const foreign = await expectDomainError(
      photos.assertUploaded(OTHER, upload.key),
      'PC_RECEIPT_PHOTO_INVALID',
    );
    expect(foreign.details).toMatchObject({ problem: 'foreign_key' });
    await expectDomainError(
      photos.assertUploaded(USER, `receipts/${USER}/../${OTHER}/x.jpg`),
      'PC_RECEIPT_PHOTO_INVALID',
    );
  });

  it('checks the stored object: size and content type as uploaded', async () => {
    const key = `receipts/${USER}/2026/01/huge.jpg`;
    await storage.putObject({ key, body: Buffer.alloc(MAX + 1), contentType: 'image/jpeg' });
    const tooLarge = await expectDomainError(
      photos.assertUploaded(USER, key),
      'PC_RECEIPT_PHOTO_INVALID',
    );
    expect(tooLarge.details).toMatchObject({ problem: 'too_large' });

    const gif = `receipts/${USER}/2026/01/anim.jpg`;
    await storage.putObject({ key: gif, body: Buffer.alloc(10), contentType: 'image/gif' });
    const wrongType = await expectDomainError(
      photos.assertUploaded(USER, gif),
      'PC_RECEIPT_PHOTO_INVALID',
    );
    expect(wrongType.details).toMatchObject({ problem: 'content_type' });
  });

  it('signs download links and degrades to null', async () => {
    await expect(photos.signedUrl(null)).resolves.toBeNull();
    await expect(photos.signedUrl(`receipts/${USER}/a.jpg`)).resolves.toMatch(
      /^memory:\/\/memory\/receipts\/.+expires=\d+$/,
    );
    jest.spyOn(storage, 'createPresignedDownload').mockRejectedValueOnce(new Error('s3 down'));
    await expect(photos.signedUrl(`receipts/${USER}/a.jpg`)).resolves.toBeNull();
  });
});
