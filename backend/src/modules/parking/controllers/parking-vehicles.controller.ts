import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import {
  AddVehicleDto,
  VehicleDto,
  VehicleListDto,
  VerifyVehicleDto,
  toVehicleDto,
} from '../dto/vehicle.dto';
import { VehiclesService } from '../services/vehicles.service';
import { uuidParam } from './uuid-param';

/** «Мої авто» (design brief S06): plates of the member, verification by talon or paymat code. */
@ApiTags('parking')
@Controller('parking/vehicles')
@Auth('member')
export class ParkingVehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Get()
  @ApiOperation({ summary: 'My vehicles, the default one first' })
  @ApiOkResponse({ type: VehicleListDto })
  async list(@CurrentUser('id') userId: string): Promise<VehicleListDto> {
    return { items: (await this.vehicles.list(userId)).map(toVehicleDto) };
  }

  @Post()
  @ApiOperation({
    summary: 'Add a vehicle',
    description:
      'Normalises the plate to Latin letters without spaces (Cyrillic look-alikes are mapped). ' +
      'The first vehicle (or one sent with makeDefault: true) becomes the default one; label is the ' +
      'member’s own name for the car. New vehicles are unverified.',
  })
  @ApiCreatedResponse({ type: VehicleDto })
  @ApiProblemResponses(400, 409, 422)
  async add(@CurrentUser('id') userId: string, @Body() body: AddVehicleDto): Promise<VehicleDto> {
    return toVehicleDto(
      await this.vehicles.add(userId, body.plate, {
        label: body.label ?? null,
        makeDefault: body.makeDefault === true,
      }),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a vehicle (not while it is in an active session)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse()
  @ApiProblemResponses(400, 404, 409)
  async remove(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) id: string,
  ): Promise<void> {
    await this.vehicles.remove(userId, id);
  }

  @Post(':id/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  @ApiOperation({
    summary: 'Verify a vehicle with the talon or paymat code',
    description:
      'Exactly one of talonCode / paymatCode. The operator checks the code against the plate; ' +
      'a verified vehicle sees its full session and can pay in the app. 10 attempts per hour per IP ' +
      'and 5 per 24 h per vehicle (429 PC_PARKING_VERIFICATION_LIMIT).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: VehicleDto })
  @ApiProblemResponses(400, 404, 409, 422, 429, 503)
  async verify(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) id: string,
    @Body() body: VerifyVehicleDto,
  ): Promise<VehicleDto> {
    return toVehicleDto(await this.vehicles.verify(userId, id, body));
  }

  @Post(':id/default')
  @HttpCode(200)
  @ApiOperation({ summary: 'Make the vehicle the default one («Основне»)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: VehicleDto })
  @ApiProblemResponses(400, 404)
  async setDefault(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) id: string,
  ): Promise<VehicleDto> {
    return toVehicleDto(await this.vehicles.setDefault(userId, id));
  }
}
