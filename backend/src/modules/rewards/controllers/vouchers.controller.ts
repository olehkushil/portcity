import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { Idempotent } from '../../../common/idempotency/idempotency.decorator';
import {
  ActivateVoucherResponseDto,
  CancelVoucherDto,
  VoucherDto,
  VoucherListQueryDto,
  VoucherPageDto,
  VoucherSummaryDto,
} from '../dto/voucher.dto';
import { VoucherService } from '../services/voucher.service';
import { uuidParam } from './uuid.pipe';

/**
 * Member wallet (brief sections 6-8): reward vouchers, promo coupons, event tickets and
 * certificates; activation issues a 6-character code and a signed token valid for 120 s.
 */
@ApiTags('vouchers')
@Controller('vouchers')
@Auth('member')
export class VouchersController {
  constructor(private readonly vouchers: VoucherService) {}

  @Get()
  @ApiOperation({
    summary: 'My vouchers, newest first',
    description:
      'status takes one or several effective statuses, comma separated (status=issued,active). The status is effective: a lapsed activation reads as issued, a passed expiresAt as expired, even before the minute sweep runs.',
  })
  @ApiOkResponse({ type: VoucherPageDto })
  @ApiProblemResponses(400)
  list(
    @CurrentUser('id') userId: string,
    @Query() query: VoucherListQueryDto,
  ): Promise<VoucherPageDto> {
    return this.vouchers.listForUser(userId, {
      statuses: query.status,
      kind: query.kind,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get('summary')
  @ApiOperation({
    summary: 'Counts of my vouchers per effective status',
    description: 'live = issued + active, the number on the "Мої ваучери (N)" badge.',
  })
  @ApiOkResponse({ type: VoucherSummaryDto })
  summary(@CurrentUser('id') userId: string): Promise<VoucherSummaryDto> {
    return this.vouchers.summaryForUser(userId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Voucher detail; the code is present only while the activation is live',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: VoucherDto })
  @ApiProblemResponses(400, 404)
  get(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) voucherId: string,
  ): Promise<VoucherDto> {
    return this.vouchers.getForUser(userId, voucherId);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Activate the voucher at the counter',
    description:
      'Returns a 6-character code (alphabet 23456789ABCDEFGHJKLMNPQRSTUVWXYZ) and a signed token for the QR, valid for 120 seconds. Repeating the call inside the window returns the same code; after it lapses a new code is issued while the voucher itself has not expired.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ActivateVoucherResponseDto })
  @ApiProblemResponses(400, 404, 409, 422, 429, 503)
  activate(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) voucherId: string,
  ): Promise<ActivateVoucherResponseDto> {
    return this.vouchers.activate(userId, voucherId);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: 'Cancel an unused voucher',
    description:
      'issued or active -> cancelled. Vouchers bought with points return the points to the balance (refund row in the ledger) and the stock unit to the reward. Requires Idempotency-Key.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: VoucherDto })
  @ApiProblemResponses(400, 404, 409, 422)
  cancel(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) voucherId: string,
    @Body() body: CancelVoucherDto,
  ): Promise<VoucherDto> {
    return this.vouchers.cancelForMember(userId, voucherId, body.reason);
  }
}
