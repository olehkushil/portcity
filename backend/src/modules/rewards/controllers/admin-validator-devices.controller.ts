import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import {
  AdminReasonQueryDto,
  CreateValidatorDeviceDto,
  SetValidatorPinDto,
  UpdateValidatorDeviceDto,
  ValidatorDeviceDto,
  ValidatorDeviceListQueryDto,
  ValidatorDevicePageDto,
  ValidatorDeviceWithKeyDto,
} from '../dto/admin-validator-device.dto';
import { ValidatorLogPageDto } from '../dto/validator.dto';
import { toValidatorDeviceDto, toValidatorLogPageDto } from '../services/validator.mapper';
import { type AdminContext, ValidatorDevicesService } from '../services/validator-devices.service';
import { uuidParam } from './uuid.pipe';

function contextOf(admin: AuthenticatedUser, ip: string, reason?: string): AdminContext {
  return { actor: { type: 'admin', id: admin.id }, ip, reason: reason ?? null };
}

/**
 * Back-office management of cashier validator devices (`/admin/validator-devices`). The raw
 * device key is shown exactly once (create, rotate-key); only its SHA-256 is stored. Revoking
 * a device or changing its PIN closes every open shift. All mutations are audited.
 */
@ApiTags('admin')
@Controller('admin/validator-devices')
@Auth('admin', 'owner', 'manager')
export class AdminValidatorDevicesController {
  constructor(private readonly devices: ValidatorDevicesService) {}

  @Get()
  @ApiOperation({ summary: 'Validator devices, newest first' })
  @ApiOkResponse({ type: ValidatorDevicePageDto })
  @ApiProblemResponses(400)
  async list(@Query() query: ValidatorDeviceListQueryDto): Promise<ValidatorDevicePageDto> {
    const page = await this.devices.list({
      tenantId: query.tenantId,
      active: query.active,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map(toValidatorDeviceDto), nextCursor: page.nextCursor };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Validator device detail' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ValidatorDeviceDto })
  @ApiProblemResponses(400, 404)
  async get(@Param('id', uuidParam()) deviceId: string): Promise<ValidatorDeviceDto> {
    return toValidatorDeviceDto(await this.devices.get(deviceId));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a validator device',
    description:
      'Returns the raw device key once; configure it on the device as X-Validator-Key. tenantId null registers a mall device (information desk) that may redeem any voucher.',
  })
  @ApiCreatedResponse({ type: ValidatorDeviceWithKeyDto })
  @ApiProblemResponses(400)
  async create(
    @Body() body: CreateValidatorDeviceDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<ValidatorDeviceWithKeyDto> {
    const result = await this.devices.create(
      { name: body.name, tenantId: body.tenantId, pin: body.pin },
      contextOf(admin, ip),
    );
    return { device: toValidatorDeviceDto(result.device), deviceKey: result.deviceKey };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename, re-assign or re-activate a device' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ValidatorDeviceDto })
  @ApiProblemResponses(400, 404)
  async update(
    @Param('id', uuidParam()) deviceId: string,
    @Body() body: UpdateValidatorDeviceDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<ValidatorDeviceDto> {
    return toValidatorDeviceDto(
      await this.devices.update(
        deviceId,
        { name: body.name, tenantId: body.tenantId, active: body.active },
        contextOf(admin, ip),
      ),
    );
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a device remotely; it stops authenticating immediately' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ValidatorDeviceDto })
  @ApiProblemResponses(400, 404)
  async revoke(
    @Param('id', uuidParam()) deviceId: string,
    @Query() query: AdminReasonQueryDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<ValidatorDeviceDto> {
    return toValidatorDeviceDto(
      await this.devices.revoke(deviceId, contextOf(admin, ip, query.reason)),
    );
  }

  @Post(':id/rotate-key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issue a new device key (shown once); the old key stops working' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ValidatorDeviceWithKeyDto })
  @ApiProblemResponses(400, 404)
  async rotateKey(
    @Param('id', uuidParam()) deviceId: string,
    @Query() query: AdminReasonQueryDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<ValidatorDeviceWithKeyDto> {
    const result = await this.devices.rotateKey(deviceId, contextOf(admin, ip, query.reason));
    return { device: toValidatorDeviceDto(result.device), deviceKey: result.deviceKey };
  }

  @Post(':id/pin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set a new shift PIN (6-12 digits); open shifts are closed, a PIN lock is cleared',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ValidatorDeviceDto })
  @ApiProblemResponses(400, 404)
  async setPin(
    @Param('id', uuidParam()) deviceId: string,
    @Body() body: SetValidatorPinDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<ValidatorDeviceDto> {
    return toValidatorDeviceDto(
      await this.devices.setPin(deviceId, body.pin, contextOf(admin, ip)),
    );
  }

  @Get(':id/log')
  @ApiOperation({ summary: 'Redeem attempts of the device, newest first' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ValidatorLogPageDto })
  @ApiProblemResponses(400, 404)
  async log(
    @Param('id', uuidParam()) deviceId: string,
    @Query() query: CursorQueryDto,
  ): Promise<ValidatorLogPageDto> {
    return toValidatorLogPageDto(await this.devices.listLog(deviceId, query.cursor, query.limit));
  }
}
