import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser, Roles } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { Idempotent } from '../../../common/idempotency/idempotency.decorator';
import {
  AdminListReceiptsQueryDto,
  ApproveReceiptDto,
  RejectReceiptDto,
} from '../dto/receipt-requests.dto';
import { AdminReceiptDetailDto, AdminReceiptPageDto } from '../dto/receipt-responses.dto';
import { ReceiptModerationService } from '../services/receipt-moderation.service';

/**
 * Receipt moderation in the back office (brief section 8). Reading is open to moderators,
 * managers and support (owner passes every role check); decisions to moderators and managers.
 * Every decision and every detail view is written to the audit log.
 */
@ApiTags('admin')
@Controller('admin/receipts')
@Auth('admin', 'moderator', 'manager', 'support')
export class AdminReceiptsController {
  constructor(private readonly moderation: ReceiptModerationService) {}

  @Get()
  @ApiOperation({
    summary: 'Receipts by status (moderation queue: needs_moderation, appealed; oldest first)',
  })
  @ApiOkResponse({ type: AdminReceiptPageDto })
  @ApiProblemResponses(400)
  list(@Query() query: AdminListReceiptsQueryDto): Promise<AdminReceiptPageDto> {
    return this.moderation.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Receipt with risk flags, history, appeals and a signed photo URL (audited view)',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdminReceiptDetailDto })
  @ApiProblemResponses(400, 404)
  get(
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AdminReceiptDetailDto> {
    return this.moderation.view({ adminId, ip: ip ?? null }, id);
  }

  @Post(':id/approve')
  @Roles('moderator', 'manager')
  @Idempotent()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve a receipt in moderation and credit its points',
    description:
      'needs_moderation or appealed -> approved -> credited. A manual receipt submitted without the cash register number needs `fn` (read from the photo; canonicalised, a duplicate answers 409 PC_RECEIPT_DUPLICATE). If the ledger is unavailable the receipt stays approved and the receipts-process job credits it.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdminReceiptDetailDto })
  @ApiProblemResponses(400, 404, 409)
  approve(
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ApproveReceiptDto,
  ): Promise<AdminReceiptDetailDto> {
    return this.moderation.approve({ adminId, ip: ip ?? null }, id, body);
  }

  @Post(':id/reject')
  @Roles('moderator', 'manager')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reject a receipt in moderation with a reason shown to the member',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdminReceiptDetailDto })
  @ApiProblemResponses(400, 404, 409)
  reject(
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RejectReceiptDto,
  ): Promise<AdminReceiptDetailDto> {
    return this.moderation.reject({ adminId, ip: ip ?? null }, id, body);
  }
}
