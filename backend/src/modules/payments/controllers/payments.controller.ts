import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { ListPaymentsQueryDto } from '../dto/list-payments.query.dto';
import { PaymentDto, PaymentPageDto, toPaymentDto } from '../dto/payment.dto';
import { PaymentsService } from '../services/payments.service';
import { uuidParam } from './uuid.pipe';

/** Member endpoints (brief section 8): payments are created by their purpose module (parking). */
@ApiTags('payments')
@Controller('payments')
@Auth('member')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @ApiOperation({ summary: 'My payments, newest first (parking history, receipts of refunds)' })
  @ApiOkResponse({ type: PaymentPageDto })
  @ApiProblemResponses(400)
  async list(
    @CurrentUser('id') userId: string,
    @Query() query: ListPaymentsQueryDto,
  ): Promise<PaymentPageDto> {
    const page = await this.payments.list({
      userId,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.items.map((item) => toPaymentDto(item, this.payments.receiptOf(item))),
      nextCursor: page.nextCursor,
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Payment status and receipt screen; the app polls it after returning from checkout',
    description:
      'Includes displayNumber, merchantName (the parking operator for parking), parking ' +
      '{ plateDisplay, paidUntil, sessionId } and the signed operatorQrPayload once paid. ' +
      'Receipts are not e-mailed: the app shares fiscalReceiptUrl.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PaymentDto })
  @ApiProblemResponses(400, 404)
  async get(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) id: string,
  ): Promise<PaymentDto> {
    const summary = await this.payments.getPaymentForUser(userId, id);
    return toPaymentDto(summary, this.payments.receiptOf(summary));
  }
}
