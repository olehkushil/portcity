import { Body, Controller, Get, HttpCode, Ip, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser, Roles } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import {
  AdminMemberDto,
  AdminUserDetailsDto,
  AdminUserPageDto,
  AdminUsersQueryDto,
  BlockUserDto,
  RevokeSessionsResponseDto,
} from '../dto/admin.dto';
import { AdminUsersService } from '../services/admin-users.service';
import { clientIp, uuidParam } from './params';

/**
 * Member lookup for the back office (`/admin/users`, hosted by identity as the table owner).
 * Owner, manager, support and moderator may search and open a member card (phones masked,
 * opening a card is audited); blocking is for owner and manager; ending sessions also for support.
 */
@ApiTags('admin')
@Controller('admin/users')
@Auth('admin', 'owner', 'manager', 'support', 'moderator')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @ApiOperation({
    summary: 'Search members by phone (any notation), member code, e-mail or name',
    description: 'Newest first, cursor pagination. Phones in the response are masked.',
  })
  @ApiOkResponse({ type: AdminUserPageDto })
  @ApiProblemResponses(400)
  async search(@Query() query: AdminUsersQueryDto): Promise<AdminUserPageDto> {
    return this.users.search({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Member card: profile (masked phone), devices, consents, sessions' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdminUserDetailsDto })
  @ApiProblemResponses(400, 404)
  async details(
    @Param('id', uuidParam()) id: string,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string | undefined,
  ): Promise<AdminUserDetailsDto> {
    return this.users.getDetails(id, { id: adminId, ip: clientIp(ip) });
  }

  @Post(':id/block')
  @HttpCode(200)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Block a member (sessions revoked, user.blocked published)',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdminMemberDto })
  @ApiProblemResponses(400, 404, 409)
  async block(
    @Param('id', uuidParam()) id: string,
    @Body() body: BlockUserDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string | undefined,
  ): Promise<AdminMemberDto> {
    return this.users.block(id, body.reason, { id: adminId, ip: clientIp(ip) });
  }

  @Post(':id/unblock')
  @HttpCode(200)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Unblock a member' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdminMemberDto })
  @ApiProblemResponses(400, 404, 409)
  async unblock(
    @Param('id', uuidParam()) id: string,
    @Body() body: BlockUserDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string | undefined,
  ): Promise<AdminMemberDto> {
    return this.users.unblock(id, body.reason, { id: adminId, ip: clientIp(ip) });
  }

  @Post(':id/revoke-sessions')
  @HttpCode(200)
  @Roles('owner', 'manager', 'support')
  @ApiOperation({ summary: 'Log the member out on every device (lost phone, takeover)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: RevokeSessionsResponseDto })
  @ApiProblemResponses(400, 404)
  async revokeSessions(
    @Param('id', uuidParam()) id: string,
    @Body() body: BlockUserDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string | undefined,
  ): Promise<RevokeSessionsResponseDto> {
    return this.users.revokeSessions(id, body.reason, { id: adminId, ip: clientIp(ip) });
  }
}
