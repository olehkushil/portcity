import { DomainError } from '../errors/domain-error';
import { CommonErrors } from '../errors/error-codes';
import { Clock, SystemClock } from '../time/clock';
import {
  type ObjectHead,
  type PresignUploadInput,
  type PresignedDownload,
  type PresignedUpload,
  type PutObjectInput,
  StoragePort,
  type StoredObject,
  assertSafeObjectKey,
  downloadTtlSeconds,
  isPublicObjectKey,
  joinPublicUrl,
} from './storage.port';

interface MemoryEntry {
  body: Buffer;
  contentType: string;
  lastModified: Date;
  metadata?: Record<string, string>;
}

/**
 * Process-local fake for tests and local development without S3.
 * Presigned URLs use the `memory://` scheme; tests complete uploads with `simulateUpload()`.
 * Same download policy as S3: private keys get capped presigned links, `publicUrl()` answers only
 * for PUBLIC_OBJECT_PREFIXES (with `publicBaseUrl` when given, `memory://<bucket>` otherwise).
 */
export class InMemoryStorageAdapter extends StoragePort {
  private readonly objects = new Map<string, MemoryEntry>();
  readonly pendingUploads = new Map<string, PresignUploadInput>();

  constructor(
    private readonly bucket = 'memory',
    private readonly clock: Clock = new SystemClock(),
    private readonly defaultTtlSeconds = 600,
    private readonly publicBaseUrl?: string,
  ) {
    super();
  }

  async putObject(input: PutObjectInput): Promise<void> {
    assertSafeObjectKey(input.key);
    const body = Buffer.isBuffer(input.body) ? Buffer.from(input.body) : Buffer.from(input.body);
    const entry: MemoryEntry = {
      body,
      contentType: input.contentType,
      lastModified: this.clock.now(),
    };
    if (input.metadata) {
      entry.metadata = { ...input.metadata };
    }
    this.objects.set(input.key, entry);
    this.pendingUploads.delete(input.key);
  }

  async getObject(key: string): Promise<StoredObject> {
    const entry = this.objects.get(key);
    if (!entry) {
      throw new DomainError(CommonErrors.PC_STORAGE_OBJECT_NOT_FOUND, `Object "${key}" not found`);
    }
    const stored: StoredObject = {
      key,
      body: Buffer.from(entry.body),
      contentType: entry.contentType,
      size: entry.body.length,
      lastModified: entry.lastModified,
    };
    if (entry.metadata) {
      stored.metadata = { ...entry.metadata };
    }
    return stored;
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    const entry = this.objects.get(key);
    return entry
      ? {
          key,
          contentType: entry.contentType,
          size: entry.body.length,
          lastModified: entry.lastModified,
        }
      : null;
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async createPresignedUpload(input: PresignUploadInput): Promise<PresignedUpload> {
    assertSafeObjectKey(input.key);
    const ttl = input.expiresInSeconds ?? this.defaultTtlSeconds;
    const expiresAt = new Date(this.clock.nowMs() + ttl * 1000);
    this.pendingUploads.set(input.key, input);
    const headers: Record<string, string> = { 'Content-Type': input.contentType };
    if (input.sizeBytes !== undefined) {
      headers['Content-Length'] = String(input.sizeBytes);
    }
    return {
      url: `memory://${this.bucket}/${input.key}?expires=${expiresAt.getTime()}`,
      method: 'PUT',
      headers,
      key: input.key,
      expiresAt,
    };
  }

  async createPresignedDownload(
    key: string,
    expiresInSeconds?: number,
  ): Promise<PresignedDownload> {
    assertSafeObjectKey(key);
    const ttl = downloadTtlSeconds(key, expiresInSeconds ?? this.defaultTtlSeconds);
    const expiresAt = new Date(this.clock.nowMs() + ttl * 1000);
    return { url: `memory://${this.bucket}/${key}?expires=${expiresAt.getTime()}`, expiresAt };
  }

  publicUrl(key: string): string | null {
    if (!isPublicObjectKey(key)) {
      return null;
    }
    return joinPublicUrl(this.publicBaseUrl ?? `memory://${this.bucket}`, key);
  }

  /** Test helper: emulates the client PUT that follows `createPresignedUpload`. */
  async simulateUpload(key: string, body: Buffer | string, contentType?: string): Promise<void> {
    const pending = this.pendingUploads.get(key);
    await this.putObject({
      key,
      body,
      contentType: contentType ?? pending?.contentType ?? 'application/octet-stream',
    });
  }

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  clear(): void {
    this.objects.clear();
    this.pendingUploads.clear();
  }
}
