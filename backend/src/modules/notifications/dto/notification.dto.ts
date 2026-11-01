import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  PUSH_DELIVERY_STATUSES,
  type NotificationChannel,
  type NotificationKind,
  type NotificationSummary,
  type PushDeliveryStatus,
} from '../../../common/contracts/notifications';
import type { PushDeliverySummary } from '../services/notifications.service';

export class NotificationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty({ enum: NOTIFICATION_KINDS, example: 'receipt_credited' })
  kind: NotificationKind;

  @ApiProperty({ example: 'Бали нараховано', maxLength: 200 })
  title: string;

  @ApiProperty({ example: 'Чек на 6 000 ₴ прийнято: +180 балів на ваш рахунок.' })
  body: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Deep-link context for the app, e.g. { receiptId }',
  })
  data: Record<string, unknown>;

  @ApiProperty({ enum: NOTIFICATION_CHANNELS })
  channel: NotificationChannel;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  sentAt: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  readAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class NotificationPageDto {
  @ApiProperty({ type: [NotificationDto] })
  items: NotificationDto[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Pass as ?cursor= for the next page',
  })
  nextCursor: string | null;
}

export class UnreadCountDto {
  @ApiProperty({ example: 3 })
  count: number;
}

export class MarkAllReadResultDto {
  @ApiProperty({ description: 'Number of notifications that were unread', example: 3 })
  updated: number;
}

export class PushDeliveryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  notificationId: string;

  @ApiProperty({ format: 'uuid' })
  deviceId: string;

  @ApiProperty({ example: 'fcm' })
  provider: string;

  @ApiProperty({ enum: PUSH_DELIVERY_STATUSES })
  status: PushDeliveryStatus;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'unregistered: 404 UNREGISTERED' })
  error: string | null;

  @ApiProperty({ example: 1 })
  attempts: number;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  sentAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export function toNotificationDto(summary: NotificationSummary): NotificationDto {
  return {
    id: summary.id,
    userId: summary.userId,
    kind: summary.kind,
    title: summary.title,
    body: summary.body,
    data: summary.data,
    channel: summary.channel,
    sentAt: summary.sentAt,
    readAt: summary.readAt,
    createdAt: summary.createdAt,
  };
}

export function toPushDeliveryDto(summary: PushDeliverySummary): PushDeliveryDto {
  return { ...summary };
}
