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
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { ParkingWebhookAckDto, toWebhookAckDto } from '../dto/webhook.dto';
import { SessionSyncService } from '../services/session-sync.service';

/**
 * Operator callbacks (brief section 8): public, signature-checked by the provider adapter,
 * repeated deliveries are harmless (same facts, no change). Emulator in dev.
 */
@ApiTags('parking')
@Controller('webhooks/parking')
export class ParkingWebhooksController {
  constructor(private readonly sync: SessionSyncService) {}

  @Post(':provider')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Parking operator webhook',
    description:
      'Emulator format: { eventId, type?, session: { providerRef, plate?, zone?, enteredAt, exitedAt?, ' +
      'paidUntil?, amountPaidKopecks?, amountDueKopecks?, closedReason?, level?, spot? } } signed with ' +
      'X-Parking-Signature = "sha256=" + HMAC-SHA256 hex of the exact request body bytes (PARKING_WEBHOOK_SECRET). ' +
      'Sessions of plates that belong to no member are acknowledged and not stored.',
  })
  @ApiParam({ name: 'provider', example: 'emulator' })
  @ApiHeader({ name: 'X-Parking-Signature', required: true })
  @ApiBody({ schema: { type: 'object', additionalProperties: true } })
  @ApiOkResponse({ type: ParkingWebhookAckDto })
  @ApiProblemResponses(400, 401, 404, 429, 503)
  async handle(
    @Param('provider') provider: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: unknown,
    @Req() request: RawBodyRequest<Request>,
  ): Promise<ParkingWebhookAckDto> {
    // rawBody is kept by NestFactory.create(..., { rawBody: true }) (src/main.ts); the signature
    // is checked over these exact bytes.
    const rawBody = request.rawBody;
    return toWebhookAckDto(
      await this.sync.handleWebhook(provider, { headers, body, ...(rawBody ? { rawBody } : {}) }),
    );
  }
}
