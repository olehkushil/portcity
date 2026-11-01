import { Body, Controller, Delete, Get, Ip, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser, Roles } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { Clock } from '../../../common/time/clock';
import { UuidParamDto } from '../dto/params.dto';
import { EffectiveRuleQueryDto, EffectiveTenantRuleDto } from '../dto/tenant-rule.dto';
import {
  AdminListTenantsQueryDto,
  CreateTenantDto,
  TenantAdminDto,
  TenantAdminPageDto,
  UpdateTenantDto,
} from '../dto/tenant.dto';
import { MallInfoService } from '../services/mall-info.service';
import { toTenantAdminDto } from '../services/mappers';
import { TenantRulesService } from '../services/tenant-rules.service';
import { TenantsService } from '../services/tenants.service';
import { CONTENT_READ_ROLES, CONTENT_WRITE_ROLES } from './admin-roles';

/** Back-office tenant CRUD (every status). Writes are audited (tenant.create|update|close). */
@ApiTags('admin')
@Controller('admin/tenants')
@Auth('admin', ...CONTENT_READ_ROLES)
export class AdminTenantsController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly rules: TenantRulesService,
    private readonly mallInfo: MallInfoService,
    private readonly clock: Clock,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List tenants (any status unless filtered), sorted by name' })
  @ApiOkResponse({ type: TenantAdminPageDto })
  @ApiProblemResponses(400)
  async list(@Query() query: AdminListTenantsQueryDto): Promise<TenantAdminPageDto> {
    const [page, view] = await Promise.all([
      this.tenants.list({
        status: query.status,
        participates: query.participates,
        category: query.category,
        floor: query.floor,
        q: query.q,
        cursor: query.cursor,
        limit: query.limit,
      }),
      this.mallInfo.tenantViewContext(),
    ]);
    return {
      items: page.items.map((row) => toTenantAdminDto(row, view)),
      nextCursor: page.nextCursor,
    };
  }

  @Post()
  @Roles(...CONTENT_WRITE_ROLES)
  @ApiOperation({ summary: 'Create a tenant (slug derived from the name when omitted)' })
  @ApiCreatedResponse({ type: TenantAdminDto })
  @ApiProblemResponses(400, 409)
  async create(
    @Body() body: CreateTenantDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<TenantAdminDto> {
    const row = await this.tenants.create(body, { id: adminId, ip });
    return toTenantAdminDto(row, await this.mallInfo.tenantViewContext());
  }

  @Get(':id')
  @ApiOperation({ summary: 'Tenant detail (any status)' })
  @ApiOkResponse({ type: TenantAdminDto })
  @ApiProblemResponses(400, 404)
  async get(@Param() params: UuidParamDto): Promise<TenantAdminDto> {
    const row = await this.tenants.getById(params.id);
    return toTenantAdminDto(row, await this.mallInfo.tenantViewContext());
  }

  @Get(':id/effective-rule')
  @ApiOperation({
    summary: 'Loyalty rule that applies to the tenant at a moment (default now)',
    description:
      'Active tenant rule > ratePercentOverride > none (ratePercent null = baseRatePercent of the active rule set).',
  })
  @ApiOkResponse({ type: EffectiveTenantRuleDto })
  @ApiProblemResponses(400, 404)
  async effectiveRule(
    @Param() params: UuidParamDto,
    @Query() query: EffectiveRuleQueryDto,
  ): Promise<EffectiveTenantRuleDto> {
    const at = query.at !== undefined ? new Date(query.at) : this.clock.now();
    const rule = await this.rules.getEffectiveRule(params.id, at);
    return { ...rule, at };
  }

  @Patch(':id')
  @Roles(...CONTENT_WRITE_ROLES)
  @ApiOperation({
    summary: 'Update tenant fields',
    description:
      'Only changed fields are written and audited. Status: active <-> hidden, active|hidden -> closed, closed -> active.',
  })
  @ApiOkResponse({ type: TenantAdminDto })
  @ApiProblemResponses(400, 404, 409)
  async update(
    @Param() params: UuidParamDto,
    @Body() body: UpdateTenantDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<TenantAdminDto> {
    const row = await this.tenants.update(params.id, body, { id: adminId, ip });
    return toTenantAdminDto(row, await this.mallInfo.tenantViewContext());
  }

  @Delete(':id')
  @Roles(...CONTENT_WRITE_ROLES)
  @ApiOperation({
    summary: 'Close a tenant (soft delete)',
    description:
      'Sets status closed: the tenant leaves the public directory and stops earning points; history keeps the reference. Reopen with PATCH status=active.',
  })
  @ApiOkResponse({ type: TenantAdminDto })
  @ApiProblemResponses(400, 404)
  async close(
    @Param() params: UuidParamDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<TenantAdminDto> {
    const row = await this.tenants.close(params.id, { id: adminId, ip });
    return toTenantAdminDto(row, await this.mallInfo.tenantViewContext());
  }
}
