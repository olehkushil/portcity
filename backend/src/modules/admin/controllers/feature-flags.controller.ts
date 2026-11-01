import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Put,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { ADMIN_ROLE_SETS } from '../domain/roles';
import { FeatureFlagDto, FeatureFlagListDto, UpsertFeatureFlagDto } from '../dto/feature-flags.dto';
import { FeatureFlagsAdminService } from '../services/feature-flags-admin.service';

@ApiTags('admin')
@Controller('admin/feature-flags')
export class FeatureFlagsController {
  constructor(private readonly flags: FeatureFlagsAdminService) {}

  @Get()
  @Auth('admin', ...ADMIN_ROLE_SETS.read)
  @ApiOperation({ summary: 'List feature flags' })
  @ApiOkResponse({ type: FeatureFlagListDto })
  async list(): Promise<FeatureFlagListDto> {
    return { items: await this.flags.list() };
  }

  @Get(':key')
  @Auth('admin', ...ADMIN_ROLE_SETS.read)
  @ApiOperation({ summary: 'Get one feature flag' })
  @ApiParam({ name: 'key', example: 'parking.info_mode' })
  @ApiOkResponse({ type: FeatureFlagDto })
  @ApiProblemResponses(400, 404)
  async get(@Param('key') key: string): Promise<FeatureFlagDto> {
    return this.flags.get(key);
  }

  @Put(':key')
  @Auth('admin', ...ADMIN_ROLE_SETS.flagWrite)
  @ApiOperation({
    summary: 'Create or update a feature flag',
    description:
      'Audited and published as flag.updated. Readers cache flags for 5 seconds, so other API replicas follow shortly after.',
  })
  @ApiParam({ name: 'key', example: 'parking.info_mode' })
  @ApiOkResponse({ type: FeatureFlagDto })
  @ApiProblemResponses(400)
  async upsert(
    @Param('key') key: string,
    @Body() body: UpsertFeatureFlagDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<FeatureFlagDto> {
    return this.flags.upsert(key, body, { id: user.id, ip });
  }

  @Delete(':key')
  @Auth('admin', ...ADMIN_ROLE_SETS.flagWrite)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a feature flag (readers fall back to their defaults)' })
  @ApiParam({ name: 'key', example: 'parking.info_mode' })
  @ApiNoContentResponse()
  @ApiProblemResponses(400, 404)
  async remove(
    @Param('key') key: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<void> {
    await this.flags.remove(key, { id: user.id, ip });
  }
}
