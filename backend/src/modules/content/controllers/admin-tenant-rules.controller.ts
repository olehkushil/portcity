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
import { UuidParamDto } from '../dto/params.dto';
import {
  AdminCreateTenantRuleDto,
  ListTenantRulesQueryDto,
  TenantRuleDto,
  TenantRulePageDto,
  UpdateTenantRuleDto,
} from '../dto/tenant-rule.dto';
import { toTenantRuleDto } from '../services/mappers';
import { TenantRulesService } from '../services/tenant-rules.service';
import { CONTENT_READ_ROLES, CONTENT_WRITE_ROLES } from './admin-roles';

/**
 * Time-bound per-tenant loyalty rules `[validFrom, validTo)`. Periods of one tenant must not
 * overlap; an active rule wins over Tenant.ratePercentOverride. Writes emit tenant.updated.
 */
@ApiTags('admin')
@Controller('admin/tenant-rules')
@Auth('admin', ...CONTENT_READ_ROLES)
export class AdminTenantRulesController {
  constructor(private readonly rules: TenantRulesService) {}

  @Get()
  @ApiOperation({ summary: 'List tenant rules, newest first (filter by tenantId, activeAt)' })
  @ApiOkResponse({ type: TenantRulePageDto })
  @ApiProblemResponses(400)
  async list(@Query() query: ListTenantRulesQueryDto): Promise<TenantRulePageDto> {
    const page = await this.rules.list({
      tenantId: query.tenantId,
      activeAt: query.activeAt !== undefined ? new Date(query.activeAt) : undefined,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map(toTenantRuleDto), nextCursor: page.nextCursor };
  }

  @Post()
  @Roles(...CONTENT_WRITE_ROLES)
  @ApiOperation({ summary: 'Create a rule for a tenant' })
  @ApiCreatedResponse({ type: TenantRuleDto })
  @ApiProblemResponses(400, 404, 409, 422)
  async create(
    @Body() body: AdminCreateTenantRuleDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<TenantRuleDto> {
    return toTenantRuleDto(await this.rules.create(body.tenantId, body, { id: adminId, ip }));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Rule detail' })
  @ApiOkResponse({ type: TenantRuleDto })
  @ApiProblemResponses(400, 404)
  async get(@Param() params: UuidParamDto): Promise<TenantRuleDto> {
    return toTenantRuleDto(await this.rules.getById(params.id));
  }

  @Patch(':id')
  @Roles(...CONTENT_WRITE_ROLES)
  @ApiOperation({ summary: 'Update rate, minimum, cap or period (overlap is rejected)' })
  @ApiOkResponse({ type: TenantRuleDto })
  @ApiProblemResponses(400, 404, 409, 422)
  async update(
    @Param() params: UuidParamDto,
    @Body() body: UpdateTenantRuleDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<TenantRuleDto> {
    return toTenantRuleDto(await this.rules.updateById(params.id, body, { id: adminId, ip }));
  }

  @Delete(':id')
  @Roles(...CONTENT_WRITE_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a rule' })
  @ApiNoContentResponse()
  @ApiProblemResponses(400, 404)
  async remove(
    @Param() params: UuidParamDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<void> {
    await this.rules.removeById(params.id, { id: adminId, ip });
  }
}
