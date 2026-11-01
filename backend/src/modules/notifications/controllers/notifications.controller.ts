import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { ListNotificationsQueryDto } from '../dto/list-notifications.query.dto';
import {
  MarkAllReadResultDto,
  NotificationDto,
  NotificationPageDto,
  UnreadCountDto,
  toNotificationDto,
} from '../dto/notification.dto';
import {
  NotificationPreferencesDto,
  UpdatePreferencesDto,
  toPreferencesDto,
} from '../dto/preferences.dto';
import { NotificationPreferencesService } from '../services/notification-preferences.service';
import { NotificationsService } from '../services/notifications.service';

/** Member inbox and preferences (brief section 8, "notifications"). */
@ApiTags('notifications')
@Controller('notifications')
@Auth('member')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly preferences: NotificationPreferencesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My notifications, newest first (cursor pagination)' })
  @ApiOkResponse({ type: NotificationPageDto })
  @ApiProblemResponses(400)
  async list(
    @CurrentUser('id') userId: string,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<NotificationPageDto> {
    const page = await this.notifications.list(userId, {
      cursor: query.cursor,
      limit: query.limit,
      unread: query.unread,
      kind: query.kind,
    });
    return { items: page.items.map(toNotificationDto), nextCursor: page.nextCursor };
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Number of unread notifications (badge)' })
  @ApiOkResponse({ type: UnreadCountDto })
  async unreadCount(@CurrentUser('id') userId: string): Promise<UnreadCountDto> {
    return { count: await this.notifications.countUnread(userId) };
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Per-kind notification preferences' })
  @ApiOkResponse({ type: NotificationPreferencesDto })
  async getPreferences(@CurrentUser('id') userId: string): Promise<NotificationPreferencesDto> {
    return toPreferencesDto(await this.preferences.getAll(userId));
  }

  @Put('preferences')
  @ApiOperation({ summary: 'Enable or disable notification kinds (partial update)' })
  @ApiOkResponse({ type: NotificationPreferencesDto })
  @ApiProblemResponses(400, 422)
  async updatePreferences(
    @CurrentUser('id') userId: string,
    @Body() body: UpdatePreferencesDto,
  ): Promise<NotificationPreferencesDto> {
    return toPreferencesDto(await this.preferences.update(userId, body.items));
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark every notification as read' })
  @ApiOkResponse({ type: MarkAllReadResultDto })
  async readAll(@CurrentUser('id') userId: string): Promise<MarkAllReadResultDto> {
    return { updated: await this.notifications.markAllRead(userId) };
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark one notification as read (idempotent)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: NotificationDto })
  @ApiProblemResponses(400, 404)
  async read(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<NotificationDto> {
    return toNotificationDto(await this.notifications.markRead(userId, id));
  }
}
