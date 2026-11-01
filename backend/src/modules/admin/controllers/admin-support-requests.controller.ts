import { Body, Controller, Get, Ip, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { ADMIN_ROLE_SETS } from '../domain/roles';
import {
  AdminListSupportRequestsQueryDto,
  AdminSupportRequestDto,
  AdminSupportRequestPageDto,
  UpdateSupportRequestDto,
} from '../dto/support.dto';
import { SupportRequestsService } from '../services/support-requests.service';

@ApiTags('admin')
@Controller('admin/support-requests')
@Auth('admin', ...ADMIN_ROLE_SETS.support)
export class AdminSupportRequestsController {
  constructor(private readonly support: SupportRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'Support requests, newest first (?status=&userId=)' })
  @ApiOkResponse({ type: AdminSupportRequestPageDto })
  @ApiProblemResponses(400)
  list(@Query() query: AdminListSupportRequestsQueryDto): Promise<AdminSupportRequestPageDto> {
    return this.support.listForAdmin(
      { status: query.status, userId: query.userId },
      { cursor: query.cursor, limit: query.limit },
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'One support request with a short-lived photo link' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdminSupportRequestDto })
  @ApiProblemResponses(400, 404)
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminSupportRequestDto> {
    return this.support.getForAdmin(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change the status and/or add a note (audited)',
    description:
      'Moving to resolved or closed records the admin and the time; a closed request is final.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdminSupportRequestDto })
  @ApiProblemResponses(400, 404, 409)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateSupportRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<AdminSupportRequestDto> {
    return this.support.update(id, body, { id: user.id, ip });
  }
}
