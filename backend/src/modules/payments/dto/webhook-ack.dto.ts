import { ApiProperty } from '@nestjs/swagger';
import { PAYMENT_STATUSES, type PaymentStatus } from '../../../common/contracts/payments';

export const WEBHOOK_RESULTS = ['processed', 'duplicate', 'ignored'] as const;
export type WebhookResult = (typeof WEBHOOK_RESULTS)[number];

/** Answer to a provider callback; always 200 once the signature and the payment are known. */
export class WebhookAckDto {
  @ApiProperty({ example: true })
  received: true;

  @ApiProperty({
    enum: WEBHOOK_RESULTS,
    description:
      'processed: status changed; duplicate: already received or no change; ignored: stale or conflicting event (kept in the log)',
  })
  result: WebhookResult;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  paymentId: string | null;

  @ApiProperty({ enum: PAYMENT_STATUSES, nullable: true, type: String })
  status: PaymentStatus | null;

  @ApiProperty({ example: 'transitioned:pending->succeeded' })
  detail: string;
}
