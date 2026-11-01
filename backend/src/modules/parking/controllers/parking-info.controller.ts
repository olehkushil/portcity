import { Body, Controller, Delete, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { PaidAtPaymatDto, StartInfoSessionDto, UpdateInfoSessionDto } from '../dto/info.dto';
import { ParkingSessionDto, toSessionDto } from '../dto/session.dto';
import { InfoModeService } from '../services/info-mode.service';
import { toDate, uuidParam } from './uuid-param';

/** Info mode (design brief 4.2): the member's own timer, payment only at the paymat. */
@ApiTags('parking')
@Controller('parking/info/sessions')
@Auth('member')
export class ParkingInfoController {
  constructor(private readonly info: InfoModeService) {}

  @Post()
  @ApiOperation({
    summary: 'I0 → I1: start the timer',
    description: 'One running timer per member. Disabled by the feature flag parking.info_mode.',
  })
  @ApiCreatedResponse({ type: ParkingSessionDto })
  @ApiProblemResponses(400, 403, 409)
  async start(
    @CurrentUser('id') userId: string,
    @Body() body: StartInfoSessionDto,
  ): Promise<ParkingSessionDto> {
    return toSessionDto(
      await this.info.start(userId, { zone: body.zone, enteredAt: toDate(body.enteredAt) }),
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Correct a running timer: entry time and/or zone',
    description: 'Same limits as at the start (not in the future, not older than the timer TTL).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ParkingSessionDto })
  @ApiProblemResponses(400, 404, 409)
  async update(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) id: string,
    @Body() body: UpdateInfoSessionDto,
  ): Promise<ParkingSessionDto> {
    return toSessionDto(
      await this.info.update(userId, id, {
        enteredAt: body.enteredAt ? toDate(body.enteredAt) : null,
        zone: body.zone ?? null,
      }),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Discard a timer started by mistake (nothing stays in the history)',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse()
  @ApiProblemResponses(400, 404)
  async discard(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) id: string,
  ): Promise<void> {
    await this.info.discard(userId, id);
  }

  @Post(':id/paid-at-paymat')
  @HttpCode(200)
  @ApiOperation({
    summary: 'I2 → I3: «Я оплатив у паркоматі»',
    description: 'paidUntil from the paymat receipt; defaults to the end of the running hour.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ParkingSessionDto })
  @ApiProblemResponses(400, 404, 409)
  async paidAtPaymat(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) id: string,
    @Body() body: PaidAtPaymatDto,
  ): Promise<ParkingSessionDto> {
    return toSessionDto(
      await this.info.paidAtPaymat(userId, id, {
        paidUntil: body.paidUntil ? toDate(body.paidUntil) : null,
      }),
    );
  }

  @Post(':id/exit')
  @HttpCode(200)
  @ApiOperation({ summary: '→ I4: «Я виїхав» (summary of time and approximate amount)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ParkingSessionDto })
  @ApiProblemResponses(400, 404, 409)
  async exit(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) id: string,
  ): Promise<ParkingSessionDto> {
    return toSessionDto(await this.info.exit(userId, id));
  }
}
