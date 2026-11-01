import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser, Roles } from '../../../common/auth/auth.decorators';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { DomainError } from '../../../common/errors/domain-error';
import { NotificationErrors } from '../domain/errors';
import {
  AdminNotificationDetailsDto,
  AdminSendNotificationDto,
  AdminSendNotificationResultDto,
} from '../dto/admin-send-notification.dto';
import { AdminListNotificationsQueryDto } from '../dto/list-notifications.query.dto';
import { NotificationPageDto, toNotificationDto, toPushDeliveryDto } from '../dto/notification.dto';
import { NotificationsService } from '../services/notifications.service';

/**
 * Back-office tools: send a notification to one member (support), inspect a member's inbox
 * and push deliveries. Not in brief section 8; added for support work and audited.
 */
@ApiTags('admin')
@Controller('admin/notifications')
@Auth('admin', 'manager', 'support', 'moderator')
export class AdminNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post()
  @HttpCode(200)
  @Roles('manager', 'support')
  @ApiOperation({ summary: 'Send a notification to a member (audited)' })
  @ApiOkResponse({ type: AdminSendNotificationResultDto })
  @ApiProblemResponses(400)
  async send(
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
    @Body() body: AdminSendNotificationDto,
  ): Promise<AdminSendNotificationResultDto> {
    const result = await this.notifications.sendAsAdmin(
      {
        userId: body.userId,
        kind: body.kind ?? 'system',
        title: body.title,
        body: body.body,
        data: body.data,
        channel: body.channel,
        dedupeKey: body.dedupeKey,
      },
      { id: admin.id, ip },
      body.reason ?? null,
    );
    return {
      delivered: result.notification !== null,
      notification: result.notification ? toNotificationDto(result.notification) : null,
      skippedReason: result.status === 'skipped' ? result.reason : null,
      replayed: result.status === 'replayed',
    };
  }

  @Get()
  @ApiOperation({ summary: "A member's notifications, newest first" })
  @ApiOkResponse({ type: NotificationPageDto })
  @ApiProblemResponses(400)
  async list(@Query() query: AdminListNotificationsQueryDto): Promise<NotificationPageDto> {
    const page = await this.notifications.list(query.userId, {
      cursor: query.cursor,
      limit: query.limit,
      unread: query.unread,
      kind: query.kind,
    });
    return { items: page.items.map(toNotificationDto), nextCursor: page.nextCursor };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One notification with its push deliveries' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdminNotificationDetailsDto })
  @ApiProblemResponses(400, 404)
  async details(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AdminNotificationDetailsDto> {
    const notification = await this.notifications.getById(id);
    if (!notification) {
      throw new DomainError(
        NotificationErrors.PC_NOTIFICATION_NOT_FOUND,
        'Notification not found',
        {
          details: { notificationId: id },
        },
      );
    }
    const deliveries = await this.notifications.listDeliveries(id);
    return {
      notification: toNotificationDto(notification),
      deliveries: deliveries.map(toPushDeliveryDto),
    };
  }
}
