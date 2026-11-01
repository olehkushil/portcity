/**
 * Receipt photo rules (manual submissions and appeals). Pure module: no Nest, no storage calls.
 *
 * Keys are scoped to the owner: `receipts/<userId>/<yyyy>/<mm>/<uuidv7>.<ext>`, so a member can
 * only attach photos uploaded through their own presigned URL.
 */
import { uuidv7 } from 'uuidv7';
import { isSafeObjectKey } from '../../../common/storage/storage.port';
import {
  RECEIPT_PHOTO_CONTENT_TYPES,
  RECEIPT_PHOTO_KEY_PREFIX,
  type ReceiptPhotoContentType,
} from '../receipts.config';

const EXTENSIONS: Readonly<Record<ReceiptPhotoContentType, string>> = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
});

const USER_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export type PhotoProblem = 'content_type' | 'too_large' | 'empty' | 'foreign_key' | 'bad_key';

export const PHOTO_PROBLEM_MESSAGES_UK: Readonly<Record<PhotoProblem, string>> = Object.freeze({
  content_type: 'Підтримуються лише фото у форматах JPEG, PNG або HEIC',
  too_large: 'Фото завелике: максимум 5 МБ',
  empty: 'Файл фото порожній',
  foreign_key: 'Фото завантажено не з вашого облікового запису',
  bad_key: 'Некоректний ключ фото',
});

export function normalizeContentType(contentType: string | undefined | null): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

export function isAllowedPhotoContentType(
  contentType: string | undefined | null,
): contentType is ReceiptPhotoContentType {
  return (RECEIPT_PHOTO_CONTENT_TYPES as readonly string[]).includes(
    normalizeContentType(contentType),
  );
}

/** Checks a declared upload (content type and size) before a presigned URL is issued. */
export function checkPhotoUpload(
  contentType: string,
  sizeBytes: number,
  maxBytes: number,
): PhotoProblem | null {
  if (!isAllowedPhotoContentType(contentType)) {
    return 'content_type';
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return 'empty';
  }
  if (sizeBytes > maxBytes) {
    return 'too_large';
  }
  return null;
}

/** Folder that holds every photo of one member: `receipts/<userId>/`. */
export function photoKeyPrefixFor(userId: string): string {
  if (!USER_ID_PATTERN.test(userId)) {
    throw new Error(`Invalid user id for a photo key: "${userId}"`);
  }
  return `${RECEIPT_PHOTO_KEY_PREFIX}/${userId}/`;
}

/** `receipts/<userId>/2026/01/<uuidv7>.jpg` */
export function buildReceiptPhotoKey(
  userId: string,
  contentType: ReceiptPhotoContentType,
  now: Date,
): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const key = `${photoKeyPrefixFor(userId)}${year}/${month}/${uuidv7()}.${EXTENSIONS[contentType]}`;
  if (!isSafeObjectKey(key)) {
    throw new Error(`Generated an unsafe photo key: "${key}"`);
  }
  return key;
}

/** True when the key is a safe object key inside the member's own photo folder. */
export function isOwnPhotoKey(key: string, userId: string): boolean {
  if (!isSafeObjectKey(key) || !USER_ID_PATTERN.test(userId)) {
    return false;
  }
  return key.startsWith(photoKeyPrefixFor(userId)) && key.length > photoKeyPrefixFor(userId).length;
}

/** Validates a stored object (HEAD result) before it is attached to a receipt or an appeal. */
export function checkStoredPhoto(
  head: { size: number; contentType?: string | undefined },
  maxBytes: number,
): PhotoProblem | null {
  if (head.size <= 0) {
    return 'empty';
  }
  if (head.size > maxBytes) {
    return 'too_large';
  }
  if (head.contentType !== undefined && !isAllowedPhotoContentType(head.contentType)) {
    return 'content_type';
  }
  return null;
}
