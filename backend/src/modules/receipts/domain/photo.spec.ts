import {
  buildReceiptPhotoKey,
  checkPhotoUpload,
  checkStoredPhoto,
  isAllowedPhotoContentType,
  isOwnPhotoKey,
  normalizeContentType,
  photoKeyPrefixFor,
} from './photo';

const USER = '0192f3a0-1111-7000-8000-000000000001';
const MAX = 5 * 1024 * 1024;

describe('receipt photo rules', () => {
  it.each([
    ['image/jpeg', true],
    ['image/png', true],
    ['image/heic', true],
    ['Image/JPEG; q=1', true],
    ['image/webp', false],
    ['image/gif', false],
    ['application/pdf', false],
    ['', false],
    [null, false],
  ])('content type %p allowed: %p', (contentType, expected) => {
    expect(isAllowedPhotoContentType(contentType)).toBe(expected);
  });

  it('normalises content types', () => {
    expect(normalizeContentType(' IMAGE/PNG ; charset=x')).toBe('image/png');
    expect(normalizeContentType(undefined)).toBe('');
  });

  it.each([
    ['image/jpeg', 1, null],
    ['image/jpeg', MAX, null],
    ['image/jpeg', MAX + 1, 'too_large'],
    ['image/jpeg', 0, 'empty'],
    ['image/jpeg', 1.5, 'empty'],
    ['image/webp', 100, 'content_type'],
  ] as const)('upload %s of %d bytes -> %p', (contentType, size, expected) => {
    expect(checkPhotoUpload(contentType, size, MAX)).toBe(expected);
  });

  it('builds keys inside the member folder with the right extension', () => {
    const now = new Date('2026-03-05T10:00:00.000Z');
    expect(buildReceiptPhotoKey(USER, 'image/jpeg', now)).toMatch(
      new RegExp(`^receipts/${USER}/2026/03/[0-9a-f-]{36}\\.jpg$`),
    );
    expect(buildReceiptPhotoKey(USER, 'image/heic', now).endsWith('.heic')).toBe(true);
    expect(buildReceiptPhotoKey(USER, 'image/png', now)).not.toBe(
      buildReceiptPhotoKey(USER, 'image/png', now),
    );
    expect(() => photoKeyPrefixFor('../etc')).toThrow('Invalid user id');
  });

  it.each([
    [`receipts/${USER}/2026/01/a.jpg`, true],
    [`receipts/${USER}/`, false],
    [`receipts/${USER}`, false],
    [`receipts/0192f3a0-1111-7000-8000-000000000002/2026/01/a.jpg`, false],
    [`receipts/${USER}/../other/a.jpg`, false],
    [`/receipts/${USER}/a.jpg`, false],
    [`promos/${USER}/a.jpg`, false],
  ])('key %s is own: %p', (key, expected) => {
    expect(isOwnPhotoKey(key, USER)).toBe(expected);
  });

  it('validates stored objects', () => {
    expect(checkStoredPhoto({ size: 10, contentType: 'image/jpeg' }, MAX)).toBeNull();
    expect(checkStoredPhoto({ size: 10 }, MAX)).toBeNull();
    expect(checkStoredPhoto({ size: 0, contentType: 'image/jpeg' }, MAX)).toBe('empty');
    expect(checkStoredPhoto({ size: MAX + 1, contentType: 'image/jpeg' }, MAX)).toBe('too_large');
    expect(checkStoredPhoto({ size: 10, contentType: 'text/html' }, MAX)).toBe('content_type');
  });
});
