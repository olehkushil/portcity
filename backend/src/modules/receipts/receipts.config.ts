import { z } from 'zod';

/** Injection token for the receipts slice of the environment (see README, section "Змінні середовища"). */
export const RECEIPTS_CONFIG = Symbol('RECEIPTS_CONFIG');

/** 5 MB (binary megabytes, as phones display file sizes). */
export const DEFAULT_RECEIPT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

export const receiptsEnvSchema = z.object({
  /** Upper bound for a receipt photo. */
  RECEIPTS_PHOTO_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(100_000)
    .max(DEFAULT_RECEIPT_PHOTO_MAX_BYTES)
    .default(DEFAULT_RECEIPT_PHOTO_MAX_BYTES),
  /** Lifetime of the presigned PUT returned by POST /receipts/photo-upload-url. */
  RECEIPTS_PHOTO_UPLOAD_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
  /**
   * Lifetime of presigned download links for receipt photos (member and admin detail views).
   * Receipt photos are private: the storage adapters also cap private links at one hour.
   */
  RECEIPTS_PHOTO_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  /** Receipts stuck in parsed/auto_approved/approved longer than this are re-queued by the sweep. */
  RECEIPTS_STUCK_AFTER_MINUTES: z.coerce.number().int().min(1).max(1_440).default(5),
  /**
   * Verification hold: auto-approved QR receipts of new accounts or above the fast-track total
   * are credited as pending for this many hours (0 switches the hold off).
   */
  RECEIPTS_VERIFY_HOLD_HOURS: z.coerce.number().int().min(0).max(720).default(24),
  /** Accounts younger than this many days get the verification hold on every QR receipt. */
  RECEIPTS_NEW_ACCOUNT_DAYS: z.coerce.number().int().min(0).max(365).default(30),
  /** QR receipts above this total (kopecks) get the verification hold on any account. */
  RECEIPTS_FAST_TRACK_MAX_KOPECKS: z.coerce.number().int().min(0).max(100_000_000).default(50_000),
  /** Points per member per Kyiv day from auto-approved QR receipts; beyond it -> moderation. */
  RECEIPTS_DAILY_POINTS_CAP: z.coerce.number().int().min(1).max(1_000_000).default(150),
});

export type ReceiptsConfig = z.output<typeof receiptsEnvSchema>;

export const DEFAULT_RECEIPTS_CONFIG: ReceiptsConfig = Object.freeze({
  RECEIPTS_PHOTO_MAX_BYTES: DEFAULT_RECEIPT_PHOTO_MAX_BYTES,
  RECEIPTS_PHOTO_UPLOAD_TTL_SECONDS: 600,
  RECEIPTS_PHOTO_URL_TTL_SECONDS: 900,
  RECEIPTS_STUCK_AFTER_MINUTES: 5,
  RECEIPTS_VERIFY_HOLD_HOURS: 24,
  RECEIPTS_NEW_ACCOUNT_DAYS: 30,
  RECEIPTS_FAST_TRACK_MAX_KOPECKS: 50_000,
  RECEIPTS_DAILY_POINTS_CAP: 150,
});

/** Photo content types accepted by POST /receipts/photo-upload-url (brief: jpeg, png, heic). */
export const RECEIPT_PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/heic'] as const;
export type ReceiptPhotoContentType = (typeof RECEIPT_PHOTO_CONTENT_TYPES)[number];

/** Object keys of receipt photos start with this prefix followed by the owner's user id. */
export const RECEIPT_PHOTO_KEY_PREFIX = 'receipts';
