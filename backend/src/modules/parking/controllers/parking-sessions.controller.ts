import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { Idempotent } from '../../../common/idempotency/idempotency.decorator';
import { ParkingPaymentDto, toParkingPaymentDto } from '../dto/payment.dto';
import {
  ClaimSessionDto,
  DisputeSessionDto,
  ParkingHeroDto,
  ParkingHistoryPageDto,
  ParkingHistoryQueryDto,
  ParkingHistorySummaryDto,
  ParkingHistorySummaryQueryDto,
  ParkingSessionDto,
  toHeroDto,
  toHistoryItemDto,
  toHistorySummaryDto,
  toSessionDto,
} from '../dto/session.dto';
import { ParkingPaymentsService } from '../services/parking-payments.service';
import { SessionsService } from '../services/sessions.service';
import { toDate, uuidParam } from './uuid-param';

/** The parking tab (first tab and start screen): current session, payment, history. */
@ApiTags('parking')
@Controller('parking')
@Auth('member')
export class ParkingSessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly payments: ParkingPaymentsService,
  ) {}

  @Get('session')
  @ApiOperation({
    summary: 'Current parking session for the hero card (F0-F7, I0-I4)',
    description:
      'Operator session of the member’s verified vehicles (refreshed from the operator when older ' +
      'than a minute), otherwise the info-mode timer, otherwise a session closed less than 2 h ago. ' +
      'Unverified plates get only { amountDueKopecks, paidUntil } in `restricted`, 10 lookups per hour ' +
      '(429 PC_PARKING_LOOKUP_LIMIT when nothing else can be shown). `heroState` and `actions` tell ' +
      'the app which state to render; all countdowns use `serverTime`.',
  })
  @ApiOkResponse({ type: ParkingHeroDto })
  @ApiProblemResponses(429)
  async current(@CurrentUser('id') userId: string): Promise<ParkingHeroDto> {
    return toHeroDto(await this.sessions.getHero(userId));
  }

  @Post('session/:id/pay')
  @Idempotent()
  @ApiOperation({
    summary: 'Pay the amount due now',
    description:
      'Re-reads the amount from the operator, creates a payment through the payments module ' +
      '(one open or paid payment per session and paid hour; after a failed, cancelled or expired ' +
      'checkout a new attempt is created) and returns its checkout URL. With fewer than 5 minutes ' +
      'left in the running hour the next hour is included (includesNextHour). The session turns ' +
      '`paid` when payment.succeeded arrives; poll GET /payments/:id or GET /parking/session.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: ParkingPaymentDto })
  @ApiProblemResponses(400, 403, 404, 409, 503)
  async pay(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) id: string,
  ): Promise<ParkingPaymentDto> {
    return toParkingPaymentDto(await this.payments.pay(userId, id));
  }

  @Post('sessions/claim')
  @Idempotent()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Claim an operator session with its entry talon',
    description:
      'For cars the camera did not read (or a plate not verified yet): the operator confirms the talon, the ' +
      'session is attached to the member (talon-only sessions are stored with plate null) and the hero is ' +
      'returned. Idempotency-Key required; 10 claims per hour per member (429 PC_PARKING_CLAIM_LIMIT). ' +
      'Emulator talon: PC-0418227.',
  })
  @ApiOkResponse({ type: ParkingHeroDto })
  @ApiProblemResponses(400, 404, 409, 429, 503)
  async claim(
    @CurrentUser('id') userId: string,
    @Body() body: ClaimSessionDto,
  ): Promise<ParkingHeroDto> {
    return toHeroDto(await this.sessions.claimByTalon(userId, body.talonCode));
  }

  @Post('session/:id/still-here')
  @HttpCode(200)
  @ApiOperation({
    summary: 'F7 «Так, я тут»',
    description:
      'Stores presenceConfirmedAt; the "still inside?" thresholds (5 h payable, 2 h overstay) count from it. Returns the hero.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ParkingHeroDto })
  @ApiProblemResponses(400, 404, 409)
  async stillHere(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) id: string,
  ): Promise<ParkingHeroDto> {
    return toHeroDto(await this.sessions.confirmPresence(userId, id));
  }

  @Post('session/:id/dispute')
  @HttpCode(200)
  @ApiOperation({
    summary: 'F2 «Це не моє авто» (or wrong amount, barrier)',
    description:
      'Marks the session disputed: it disappears from the hero, sends no reminders and cannot be paid; ' +
      'parking.session.disputed is published for support (GET /admin/parking/sessions?disputed=true). Returns the hero.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ParkingHeroDto })
  @ApiProblemResponses(400, 404)
  async dispute(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) id: string,
    @Body() body: DisputeSessionDto,
  ): Promise<ParkingHeroDto> {
    return toHeroDto(
      await this.sessions.dispute(userId, id, {
        reason: body.reason,
        comment: body.comment ?? null,
      }),
    );
  }

  @Post('session/:id/left')
  @HttpCode(200)
  @ApiOperation({
    summary: '«Я вже виїхав»',
    description:
      'Closes the session as left now (closedReason user_left): nothing is charged automatically, ' +
      'a disputed amount stays as closed_unpaid for the operator’s reconciliation.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ParkingSessionDto })
  @ApiProblemResponses(400, 404, 409)
  async left(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) id: string,
  ): Promise<ParkingSessionDto> {
    return toSessionDto(await this.sessions.markLeft(userId, id));
  }

  @Get('history')
  @ApiOperation({
    summary: 'My parking sessions, newest first («30.10 · 1 год 52 хв · 60 ₴»)',
    description:
      'from/to filter by the entry time; each item has paidVia (app | paymat | free | none) and paymentIds.',
  })
  @ApiOkResponse({ type: ParkingHistoryPageDto })
  @ApiProblemResponses(400)
  async history(
    @CurrentUser('id') userId: string,
    @Query() query: ParkingHistoryQueryDto,
  ): Promise<ParkingHistoryPageDto> {
    const page = await this.sessions.history(userId, {
      cursor: query.cursor,
      limit: query.limit,
      ...(query.from ? { from: toDate(query.from) } : {}),
      ...(query.to ? { to: toDate(query.to) } : {}),
    });
    return { items: page.items.map(toHistoryItemDto), nextCursor: page.nextCursor };
  }

  @Get('history/summary')
  @ApiOperation({
    summary: 'Month totals: paid, visits, time parked («Жовтень: 6 візитів · 9 год 40 хв · 340 ₴»)',
  })
  @ApiOkResponse({ type: ParkingHistorySummaryDto })
  @ApiProblemResponses(400)
  async historySummary(
    @CurrentUser('id') userId: string,
    @Query() query: ParkingHistorySummaryQueryDto,
  ): Promise<ParkingHistorySummaryDto> {
    return toHistorySummaryDto(await this.sessions.historySummary(userId, query.month));
  }
}
