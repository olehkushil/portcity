import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { PaymentWebhookLog } from '@prisma/client';
import {
  PAYMENT_PROVIDERS,
  type PaymentProvider,
  type PaymentSummary,
} from '../../../common/contracts/payments';
import type { InternalMeta } from '../services/payment.mapper';
import type { PaymentReceiptFields, ReconcileOutcome } from '../services/payments.service';
import { PaymentDto, toPaymentDto } from './payment.dto';

export class PaymentWebhookLogDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: PAYMENT_PROVIDERS })
  provider: PaymentProvider;

  @ApiProperty({ description: 'Provider-side notification id (unique per provider)' })
  externalId: string;

  @ApiProperty({ type: String, format: 'date-time' })
  receivedAt: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  processedAt: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'transitioned:pending->succeeded' })
  result: string | null;

  @ApiProperty({ type: Object, additionalProperties: true, description: 'Payload as received' })
  payload: unknown;
}

export function toWebhookLogDto(row: PaymentWebhookLog): PaymentWebhookLogDto {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.externalId,
    receivedAt: row.receivedAt.toISOString(),
    processedAt: row.processedAt ? row.processedAt.toISOString() : null,
    result: row.result,
    payload: row.payload,
  };
}

export class AdminPaymentDetailDto {
  @ApiProperty({ type: PaymentDto })
  payment: PaymentDto;

  @ApiProperty({
    type: Object,
    additionalProperties: true,
    description:
      'Module bookkeeping: description, returnUrl, refunds history, pending refund, fiscalisation state, last provider event',
  })
  internal: InternalMeta;

  @ApiProperty({ type: [PaymentWebhookLogDto] })
  webhooks: PaymentWebhookLogDto[];
}

export const RECONCILE_ACTIONS = ['skipped', 'applied', 'expired'] as const;

export class ReconcileResultDto {
  @ApiProperty({ enum: RECONCILE_ACTIONS })
  action: (typeof RECONCILE_ACTIONS)[number];

  @ApiPropertyOptional({
    description:
      'Why nothing changed (too_young, not_open, provider_unavailable, ...) or the applied outcome',
    example: 'transitioned:pending->succeeded',
  })
  detail?: string;

  @ApiProperty({ type: PaymentDto })
  payment: PaymentDto;
}

export function toReconcileResultDto(
  outcome: ReconcileOutcome,
  describe: (outcome: Extract<ReconcileOutcome, { outcome: unknown }>['outcome']) => string,
  receiptOf: (payment: PaymentSummary) => PaymentReceiptFields,
): ReconcileResultDto {
  const payment = toPaymentDto(outcome.payment, receiptOf(outcome.payment));
  if (outcome.action === 'skipped') {
    return { action: 'skipped', detail: outcome.reason, payment };
  }
  return { action: outcome.action, detail: describe(outcome.outcome), payment };
}
