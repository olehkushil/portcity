import { Body, Controller, Get, Ip, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Auth, CurrentUser, Roles } from '../../../common/auth/auth.decorators';
import type { ParkingTariffConfig } from '../../../common/contracts/parking';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { normalisePlate } from '../domain/plate';
import {
  AdminCloseSessionDto,
  AdminSessionPageDto,
  AdminSessionsQueryDto,
  CreateParkingTariffDto,
  ParkingTariffListDto,
  ParkingTariffRecordDto,
  toTariffRecordDto,
} from '../dto/admin.dto';
import { ParkingSessionDto, toSessionDto } from '../dto/session.dto';
import { ParkingService } from '../services/parking.service';
import { TariffService } from '../services/tariff.service';
import { toDate, uuidParam } from './uuid-param';

/** Back office: versioned tariffs and parking sessions (FOUNDATION_SUMMARY section 10). */
@ApiTags('admin')
@Controller('admin/parking')
@Auth('admin', 'manager')
export class AdminParkingController {
  constructor(
    private readonly tariffs: TariffService,
    private readonly parking: ParkingService,
  ) {}

  @Get('tariffs')
  @ApiOperation({ summary: 'Tariff versions, newest activeFrom first' })
  @ApiOkResponse({ type: ParkingTariffListDto })
  async listTariffs(): Promise<ParkingTariffListDto> {
    return { items: (await this.tariffs.list()).map(toTariffRecordDto) };
  }

  @Get('tariffs/:version')
  @ApiParam({ name: 'version', type: Number })
  @ApiOperation({ summary: 'One tariff version' })
  @ApiOkResponse({ type: ParkingTariffRecordDto })
  @ApiProblemResponses(400, 404)
  async getTariff(
    @Param('version', ParseIntPipe) version: number,
  ): Promise<ParkingTariffRecordDto> {
    return toTariffRecordDto(await this.tariffs.getByVersion(version));
  }

  @Post('tariffs')
  @ApiOperation({
    summary: 'Create the next tariff version (versions are never edited; audited)',
  })
  @ApiCreatedResponse({ type: ParkingTariffRecordDto })
  @ApiProblemResponses(400)
  async createTariff(
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
    @Body() body: CreateParkingTariffDto,
  ): Promise<ParkingTariffRecordDto> {
    // Typed escape hatch: TariffService.create validates the raw object with the zod schema
    // (domain/tariff-config.ts) and answers 400 with the issues when it does not match.
    const record = await this.tariffs.create(
      {
        activeFrom: toDate(body.activeFrom),
        config: body.config as unknown as ParkingTariffConfig,
      },
      { id: adminId, ip },
    );
    return toTariffRecordDto(record);
  }

  @Get('sessions')
  @Roles('manager', 'support')
  @ApiOperation({ summary: 'Parking sessions, newest first' })
  @ApiOkResponse({ type: AdminSessionPageDto })
  @ApiProblemResponses(400)
  async listSessions(@Query() query: AdminSessionsQueryDto): Promise<AdminSessionPageDto> {
    const plate = query.plate ? (normalisePlate(query.plate)?.plate ?? query.plate) : undefined;
    const page = await this.parking.listForAdmin({
      status: query.status,
      plate,
      userId: query.userId,
      ...(query.disputed !== undefined ? { disputed: query.disputed === 'true' } : {}),
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map((view) => toSessionDto(view)), nextCursor: page.nextCursor };
  }

  @Post('sessions/:id/close-free')
  @Roles('manager', 'support')
  @ApiOperation({
    summary: 'Close a session free of charge (closed_free: privilege or air raid; audited)',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: ParkingSessionDto })
  @ApiProblemResponses(400, 404, 409)
  async closeFree(
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
    @Param('id', uuidParam()) id: string,
    @Body() body: AdminCloseSessionDto,
  ): Promise<ParkingSessionDto> {
    return toSessionDto(
      await this.parking.closeFree(
        id,
        { reason: body.reason, note: body.note ?? null },
        { id: adminId, ip },
      ),
    );
  }
}
