import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../../common/auth/auth.decorators';
import { PAYMENT_PROVIDERS } from '../../../common/contracts/payments';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { WebhookAckDto } from '../dto/webhook-ack.dto';
import { PaymentWebhooksService } from '../services/payment-webhooks.service';

/**
 * Provider callbacks (brief section 8): public, signature-checked by the provider adapter,
 * idempotent by the provider's event id. The route limit is higher than the global 60 rpm
 * because providers batch retries; unsigned requests are rejected before any database work.
 */
@ApiTags('payments')
@Controller('webhooks/payments')
export class PaymentWebhooksController {
  constructor(private readonly webhooks: PaymentWebhooksService) {}

  @Post(':provider')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Payment provider webhook',
    description:
      'Verifies the provider signature, logs the callback (unique per provider event id) and applies the status change. ' +
      'Mock provider: JSON body { event_id, provider_ref, status, payment_id?, amount_kopecks?, currency?, paid_at?, failure_code?, refunded_kopecks? } ' +
      'signed with X-Mock-Signature = HMAC-SHA256 hex of the exact request body bytes using PAYMENTS_MOCK_WEBHOOK_SECRET.',
  })
  @ApiParam({ name: 'provider', enum: PAYMENT_PROVIDERS })
  @ApiHeader({
    name: 'X-Mock-Signature',
    required: false,
    description: 'Mock provider signature (hex HMAC-SHA256 of the exact request body bytes)',
  })
  @ApiBody({
    description: 'Provider-specific JSON payload',
    schema: { type: 'object', additionalProperties: true },
  })
  @ApiOkResponse({ type: WebhookAckDto })
  @ApiProblemResponses(400, 401, 404, 429)
  async handle(
    @Param('provider') provider: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: unknown,
    @Req() request: RawBodyRequest<Request>,
  ): Promise<WebhookAckDto> {
    // rawBody is kept by NestFactory.create(..., { rawBody: true }) (src/main.ts); adapters
    // verify the signature over these exact bytes.
    const rawBody = request.rawBody;
    return this.webhooks.handle(provider, { headers, body, ...(rawBody ? { rawBody } : {}) });
  }
}
