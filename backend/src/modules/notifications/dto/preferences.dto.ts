import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  ValidateNested,
} from 'class-validator';
import { NOTIFICATION_KINDS, type NotificationKind } from '../../../common/contracts/notifications';
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '../domain/kinds';
import type { PreferenceView } from '../services/notification-preferences.service';

export class NotificationPreferenceDto {
  @ApiProperty({ enum: NOTIFICATION_KINDS })
  kind: NotificationKind;

  @ApiProperty({ enum: NOTIFICATION_CATEGORIES })
  category: NotificationCategory;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty({ description: 'Service kinds that cannot be switched off' })
  locked: boolean;
}

export class NotificationPreferencesDto {
  @ApiProperty({ type: [NotificationPreferenceDto] })
  items: NotificationPreferenceDto[];
}

export class UpdatePreferenceItemDto {
  @ApiProperty({ enum: NOTIFICATION_KINDS })
  @IsIn(NOTIFICATION_KINDS)
  kind: NotificationKind;

  @ApiProperty()
  @IsBoolean()
  enabled: boolean;
}

export class UpdatePreferencesDto {
  @ApiProperty({ type: [UpdatePreferenceItemDto], minItems: 1, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => UpdatePreferenceItemDto)
  items: UpdatePreferenceItemDto[];
}

export function toPreferencesDto(views: PreferenceView[]): NotificationPreferencesDto {
  return { items: views.map((view) => ({ ...view })) };
}
