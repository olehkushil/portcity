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
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { AdminRewardListQueryDto, CreateRewardDto, UpdateRewardDto } from '../dto/admin-reward.dto';
import { AdminReasonQueryDto } from '../dto/admin-validator-device.dto';
import { RewardDto, RewardPageDto } from '../dto/reward.dto';
import { RewardsCatalogueService } from '../services/rewards-catalogue.service';
import { uuidParam } from './uuid.pipe';

/**
 * Back-office reward catalogue (`/admin/rewards`, FOUNDATION_SUMMARY section 10). Rewards are
 * never deleted because redemptions reference them: DELETE deactivates. Every mutation is
 * audited through ADMIN_AUDIT_PORT.
 */
@ApiTags('admin')
@Controller('admin/rewards')
@Auth('admin', 'owner', 'manager')
export class AdminRewardsController {
  constructor(private readonly catalogue: RewardsCatalogueService) {}

  @Get()
  @ApiOperation({ summary: 'All rewards (any status), ordered by sortOrder' })
  @ApiOkResponse({ type: RewardPageDto })
  @ApiProblemResponses(400)
  list(@Query() query: AdminRewardListQueryDto): Promise<RewardPageDto> {
    return this.catalogue.listForAdmin({
      active: query.active,
      kind: query.kind,
      tenantId: query.tenantId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Reward detail' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: RewardDto })
  @ApiProblemResponses(400, 404)
  get(@Param('id', uuidParam()) rewardId: string): Promise<RewardDto> {
    return this.catalogue.getForAdmin(rewardId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a reward' })
  @ApiCreatedResponse({ type: RewardDto })
  @ApiProblemResponses(400)
  create(
    @Body() body: CreateRewardDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<RewardDto> {
    return this.catalogue.create(body, { actor: { type: 'admin', id: admin.id }, ip });
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a reward (only the fields sent)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: RewardDto })
  @ApiProblemResponses(400, 404)
  update(
    @Param('id', uuidParam()) rewardId: string,
    @Body() body: UpdateRewardDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<RewardDto> {
    return this.catalogue.update(rewardId, body, { actor: { type: 'admin', id: admin.id }, ip });
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Deactivate a reward (soft delete; issued vouchers stay valid)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: RewardDto })
  @ApiProblemResponses(400, 404)
  deactivate(
    @Param('id', uuidParam()) rewardId: string,
    @Query() query: AdminReasonQueryDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<RewardDto> {
    return this.catalogue.deactivate(rewardId, {
      actor: { type: 'admin', id: admin.id },
      ip,
      reason: query.reason ?? null,
    });
  }
}
