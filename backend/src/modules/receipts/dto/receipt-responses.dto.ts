import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ACTOR_TYPES, type ActorType } from '../../../common/contracts/shared';
import {
  RECEIPT_ERROR_CODES,
  RECEIPT_SOURCES,
  RECEIPT_STATUSES,
  RISK_FLAGS,
  type ReceiptErrorCode,
  type ReceiptSource,
  type ReceiptStatus,
  type ReceiptSubmissionOutcome,
  type RiskFlag,
} from '../../../common/contracts/receipts';
import { MODERATION_REASONS, type ModerationReason } from '../domain/rules';
import { SUBMISSION_SCREENS, type SubmissionScreen } from '../domain/submission-view';

/** Values of Receipt.verification (prisma enum ReceiptVerification). */
export const RECEIPT_VERIFICATIONS = [
  'not_required',
  'pending',
  'confirmed',
  'rejected',
  'unconfirmed',
] as const;
export type ReceiptVerificationValue = (typeof RECEIPT_VERIFICATIONS)[number];

export const SUBMISSION_OUTCOMES = [
  'credited',
  'held',
  'needs_moderation',
  'rejected',
  'processing',
] as const satisfies readonly ReceiptSubmissionOutcome[];

export class ReceiptTenantDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'intertop' })
  slug: string;

  @ApiProperty({ example: 'INTERTOP' })
  name: string;
}

export class ReceiptPointsDto {
  @ApiProperty({ description: 'Points awarded for the receipt', example: 180 })
  awarded: number;

  @ApiProperty({ enum: ['pending', 'available', 'spent', 'expired', 'cancelled'] })
  state: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  availableAt: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  expiresAt: string | null;
}

export class ReceiptDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: RECEIPT_STATUSES })
  status: ReceiptStatus;

  @ApiProperty({ enum: RECEIPT_SOURCES })
  source: ReceiptSource;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '4000100011',
    description:
      'Canonical cash register number; null for a manual receipt sent without it (the moderator fills it in)',
  })
  fn: string | null;

  @ApiProperty({
    example: '1180000001',
    description: 'Canonical receipt number (upper case, no spaces or dashes, no leading zeros)',
  })
  fiscalId: string;

  @ApiProperty({ type: String, format: 'date-time' })
  issuedAt: string;

  @ApiProperty({ example: 600000 })
  totalKopecks: number;

  @ApiPropertyOptional({ type: ReceiptTenantDto, nullable: true })
  tenant: ReceiptTenantDto | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 180 })
  pointsAwarded: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 36,
    description:
      'Points the receipt would earn by the program formula while it waits for a moderator or is being processed ("очікувано +N"); null once decided. An estimate: daily caps and the moderator decision may change it.',
  })
  expectedPoints: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Reason of a rejection, shown to the member',
  })
  decisionReason: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  decidedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  submittedAt: string;

  @ApiProperty({ description: 'True when the member may still file an appeal' })
  canAppeal: boolean;
}

export class ReceiptEventDto {
  @ApiPropertyOptional({ enum: RECEIPT_STATUSES, nullable: true })
  fromStatus: ReceiptStatus | null;

  @ApiProperty({ enum: RECEIPT_STATUSES })
  toStatus: ReceiptStatus;

  @ApiProperty({ enum: ACTOR_TYPES })
  actorType: ActorType;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
}

export class ReceiptAppealDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  message: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  resolvedAt: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  resolution: string | null;
}

export class ReceiptDetailDto extends ReceiptDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Short-lived download link of the photo',
  })
  photoUrl: string | null;

  @ApiProperty({
    type: [String],
    description: 'Why the receipt is waiting for a moderator ("Причина перевірки"), Ukrainian',
    example: ['Сума понад 1 000 ₴'],
  })
  moderationReasons: string[];

  @ApiPropertyOptional({
    enum: RECEIPT_ERROR_CODES,
    nullable: true,
    description: 'Rule that rejected the receipt',
  })
  rejectionCode: ReceiptErrorCode | null;

  @ApiPropertyOptional({ type: ReceiptPointsDto, nullable: true })
  points: ReceiptPointsDto | null;

  @ApiProperty({ type: [ReceiptEventDto] })
  events: ReceiptEventDto[];

  @ApiProperty({ type: [ReceiptAppealDto] })
  appeals: ReceiptAppealDto[];
}

export class ReceiptBalanceDto {
  @ApiProperty({ description: 'Points available now', example: 240 })
  available: number;

  @ApiProperty({ description: 'Points on hold', example: 65 })
  pending: number;
}

