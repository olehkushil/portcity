import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
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
import { Idempotent } from '../../../common/idempotency/idempotency.decorator';
import { ADMIN_ROLE_SETS } from '../domain/roles';
import {
  AdjustmentDto,
  AdjustmentPageDto,
  CreateAdjustmentDto,
  ListAdjustmentsQueryDto,
  RejectAdjustmentDto,
} from '../dto/adjustments.dto';
import { AdjustmentsService } from '../services/adjustments.service';

@ApiTags('admin')
@Controller('admin/adjustments')
export class AdjustmentsController {
  constructor(private readonly adjustments: AdjustmentsService) {}

  @Post()
  @Auth('admin', ...ADMIN_ROLE_SETS.adjustmentRequest)
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Request a manual points adjustment',
    description:
      'Applied immediately while the absolute amount and the cumulative self-approved totals (requester per Kyiv day, target account per rolling 24 h) stay within 500 points. Otherwise it stays pending (secondApprovalReason) until a different admin approves it (four eyes). Negative amounts go through the ledger spend rules.',
  })
  @ApiCreatedResponse({ type: AdjustmentDto })
  @ApiProblemResponses(404, 422)
  async create(
    @Body() body: CreateAdjustmentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<AdjustmentDto> {
    return this.adjustments.request(body, { id: user.id, ip });
  }

  @Get()
  @Auth('admin', ...ADMIN_ROLE_SETS.read)
  @ApiOperation({ summary: 'List manual adjustments, newest first' })
  @ApiOkResponse({ type: AdjustmentPageDto })
  @ApiProblemResponses(400)
  async list(@Query() query: ListAdjustmentsQueryDto): Promise<AdjustmentPageDto> {
    return this.adjustments.list(
      { status: query.status, userId: query.userId },
      { cursor: query.cursor, limit: query.limit },
    );
  }

  @Get(':id')
  @Auth('admin', ...ADMIN_ROLE_SETS.read)
  @ApiOperation({ summary: 'Get one manual adjustment' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdjustmentDto })
  @ApiProblemResponses(400, 404)
  async get(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdjustmentDto> {
    return this.adjustments.get(id);
  }

  @Post(':id/approve')
  @Auth('admin', ...ADMIN_ROLE_SETS.adjustmentDecision)
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a pending adjustment (second pair of eyes) and apply it',
    description:
      'The approver must differ from the requester. Approval is committed first; if the ledger refuses the write the row stays approved and the error is returned, so apply can be retried.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdjustmentDto })
  @ApiProblemResponses(404, 409, 422)
  async approve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<AdjustmentDto> {
    return this.adjustments.approve(id, { id: user.id, ip });
  }

  @Post(':id/apply')
  @Auth('admin', ...ADMIN_ROLE_SETS.adjustmentDecision)
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry the ledger write of an approved adjustment' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdjustmentDto })
  @ApiProblemResponses(404, 409, 422)
  async apply(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<AdjustmentDto> {
    return this.adjustments.apply(id, { id: user.id, ip });
  }

  @Post(':id/reject')
  @Auth('admin', ...ADMIN_ROLE_SETS.adjustmentDecision)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a pending or approved-but-unapplied adjustment' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdjustmentDto })
  @ApiProblemResponses(400, 404, 409)
  async reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RejectAdjustmentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<AdjustmentDto> {
    return this.adjustments.reject(id, body.reason, { id: user.id, ip });
  }
}
