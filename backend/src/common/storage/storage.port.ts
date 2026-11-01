import { uuidv7 } from 'uuidv7';

export interface PutObjectInput {
  key: string;
  body: Buffer | Uint8Array | string;
  contentType: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface StoredObject {
  key: string;
  body: Buffer;
  contentType: string;
  size: number;
  lastModified?: Date;
  metadata?: Record<string, string>;
}

export interface ObjectHead {
  key: string;
  contentType?: string;
  size: number;
  lastModified?: Date;
}

export interface PresignUploadInput {
  key: string;
  contentType: string;
  /** Declared size; S3 enforces it through Content-Length when provided. */
  sizeBytes?: number;
  expiresInSeconds?: number;
}

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  /** Headers the client must send with the PUT. */
  headers: Record<string, string>;
  key: string;
  expiresAt: Date;
}

export interface PresignedDownload {
  url: string;
  expiresAt: Date;
}

/**
 * Key prefixes of objects that may be served from the public/CDN base URL (tenant logos, promo,
 * event, reward and banner images, mall maps). Everything else, in particular `receipts/<userId>/`
 * photos, is private: only short-lived presigned links, never a permanent URL.
 */
export const PUBLIC_OBJECT_PREFIXES: readonly string[] = Object.freeze([
  'tenants/',
  'promos/',
  'events/',
  'rewards/',
  'banners/',
  'mall/',
]);

/** Upper bound of a presigned download link to a private object. */
export const MAX_PRIVATE_DOWNLOAD_TTL_SECONDS = 3_600;

/** True for safe keys under one of PUBLIC_OBJECT_PREFIXES. */
export function isPublicObjectKey(key: string): boolean {
  return isSafeObjectKey(key) && PUBLIC_OBJECT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Lifetime of a presigned download: private keys are capped at MAX_PRIVATE_DOWNLOAD_TTL_SECONDS. */
export function downloadTtlSeconds(key: string, requested: number): number {
  const ttl = Math.max(1, Math.floor(requested));
  return isPublicObjectKey(key) ? ttl : Math.min(ttl, MAX_PRIVATE_DOWNLOAD_TTL_SECONDS);
}

/** `${base}/${key}` without duplicate slashes. */
export function joinPublicUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`;
}

/**
 * Object storage port (brief section 1). Implementations: S3StorageAdapter, InMemoryStorageAdapter.
 * The abstract class doubles as the Nest injection token.
 *
 * Downloads: `createPresignedDownload` always signs a short-lived link (private keys at most
 * MAX_PRIVATE_DOWNLOAD_TTL_SECONDS), whatever S3_PUBLIC_BASE_URL says; `publicUrl` returns a
 * permanent URL only for PUBLIC_OBJECT_PREFIXES and null for everything else.
 */
export abstract class StoragePort {
  abstract putObject(input: PutObjectInput): Promise<void>;
  /** Throws PC_STORAGE_OBJECT_NOT_FOUND when missing. */
  abstract getObject(key: string): Promise<StoredObject>;
  abstract headObject(key: string): Promise<ObjectHead | null>;
  abstract deleteObject(key: string): Promise<void>;
  abstract createPresignedUpload(input: PresignUploadInput): Promise<PresignedUpload>;
  abstract createPresignedDownload(
    key: string,
    expiresInSeconds?: number,
  ): Promise<PresignedDownload>;
  /** Permanent URL of a public object (PUBLIC_OBJECT_PREFIXES); null for private keys. */
  abstract publicUrl(key: string): string | null;

  async exists(key: string): Promise<boolean> {
    return (await this.headObject(key)) !== null;
  }
}

const OBJECT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,511}$/;

/** Keys are relative paths without `..`, leading slashes or exotic characters. */
export function isSafeObjectKey(key: string): boolean {
  return (
    OBJECT_KEY_PATTERN.test(key) && !key.includes('..') && !key.includes('//') && !key.endsWith('/')
  );
}

export function assertSafeObjectKey(key: string): void {
  if (!isSafeObjectKey(key)) {
    throw new Error(`Unsafe object key: "${key}"`);
  }
}

/**
 * `buildObjectKey('receipts', 'jpg')` -> `receipts/2026/01/0194...-uuid.jpg`.
 * The month folder keeps buckets browsable; the UUID v7 keeps keys unguessable and sortable.
 */
export function buildObjectKey(prefix: string, extension?: string, now: Date = new Date()): string {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '');
  if (!/^[a-z0-9][a-z0-9/_-]*$/i.test(cleanPrefix)) {
    throw new Error(`Invalid object key prefix: "${prefix}"`);
  }
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const ext = extension ? `.${extension.replace(/^\.+/, '').toLowerCase()}` : '';
  const key = `${cleanPrefix}/${year}/${month}/${uuidv7()}${ext}`;
  assertSafeObjectKey(key);
  return key;
}

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

export function extensionForContentType(contentType: string): string | undefined {
  return EXTENSION_BY_CONTENT_TYPE[contentType.toLowerCase()];
}