export class ReceiptSubmissionResultDto {
  @ApiProperty({ type: ReceiptDto })
  receipt: ReceiptDto;

  @ApiProperty({
    enum: SUBMISSION_OUTCOMES,
    description:
      'credited / held (points pending until pointsAvailableAt) / needs_moderation / rejected / processing (approved, the credit is still running in the receipts-process job; pending screen)',
  })
  outcome: ReceiptSubmissionOutcome;

  @ApiProperty({
    enum: SUBMISSION_SCREENS,
    description: 'Prototype result screen to open: scan-result, scan-pending or scan-rejected',
  })
  screen: SubmissionScreen;

  @ApiProperty({ description: 'Screen title (Ukrainian)', example: 'Чек зараховано' })
  title: string;

  @ApiProperty({
    description: 'Text under the title (Ukrainian); for rejections it carries the reason',
    example: 'Нараховано +120 балів. Бали вже можна обміняти на винагороди.',
  })
  message: string;

  @ApiPropertyOptional({ type: Number, nullable: true })
  pointsAwarded: number | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Set when the points are held (outcome "held")',
  })
  pointsAvailableAt: string | null;

  @ApiPropertyOptional({ enum: RECEIPT_ERROR_CODES, nullable: true })
  rejectionCode: ReceiptErrorCode | null;

  @ApiProperty({
    type: [String],
    description: '"Причина перевірки" lines for the pending screen (Ukrainian)',
    example: ['Сума понад 1 000 ₴'],
  })
  moderationReasons: string[];

  @ApiPropertyOptional({
    type: ReceiptBalanceDto,
    nullable: true,
    description: 'Balance after the credit (credited screen); null when unavailable',
  })
  balance: ReceiptBalanceDto | null;
}

export class ReceiptPageDto {
  @ApiProperty({ type: [ReceiptDto] })
  items: ReceiptDto[];

  @ApiPropertyOptional({ type: String, nullable: true })
  nextCursor: string | null;
}

export class PhotoUploadUrlDto {
  @ApiProperty({ description: 'Presigned URL for a single PUT' })
  url: string;

  @ApiProperty({ enum: ['PUT'] })
  method: 'PUT';

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Headers to send with the PUT',
  })
  headers: Record<string, string>;

  @ApiProperty({ description: 'Object key to pass as photoKey when submitting' })
  key: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: string;

  @ApiProperty({ description: 'Maximum accepted photo size in bytes' })
  maxBytes: number;
}

export class AdminReceiptEventDto extends ReceiptEventDto {
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  actorId: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  note: string | null;
}

export class AdminReceiptAppealDto extends ReceiptAppealDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  photoUrl: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  resolvedById: string | null;
}

export class AdminReceiptDto extends ReceiptDto {
  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  deviceId: string | null;

  @ApiProperty({ enum: RISK_FLAGS, isArray: true })
  riskFlags: RiskFlag[];

  @ApiProperty({ minimum: 0, maximum: 100 })
  riskScore: number;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  moderatorId: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  pointsTxId: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  photoKey: string | null;

  @ApiProperty({
    enum: MODERATION_REASONS,
    isArray: true,
    description: 'Why the rules sent the receipt to moderation (kept after the decision)',
  })
  moderationReasons: ModerationReason[];

  @ApiPropertyOptional({
    enum: RECEIPT_ERROR_CODES,
    nullable: true,
    description: 'Rule that rejected the receipt; null for moderator rejections',
  })
  rejectionCode: ReceiptErrorCode | null;

  @ApiProperty({
    enum: RECEIPT_VERIFICATIONS,
    description:
      'Tax-service check: not_required, pending (points held until verifyUntil), confirmed, rejected, unconfirmed',
  })
  verification: ReceiptVerificationValue;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  verifyUntil: string | null;
}

export class AdminReceiptDetailDto extends AdminReceiptDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'QR text exactly as scanned (audit)',
  })
  rawQr: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Cash register number as submitted, before canonicalisation',
  })
  fnRaw: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Receipt number as submitted, before canonicalisation',
  })
  fiscalIdRaw: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  photoUrl: string | null;

  @ApiProperty({ type: [AdminReceiptEventDto] })
  events: AdminReceiptEventDto[];

  @ApiProperty({ type: [AdminReceiptAppealDto] })
  appeals: AdminReceiptAppealDto[];
}

export class AdminReceiptPageDto {
  @ApiProperty({ type: [AdminReceiptDto] })
  items: AdminReceiptDto[];

  @ApiPropertyOptional({ type: String, nullable: true })
  nextCursor: string | null;
}
