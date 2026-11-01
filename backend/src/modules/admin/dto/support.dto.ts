import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import {
  SUPPORT_RELATED_TYPES,
  SUPPORT_REQUEST_STATUSES,
  SUPPORT_REQUEST_TOPICS,
  type SupportRelatedType,
  type SupportRequestStatus,
  type SupportRequestTopic,
} from '../../../common/contracts/admin';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import { SUPPORT_PHOTO_CONTENT_TYPES, SUPPORT_PHOTO_MAX_BYTES } from '../domain/support-rules';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateSupportRequestDto {
  @ApiProperty({ enum: SUPPORT_REQUEST_TOPICS, example: 'parking' })
  @IsIn(SUPPORT_REQUEST_TOPICS)
  topic: SupportRequestTopic;

  @ApiPropertyOptional({
    enum: SUPPORT_RELATED_TYPES,
    description: 'What the request is about (receipt, parking session, voucher, ...)',
  })
  @IsOptional()
  @IsIn(SUPPORT_RELATED_TYPES)
  relatedType?: SupportRelatedType;

  @ApiPropertyOptional({ format: 'uuid', description: 'Id of the related object' })
  @IsOptional()
  @IsUUID('all')
  relatedId?: string;

  @ApiProperty({
    minLength: 5,
    maxLength: 2000,
    example: 'Оплатив паркінг у застосунку, але шлагбаум не відкрився',
  })
  @Transform(trim)
  @IsString()
  @Length(5, 2000)
  message: string;

  @ApiPropertyOptional({
    maxLength: 512,
    description: 'Key returned by POST /support/requests/photo-upload-url (after the PUT)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(/^support\/[A-Za-z0-9/_.-]+$/)
  photoKey?: string;
}

export class SupportRequestCreatedDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 1042,
    description: 'Human number for the toast "Звернення № 1042 прийнято"',
  })
  number: number;
}

export class SupportPhotoUploadRequestDto {
  @ApiProperty({ enum: SUPPORT_PHOTO_CONTENT_TYPES, example: 'image/jpeg' })
  @IsIn(SUPPORT_PHOTO_CONTENT_TYPES)
  contentType: string;

  @ApiProperty({ minimum: 1, maximum: SUPPORT_PHOTO_MAX_BYTES, example: 350000 })
  @IsInt()
  @Min(1)
  sizeBytes: number;
}

export class SupportPhotoUploadDto {
  @ApiProperty({ description: 'Presigned PUT URL' })
  url: string;

  @ApiProperty({ enum: ['PUT'] })
  method: 'PUT';

  @ApiProperty({ type: Object, description: 'Headers the client must send with the PUT' })
  headers: Record<string, string>;

  @ApiProperty({ description: 'Pass as photoKey when creating the request' })
  key: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
}

/** The member's own view of a request. */
export class SupportRequestDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 1042 })
  number: number;

  @ApiProperty({ enum: SUPPORT_REQUEST_TOPICS })
  topic: SupportRequestTopic;

  @ApiProperty({ type: String, nullable: true })
  relatedType: string | null;

  @ApiProperty({ type: String, nullable: true })
  relatedId: string | null;

  @ApiProperty()
  message: string;

  @ApiProperty({ description: 'A photo was attached' })
  hasPhoto: boolean;

  @ApiProperty({ enum: SUPPORT_REQUEST_STATUSES })
  status: SupportRequestStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class SupportRequestPageDto {
  @ApiProperty({ type: [SupportRequestDto] })
  items: SupportRequestDto[];

  @ApiPropertyOptional({ type: String, nullable: true })
  nextCursor: string | null;
}

/** Back-office view: member id, photo link and the internal note. */
export class AdminSupportRequestDto extends SupportRequestDto {
  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty({ type: String, nullable: true })
  photoKey: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Short-lived download link of the photo (detail endpoint only)',
  })
  photoUrl: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Last back-office note' })
  adminNote: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  resolvedById: string | null;
}

export class AdminSupportRequestPageDto {
  @ApiProperty({ type: [AdminSupportRequestDto] })
  items: AdminSupportRequestDto[];

  @ApiPropertyOptional({ type: String, nullable: true })
  nextCursor: string | null;
}

export class AdminListSupportRequestsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: SUPPORT_REQUEST_STATUSES })
  @IsOptional()
  @IsIn(SUPPORT_REQUEST_STATUSES)
  status?: SupportRequestStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  userId?: string;
}

export class UpdateSupportRequestDto {
  @ApiProperty({
    enum: SUPPORT_REQUEST_STATUSES,
    description:
      'new -> in_progress|resolved|closed; in_progress -> resolved|closed; resolved -> in_progress|closed; the current status only updates the note',
  })
  @IsIn(SUPPORT_REQUEST_STATUSES)
  status: SupportRequestStatus;

  @ApiPropertyOptional({ maxLength: 2000, example: 'Оператор паркінгу підтвердив оплату' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  note?: string;
}
