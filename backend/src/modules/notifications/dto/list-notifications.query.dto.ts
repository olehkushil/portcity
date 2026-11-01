import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import { NOTIFICATION_KINDS, type NotificationKind } from '../../../common/contracts/notifications';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === true || value === '1') {
    return true;
  }
  if (value === 'false' || value === false || value === '0') {
    return false;
  }
  return value;
};

export class ListNotificationsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ type: Boolean, description: 'Only unread notifications when true' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  unread?: boolean;

  @ApiPropertyOptional({ enum: NOTIFICATION_KINDS })
  @IsOptional()
  @IsIn(NOTIFICATION_KINDS)
  kind?: NotificationKind;
}

export class AdminListNotificationsQueryDto extends ListNotificationsQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Member whose inbox is listed' })
  @IsUUID()
  userId: string;
}
