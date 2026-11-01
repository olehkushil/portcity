import { Body, Controller, Get, Ip, Param, Patch, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { AdminUserListDto, CreateAdminUserDto, UpdateAdminUserDto } from '../dto/admin.dto';
import { AdminUserDto } from '../dto/common.dto';
import { AdminStaffService } from '../services/admin-staff.service';
import { clientIp, uuidParam } from './params';

/**
 * Back-office accounts (owner only); deactivate instead of delete. The shared AdminGuard
 * refuses tokens of deactivated admins and of admins whose role changed (AdminAccessGate).
 */
@ApiTags('admin')
@Controller('admin/admin-users')
@Auth('admin', 'owner')
export class AdminStaffController {
  constructor(private readonly staff: AdminStaffService) {}

  @Get()
  @ApiOperation({ summary: 'All back-office accounts' })
  @ApiOkResponse({ type: AdminUserListDto })
  async list(): Promise<AdminUserListDto> {
    return this.staff.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a back-office account (password min. 12 characters)' })
  @ApiCreatedResponse({ type: AdminUserDto })
  @ApiProblemResponses(400, 409)
  async create(
    @Body() body: CreateAdminUserDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string | undefined,
  ): Promise<AdminUserDto> {
    return this.staff.create(
      {
        email: body.email,
        password: body.password,
        role: body.role,
        ...(body.name !== undefined ? { name: body.name } : {}),
      },
      { id: adminId, ip: clientIp(ip) },
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change role, name, password or activity of a back-office account',
    description:
      '422 PC_ADMIN_LAST_OWNER protects the last active owner; 422 PC_ADMIN_SELF_ACTION forbids deactivating or demoting yourself.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdminUserDto })
  @ApiProblemResponses(400, 404, 422)
  async update(
    @Param('id', uuidParam()) id: string,
    @Body() body: UpdateAdminUserDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string | undefined,
  ): Promise<AdminUserDto> {
    return this.staff.update(id, body, { id: adminId, ip: clientIp(ip) });
  }
}
