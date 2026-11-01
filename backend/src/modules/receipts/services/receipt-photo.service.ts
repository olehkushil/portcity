import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../../../common/errors/domain-error';
import { StoragePort } from '../../../common/storage/storage.port';
import { Clock } from '../../../common/time/clock';
import { ReceiptErrors } from '../domain/errors';
import {
  PHOTO_PROBLEM_MESSAGES_UK,
  type PhotoProblem,
  buildReceiptPhotoKey,
  checkPhotoUpload,
  checkStoredPhoto,
  isOwnPhotoKey,
  normalizeContentType,
} from '../domain/photo';
import { PHOTO_REQUIRED_MESSAGE_UK } from '../domain/submission-view';
import type { PhotoUploadUrlDto } from '../dto/receipt-responses.dto';
import {
  RECEIPTS_CONFIG,
  type ReceiptPhotoContentType,
  type ReceiptsConfig,
} from '../receipts.config';

export interface PhotoUploadRequest {
  contentType: string;
  sizeBytes: number;
}

function photoInvalid(problem: PhotoProblem, details: Record<string, unknown> = {}): DomainError {
  return new DomainError(
    ReceiptErrors.PC_RECEIPT_PHOTO_INVALID,
    PHOTO_PROBLEM_MESSAGES_UK[problem],
    {
      details: { problem, ...details },
    },
  );
}

/**
 * Receipt photos through StoragePort: presigned PUT scoped to the member's folder, validation of
 * an uploaded object before it is attached, and short-lived signed download links.
 */
@Injectable()
export class ReceiptPhotoService {
  private readonly logger = new Logger(ReceiptPhotoService.name);

  constructor(
    private readonly storage: StoragePort,
    private readonly clock: Clock,
    @Inject(RECEIPTS_CONFIG) private readonly config: ReceiptsConfig,
  ) {}

  get maxBytes(): number {
    return this.config.RECEIPTS_PHOTO_MAX_BYTES;
  }

  async createUploadUrl(userId: string, request: PhotoUploadRequest): Promise<PhotoUploadUrlDto> {
    const contentType = normalizeContentType(request.contentType);
    const problem = checkPhotoUpload(contentType, request.sizeBytes, this.maxBytes);
    if (problem) {
      throw photoInvalid(problem, {
        contentType: request.contentType,
        sizeBytes: request.sizeBytes,
        maxBytes: this.maxBytes,
      });
    }
    const key = buildReceiptPhotoKey(
      userId,
      contentType as ReceiptPhotoContentType,
      this.clock.now(),
    );
    const upload = await this.storage.createPresignedUpload({
      key,
      contentType,
      sizeBytes: request.sizeBytes,
      expiresInSeconds: this.config.RECEIPTS_PHOTO_UPLOAD_TTL_SECONDS,
    });
    return {
      url: upload.url,
      method: upload.method,
      headers: upload.headers,
      key: upload.key,
      expiresAt: upload.expiresAt.toISOString(),
      maxBytes: this.maxBytes,
    };
  }

  /**
   * Throws PC_RECEIPT_PHOTO_INVALID for a key outside the member's folder or a bad object and
   * PC_RECEIPT_PHOTO_REQUIRED when nothing was uploaded under the key.
   */
  async assertUploaded(userId: string, key: string): Promise<void> {
    if (!isOwnPhotoKey(key, userId)) {
      throw photoInvalid('foreign_key');
    }
    const head = await this.storage.headObject(key);
    if (!head) {
      throw new DomainError(ReceiptErrors.PC_RECEIPT_PHOTO_REQUIRED, PHOTO_REQUIRED_MESSAGE_UK, {
        details: { photoKey: key },
      });
    }
    const problem = checkStoredPhoto(head, this.maxBytes);
    if (problem) {
      throw photoInvalid(problem, { size: head.size, contentType: head.contentType ?? null });
    }
  }

  /** Signed GET link or null (no photo, or storage unavailable: the view degrades gracefully). */
  async signedUrl(key: string | null | undefined): Promise<string | null> {
    if (!key) {
      return null;
    }
    try {
      const download = await this.storage.createPresignedDownload(
        key,
        this.config.RECEIPTS_PHOTO_URL_TTL_SECONDS,
      );
      return download.url;
    } catch (error) {
      this.logger.warn(
        `Could not sign photo ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
