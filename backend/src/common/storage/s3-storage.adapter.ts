import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DomainError } from '../errors/domain-error';
import { CommonErrors } from '../errors/error-codes';
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

export interface S3StorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
  presignTtlSeconds: number;
  /**
   * Optional public/CDN base used by `publicUrl()` for PUBLIC_OBJECT_PREFIXES only. It never
   * replaces presigned links: private objects (receipt photos) stay signed and short-lived.
   */
  publicBaseUrl?: string;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

/** S3-compatible storage (AWS S3, MinIO, Cloudflare R2, ...). */
export class S3StorageAdapter extends StoragePort {
  private readonly client: S3Client;

  constructor(
    private readonly options: S3StorageOptions,
    client?: S3Client,
  ) {
    super();
    const config: S3ClientConfig = {
      region: options.region,
      forcePathStyle: options.forcePathStyle,
    };
    if (options.endpoint) {
      config.endpoint = options.endpoint;
    }
    if (options.accessKeyId && options.secretAccessKey) {
      config.credentials = {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      };
    }
    this.client = client ?? new S3Client(config);
  }

  async putObject(input: PutObjectInput): Promise<void> {
    assertSafeObjectKey(input.key);
    await this.wrap(() =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          CacheControl: input.cacheControl,
          Metadata: input.metadata,
        }),
      ),
    );
  }

  async getObject(key: string): Promise<StoredObject> {
    const response = await this.wrap(
      () => this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key })),
      key,
    );
    const bytes = response.Body ? await response.Body.transformToByteArray() : new Uint8Array();
    const stored: StoredObject = {
      key,
      body: Buffer.from(bytes),
      contentType: response.ContentType ?? 'application/octet-stream',
      size: response.ContentLength ?? bytes.byteLength,
    };
    if (response.LastModified) {
      stored.lastModified = response.LastModified;
    }
    if (response.Metadata) {
      stored.metadata = response.Metadata;
    }
    return stored;
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      const head: ObjectHead = { key, size: response.ContentLength ?? 0 };
      if (response.ContentType) {
        head.contentType = response.ContentType;
      }
      if (response.LastModified) {
        head.lastModified = response.LastModified;
      }
      return head;
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw this.unavailable(error);
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.wrap(() =>
      this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key })),
    );
  }

  async createPresignedUpload(input: PresignUploadInput): Promise<PresignedUpload> {
    assertSafeObjectKey(input.key);
    const expiresIn = input.expiresInSeconds ?? this.options.presignTtlSeconds;
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.sizeBytes,
    });
    const url = await this.wrap(() => getSignedUrl(this.client, command, { expiresIn }));
    const headers: Record<string, string> = { 'Content-Type': input.contentType };
    if (input.sizeBytes !== undefined) {
      headers['Content-Length'] = String(input.sizeBytes);
    }
    return {
      url,
      method: 'PUT',
      headers,
      key: input.key,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  /**
   * Always a presigned GET: S3_PUBLIC_BASE_URL is not used here (it used to turn every key,
   * receipt photos included, into a permanent public link). Private keys are capped at
   * MAX_PRIVATE_DOWNLOAD_TTL_SECONDS.
   */
  async createPresignedDownload(
    key: string,
    expiresInSeconds?: number,
  ): Promise<PresignedDownload> {
    assertSafeObjectKey(key);
    const expiresIn = downloadTtlSeconds(key, expiresInSeconds ?? this.options.presignTtlSeconds);
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const command = new GetObjectCommand({ Bucket: this.options.bucket, Key: key });
    const url = await this.wrap(() => getSignedUrl(this.client, command, { expiresIn }));
    return { url, expiresAt };
  }

  publicUrl(key: string): string | null {
    if (!this.options.publicBaseUrl || !isPublicObjectKey(key)) {
      return null;
    }
    return joinPublicUrl(this.options.publicBaseUrl, key);
  }

  private async wrap<T>(operation: () => Promise<T>, key?: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (key !== undefined && isNotFound(error)) {
        throw new DomainError(
          CommonErrors.PC_STORAGE_OBJECT_NOT_FOUND,
          `Object "${key}" not found`,
          {
            cause: error,
          },
        );
      }
      throw this.unavailable(error);
    }
  }

  private unavailable(error: unknown): DomainError {
    return new DomainError(CommonErrors.PC_STORAGE_UNAVAILABLE, 'Object storage request failed', {
      cause: error,
    });
  }
}
