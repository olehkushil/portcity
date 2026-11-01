import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  type NotificationChannel,
  type NotificationKind,
} from '../../../common/contracts/notifications';
import { NotificationDto, PushDeliveryDto } from './notification.dto';

export class AdminSendNotificationDto {
  @ApiProperty({ format: 'uuid', description: 'Recipient (member id)' })
  @IsUUID()
  userId: string;

  @ApiPropertyOptional({ enum: NOTIFICATION_KINDS, default: 'system' })
  @IsOptional()
  @IsIn(NOTIFICATION_KINDS)
  kind?: NotificationKind;

  @ApiProperty({ maxLength: 200, example: 'Повідомлення від Порт City' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: NOTIFICATION_CHANNELS, description: 'Default: the kind default' })
  @IsOptional()
  @IsIn(NOTIFICATION_CHANNELS)
  channel?: NotificationChannel;

  @ApiPropertyOptional({
    description: 'Replay protection: the same key returns the existing notification',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9:_.-]+$/)
  dedupeKey?: string;

  @ApiPropertyOptional({ description: 'Audit reason', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class AdminSendNotificationResultDto {
  @ApiProperty({ description: 'False when the member cannot receive this kind' })
  delivered: boolean;

  @ApiPropertyOptional({ type: NotificationDto, nullable: true })
  notification: NotificationDto | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'preference_disabled',
    description: 'user_missing | user_inactive | preference_disabled | consent_missing',
  })
  skippedReason: string | null;

  @ApiProperty({ description: 'True when dedupeKey matched an existing notification' })
  replayed: boolean;
}

export class AdminNotificationDetailsDto {
  @ApiProperty({ type: NotificationDto })
  notification: NotificationDto;

  @ApiProperty({ type: [PushDeliveryDto] })
  deliveries: PushDeliveryDto[];
}
