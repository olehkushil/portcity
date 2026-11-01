import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Auth, CurrentUser, Roles } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import {
  AdminListEventsQueryDto,
  AdminListRegistrationsQueryDto,
  CreateEventDto,
  UpdateEventDto,
} from '../dto/admin-event.dto';
import { AdminReasonDto, AdminRequiredReasonDto } from '../dto/admin-promo.dto';
import { EventDto, EventPageDto, RegistrationDto, RegistrationPageDto } from '../dto/event.dto';
import { EventsAdminService } from '../services/events-admin.service';

/** Back-office events and registrations. Reads: manager, support, moderator; writes: manager. */
@ApiTags('admin')
@Controller('admin/events')
@Auth('admin', 'manager', 'support', 'moderator')
export class AdminEventsController {
  constructor(private readonly admin: EventsAdminService) {}

  @Get()
  @ApiOperation({ summary: 'List events (any status)' })
  @ApiOkResponse({ type: EventPageDto })
  @ApiProblemResponses(400)
  list(@Query() query: AdminListEventsQueryDto): Promise<EventPageDto> {
    return this.admin.listEvents(query);
  }

  @Post()
  @Roles('manager')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a draft event' })
  @ApiCreatedResponse({ type: EventDto })
  @ApiProblemResponses(400, 422)
  create(
    @Body() body: CreateEventDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<EventDto> {
    return this.admin.createEvent(body, { id: adminId, ip });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Event detail' })
  @ApiOkResponse({ type: EventDto })
  @ApiProblemResponses(400, 404)
  get(@Param('id', ParseUUIDPipe) eventId: string): Promise<EventDto> {
    return this.admin.getEvent(eventId);
  }

  @Patch(':id')
  @Roles('manager')
  @ApiOperation({ summary: 'Update event fields (capacity cannot drop below registered persons)' })
  @ApiOkResponse({ type: EventDto })
  @ApiProblemResponses(400, 404, 422)
  update(
    @Param('id', ParseUUIDPipe) eventId: string,
    @Body() body: UpdateEventDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<EventDto> {
    return this.admin.updateEvent(eventId, body, { id: adminId, ip });
  }

  @Delete(':id')
  @Roles('manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a draft event' })
  @ApiNoContentResponse()
  @ApiProblemResponses(400, 404, 409)
  async remove(
    @Param('id', ParseUUIDPipe) eventId: string,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
    @Body() body: AdminReasonDto,
  ): Promise<void> {
    await this.admin.deleteEvent(eventId, { id: adminId, ip }, body.reason);
  }

  @Post(':id/publish')
  @Roles('manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish a draft event' })
  @ApiOkResponse({ type: EventDto })
  @ApiProblemResponses(400, 404, 409, 422)
  publish(
    @Param('id', ParseUUIDPipe) eventId: string,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
    @Body() body: AdminReasonDto,
  ): Promise<EventDto> {
    return this.admin.publishEvent(eventId, { id: adminId, ip }, body.reason);
  }

  @Post(':id/cancel')
  @Roles('manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel the event',
    description:
      'Cascades to every active registration: tickets are cancelled, seats released, event.cancelled is emitted.',
  })
  @ApiOkResponse({ type: EventDto })
  @ApiProblemResponses(400, 404, 409)
  cancel(
    @Param('id', ParseUUIDPipe) eventId: string,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
    @Body() body: AdminRequiredReasonDto,
  ): Promise<EventDto> {
    return this.admin.cancelEvent(eventId, body.reason, { id: adminId, ip });
  }

  @Post(':id/finish')
  @Roles('manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a published event as finished (the hourly job does it too)' })
  @ApiOkResponse({ type: EventDto })
  @ApiProblemResponses(400, 404, 409)
  finish(
    @Param('id', ParseUUIDPipe) eventId: string,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
    @Body() body: AdminReasonDto,
  ): Promise<EventDto> {
    return this.admin.finishEvent(eventId, { id: adminId, ip }, body.reason);
  }

  @Get(':id/registrations')
  @ApiOperation({ summary: 'Registrations of the event' })
  @ApiOkResponse({ type: RegistrationPageDto })
  @ApiProblemResponses(400, 404)
  registrations(
    @Param('id', ParseUUIDPipe) eventId: string,
    @Query() query: AdminListRegistrationsQueryDto,
  ): Promise<RegistrationPageDto> {
    return this.admin.listRegistrations(eventId, query);
  }

  @Post(':id/registrations/:registrationId/cancel')
  @Roles('manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel one registration (ticket cancelled, seats released)' })
  @ApiOkResponse({ type: RegistrationDto })
  @ApiProblemResponses(400, 404, 409)
  cancelRegistration(
    @Param('id', ParseUUIDPipe) eventId: string,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
    @Body() body: AdminRequiredReasonDto,
  ): Promise<RegistrationDto> {
    return this.admin.cancelRegistration(eventId, registrationId, body.reason, {
      id: adminId,
      ip,
    });
  }
}
