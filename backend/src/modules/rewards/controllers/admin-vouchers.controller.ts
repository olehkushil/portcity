import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
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
import { Auth, CurrentUser, Roles } from '../../../common/auth/auth.decorators';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { Idempotent } from '../../../common/idempotency/idempotency.decorator';
import {
  AdminCancelVoucherDto,
  AdminIssueVoucherDto,
  AdminVoucherListQueryDto,
} from '../dto/admin-voucher.dto';
import { VoucherDto, VoucherPageDto } from '../dto/voucher.dto';
import { AdminVouchersService } from '../services/admin-vouchers.service';
import { uuidParam } from './uuid.pipe';

/**
 * Back-office vouchers (`/admin/vouchers`): search across members (support), goodwill
 * vouchers and cancellations with the points rule (owner, manager). Mutations are audited.
 */
@ApiTags('admin')
@Controller('admin/vouchers')
@Auth('admin', 'owner', 'manager', 'support')
export class AdminVouchersController {
  constructor(private readonly vouchers: AdminVouchersService) {}

  @Get()
  @ApiOperation({
    summary: 'Vouchers across members with filters, newest first (effective status)',
  })
  @ApiOkResponse({ type: VoucherPageDto })
  @ApiProblemResponses(400)
  list(@Query() query: AdminVoucherListQueryDto): Promise<VoucherPageDto> {
    return this.vouchers.list({
      userId: query.userId,
      statuses: query.status,
      kind: query.kind,
      tenantId: query.tenantId,
      sourceType: query.sourceType,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Voucher detail' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: VoucherDto })
  @ApiProblemResponses(400, 404)
  get(@Param('id', uuidParam()) voucherId: string): Promise<VoucherDto> {
    return this.vouchers.get(voucherId);
  }

  @Post()
  @Roles('owner', 'manager')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @ApiOperation({
    summary: 'Issue a voucher to a member on behalf of the mall (sourceType admin)',
    description: 'Goodwill gifts and certificates; requires Idempotency-Key.',
  })
  @ApiCreatedResponse({ type: VoucherDto })
  @ApiProblemResponses(400)
  issue(
    @Body() body: AdminIssueVoucherDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<VoucherDto> {
    return this.vouchers.issue(
      {
        userId: body.userId,
        kind: body.kind,
        title: body.title,
        subtitle: body.subtitle,
        tenantId: body.tenantId,
        expiresAt: body.expiresAt,
        meta: body.meta,
        reason: body.reason,
      },
      { actor: { type: 'admin', id: admin.id }, ip },
    );
  }

  @Post(':id/cancel')
  @Roles('owner', 'manager')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: 'Cancel a live voucher',
    description:
      'issued or active -> cancelled. Points of a reward voucher are returned unless refundPoints is false (abuse). Requires Idempotency-Key.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: VoucherDto })
  @ApiProblemResponses(400, 404, 409, 422)
  cancel(
    @Param('id', uuidParam()) voucherId: string,
    @Body() body: AdminCancelVoucherDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<VoucherDto> {
    return this.vouchers.cancel(
      voucherId,
      { reason: body.reason, refundPoints: body.refundPoints },
      { actor: { type: 'admin', id: admin.id }, ip },
    );
  }
}
