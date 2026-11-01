import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Auth, CurrentUser, OptionalAuth } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { Idempotent } from '../../../common/idempotency/idempotency.decorator';
import {
  EventDto,
  EventPageDto,
  ListEventsQueryDto,
  RegisterEventDto,
  RegistrationDto,
} from '../dto/event.dto';
import { EventsService } from '../services/events.service';

@ApiTags('promos')
@Controller('events')
@Auth('member')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @OptionalAuth()
  @ApiOperation({
    summary: 'Event poster: upcoming (default) or past events (guest-readable)',
    description:
      'Filter by category. Works without a token; registration is attached only for a member token.',
  })
  @ApiOkResponse({ type: EventPageDto })
  @ApiProblemResponses(400)
  list(
    @Query() query: ListEventsQueryDto,
    @CurrentUser('id') userId: string | undefined,
  ): Promise<EventPageDto> {
    return this.events.list(query, userId);
  }

  @Get(':id')
  @OptionalAuth()
  @ApiOperation({
    summary: 'Event detail with the registration and ticket of the caller (guest-readable)',
    description: 'Without a token registration is null.',
  })
  @ApiOkResponse({ type: EventDto })
  @ApiProblemResponses(400, 404)
  get(
    @Param('id', ParseUUIDPipe) eventId: string,
    @CurrentUser('id') userId: string | undefined,
  ): Promise<EventDto> {
    return this.events.getForMember(eventId, userId);
  }

  @Post(':id/register')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Register for the event',
    description:
      'One registration per member and event (adults + children, at most the event maxPersonsPerRegistration, 4 by default). Not available for external admission. Issues a ticket voucher (kind = ticket); requires Idempotency-Key.',
  })
  @ApiCreatedResponse({ type: RegistrationDto })
  @ApiProblemResponses(400, 404, 409, 422, 429)
  register(
    @Param('id', ParseUUIDPipe) eventId: string,
    @CurrentUser('id') userId: string,
    @Body() body: RegisterEventDto,
  ): Promise<RegistrationDto> {
    return this.events.register(eventId, userId, body);
  }

  @Delete(':id/register')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel the registration',
    description: 'Allowed until 11:00 Kyiv on the event day (or the start, if earlier).',
  })
  @ApiOkResponse({ type: RegistrationDto })
  @ApiProblemResponses(400, 404, 422)
  cancel(
    @Param('id', ParseUUIDPipe) eventId: string,
    @CurrentUser('id') userId: string,
  ): Promise<RegistrationDto> {
    return this.events.cancelRegistration(eventId, userId);
  }
}
