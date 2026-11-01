import {
  Body,
  Controller,
  Delete,
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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Auth, CurrentUser, Roles } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import {
  BlockFiscalNumberDto,
  ConfirmFiscalNumberDto,
  CreateFiscalNumberDto,
  FiscalNumberDto,
  FiscalNumberPageDto,
  ListFiscalNumbersQueryDto,
  UpdateFiscalNumberDto,
} from '../dto/fiscal-number.dto';
import { UuidParamDto } from '../dto/params.dto';
import { FiscalNumbersService } from '../services/fiscal-numbers.service';
import { toFiscalNumberDto } from '../services/mappers';
import { CONTENT_READ_ROLES, FISCAL_NUMBER_WRITE_ROLES } from './admin-roles';

/**
 * Whitelist of cash register fiscal numbers. Unknown numbers arrive from receipts as
 * `pending` (source `receipt`); moderators confirm them (map to a tenant, `active`) or block
 * them. Status machine: pending -> active | blocked, active -> blocked, blocked -> active | pending.
 */
@ApiTags('admin')
@Controller('admin/fiscal-numbers')
@Auth('admin', ...CONTENT_READ_ROLES)
export class AdminFiscalNumbersController {
  constructor(private readonly fiscalNumbers: FiscalNumbersService) {}

  @Get()
  @ApiOperation({
    summary: 'List fiscal numbers, newest first',
    description:
      'Use status=pending&unmapped=true for the moderation queue of numbers seen on receipts.',
  })
  @ApiOkResponse({ type: FiscalNumberPageDto })
  @ApiProblemResponses(400)
  async list(@Query() query: ListFiscalNumbersQueryDto): Promise<FiscalNumberPageDto> {
    const page = await this.fiscalNumbers.list(query);
    return { items: page.items.map(toFiscalNumberDto), nextCursor: page.nextCursor };
  }

  @Post()
  @Roles(...FISCAL_NUMBER_WRITE_ROLES)
  @ApiOperation({
    summary: 'Register a fiscal number (source admin)',
    description: 'Status defaults to active when tenantId is given, otherwise pending.',
  })
  @ApiCreatedResponse({ type: FiscalNumberDto })
  @ApiProblemResponses(400, 404, 409, 422)
  async create(
    @Body() body: CreateFiscalNumberDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<FiscalNumberDto> {
    return toFiscalNumberDto(await this.fiscalNumbers.create(body, { id: adminId, ip }));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fiscal number detail' })
  @ApiOkResponse({ type: FiscalNumberDto })
  @ApiProblemResponses(400, 404)
  async get(@Param() params: UuidParamDto): Promise<FiscalNumberDto> {
    return toFiscalNumberDto(await this.fiscalNumbers.getById(params.id));
  }

  @Patch(':id')
  @Roles(...FISCAL_NUMBER_WRITE_ROLES)
  @ApiOperation({ summary: 'Change mapping, note or status (state machine applies)' })
  @ApiOkResponse({ type: FiscalNumberDto })
  @ApiProblemResponses(400, 404, 409, 422)
  async update(
    @Param() params: UuidParamDto,
    @Body() body: UpdateFiscalNumberDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<FiscalNumberDto> {
    return toFiscalNumberDto(await this.fiscalNumbers.update(params.id, body, { id: adminId, ip }));
  }

  @Post(':id/confirm')
  @Roles(...FISCAL_NUMBER_WRITE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm a pending (or blocked) number: active, mapped to a tenant',
    description: 'tenantId is required when the number is not mapped yet.',
  })
  @ApiOkResponse({ type: FiscalNumberDto })
  @ApiProblemResponses(400, 404, 409, 422)
  async confirm(
    @Param() params: UuidParamDto,
    @Body() body: ConfirmFiscalNumberDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<FiscalNumberDto> {
    return toFiscalNumberDto(
      await this.fiscalNumbers.confirm(params.id, body, { id: adminId, ip }),
    );
  }

  @Post(':id/block')
  @Roles(...FISCAL_NUMBER_WRITE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Block a number (receipts from it go to moderation)' })
  @ApiOkResponse({ type: FiscalNumberDto })
  @ApiProblemResponses(400, 404, 409)
  async block(
    @Param() params: UuidParamDto,
    @Body() body: BlockFiscalNumberDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<FiscalNumberDto> {
    return toFiscalNumberDto(await this.fiscalNumbers.block(params.id, body, { id: adminId, ip }));
  }

  @Delete(':id')
  @Roles(...FISCAL_NUMBER_WRITE_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a pending or blocked number (block an active one instead)' })
  @ApiNoContentResponse()
  @ApiProblemResponses(400, 404, 409)
  async remove(
    @Param() params: UuidParamDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<void> {
    await this.fiscalNumbers.remove(params.id, { id: adminId, ip });
  }
}
