import { Body, Controller, Get, HttpCode, Ip, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser, Roles } from '../../../common/auth/auth.decorators';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { Idempotent } from '../../../common/idempotency/idempotency.decorator';
import {
  AdminPaymentDetailDto,
  ReconcileResultDto,
  toReconcileResultDto,
  toWebhookLogDto,
} from '../dto/admin-payment.dto';
import { AdminListPaymentsQueryDto } from '../dto/list-payments.query.dto';
import { PaymentDto, PaymentPageDto, toPaymentDto } from '../dto/payment.dto';
import { RefundPaymentDto } from '../dto/refund-payment.dto';
import { PaymentsService, describeOutcome } from '../services/payments.service';
import { uuidParam } from './uuid.pipe';

/**
 * Back-office endpoints hosted by the table owner (FOUNDATION_SUMMARY section 10):
 * `/admin/payments` list and detail for owner, manager and support; refunds for owner and
 * manager (four eyes are not required: the amount is bounded by the payment); every mutation
 * is audited through ADMIN_AUDIT_PORT.
 */
@ApiTags('admin')
@Controller('admin/payments')
@Auth('admin', 'owner', 'manager', 'support')
export class AdminPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @ApiOperation({ summary: 'Payments across members with filters (newest first)' })
  @ApiOkResponse({ type: PaymentPageDto })
  @ApiProblemResponses(400)
  async list(@Query() query: AdminListPaymentsQueryDto): Promise<PaymentPageDto> {
    const page = await this.payments.list({
      userId: query.userId,
      status: query.status,
      provider: query.provider,
      purpose: query.purpose,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.items.map((item) => toPaymentDto(item, this.payments.receiptOf(item))),
      nextCursor: page.nextCursor,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Payment with bookkeeping and the provider webhook log' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AdminPaymentDetailDto })
  @ApiProblemResponses(400, 404)
  async detail(@Param('id', uuidParam()) id: string): Promise<AdminPaymentDetailDto> {
    const detail = await this.payments.getAdminDetail(id);
    return {
      payment: toPaymentDto(detail.payment, this.payments.receiptOf(detail.payment)),
      internal: detail.internal,
      webhooks: detail.webhooks.map(toWebhookLogDto),
    };
  }

  @Post(':id/refund')
  @Roles('owner', 'manager')
  @Idempotent()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Refund a captured payment (full or partial) through the provider',
    description:
      'Allowed from succeeded, fiscalized and partially_refunded. The amount is reserved under the row lock before the provider call ' +
      '(409 PC_PAYMENT_REFUND_IN_PROGRESS while another refund is unfinished; an interrupted one is resumed with the same provider idempotency key). ' +
      'Publishes payment.refunded (audit only).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PaymentDto })
  @ApiProblemResponses(400, 404, 409, 422, 502)
  async refund(
    @Param('id', uuidParam()) id: string,
    @Body() body: RefundPaymentDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<PaymentDto> {
    const summary = await this.payments.refund(id, {
      amountKopecks: body.amountKopecks ?? null,
      reason: body.reason,
      actor: { type: 'admin', id: admin.id },
      ip,
    });
    return toPaymentDto(summary, this.payments.receiptOf(summary));
  }

  @Post(':id/reconcile')
  @Roles('owner', 'manager', 'support')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Ask the provider for the current status of an open payment now',
    description:
      'Support tool for "I paid but the barrier did not open": applies the provider answer immediately instead of waiting for the hourly job; ' +
      'abandoned checkouts are cancelled at the provider first and expire only when the provider confirms (or does not know them).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ReconcileResultDto })
  @ApiProblemResponses(400, 404, 409)
  async reconcile(
    @Param('id', uuidParam()) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<ReconcileResultDto> {
    const outcome = await this.payments.reconcilePayment(id, {
      force: true,
      actor: { type: 'admin', id: admin.id },
      ip,
    });
    return toReconcileResultDto(outcome, describeOutcome, (payment) =>
      this.payments.receiptOf(payment),
    );
  }
}
