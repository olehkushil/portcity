import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PAYMENT_PROVIDERS,
  PAYMENT_PURPOSES,
  PAYMENT_STATUSES,
  type PaymentProvider,
  type PaymentPurpose,
  type PaymentStatus,
  type PaymentSummary,
} from '../../../common/contracts/payments';
import type { PaymentReceiptFields } from '../services/payments.service';

export class PaymentDto {
  @ApiProperty({ format: 'uuid', example: '0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty({ enum: PAYMENT_PURPOSES, example: 'parking' })
  purpose: PaymentPurpose;

  @ApiProperty({ description: 'Amount in kopecks (integer)', example: 6000 })
  amountKopecks: number;

  @ApiProperty({ example: 'UAH' })
  currency: string;

  @ApiProperty({ enum: PAYMENT_PROVIDERS, example: 'mock' })
  provider: PaymentProvider;

  @ApiProperty({ type: String, nullable: true, description: 'Reference at the provider' })
  providerRef: string | null;

  @ApiProperty({ enum: PAYMENT_STATUSES, example: 'created' })
  status: PaymentStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Hosted checkout page to open; null once the payment is no longer open',
  })
  checkoutUrl: string | null;

  @ApiProperty({ type: String, nullable: true })
  fiscalReceiptUrl: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  failureCode: string | null;

  @ApiProperty({ description: 'Cumulative refunded amount in kopecks', example: 0 })
  refundedKopecks: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidAt: string | null;

  @ApiProperty({
    type: Object,
    additionalProperties: true,
    description: 'Business context given by the caller, e.g. { sessionId }',
    example: { sessionId: '0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e22' },
  })
  meta: Record<string, unknown>;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: string;

  @ApiProperty({
    description: 'Short human id for the receipt screen and support calls',
    example: '4F7K-2031',
  })
  displayNumber: string;

  @ApiProperty({
    description: 'Who received the money: the parking operator (ФОП) for parking payments',
    example: 'Оператор паркінгу ТРЦ «Порт City» (ФОП)',
  })
  merchantName: string;

  @ApiProperty({
    type: () => PaymentParkingDto,
    nullable: true,
    description: 'Parking facts for the receipt screen (null for other purposes)',
  })
  parking: PaymentParkingDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Signed QR payload for the parking operator (PCP1.<paymentId>.<sessionId>.<paidUntilUnix>.<amountKopecks>.<sig>); ' +
      'only for paid parking payments. Receipts are not e-mailed: the app shares fiscalReceiptUrl.',
  })
  operatorQrPayload: string | null;
}

export class PaymentParkingDto {
  @ApiProperty({ type: String, nullable: true, example: 'AC 1234 BC' })
  plateDisplay: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: '«Виїзд до»' })
  paidUntil: string | null;

  @ApiProperty({ format: 'uuid' })
  sessionId: string;
}

export function toPaymentDto(summary: PaymentSummary, receipt: PaymentReceiptFields): PaymentDto {
  return {
    id: summary.id,
    userId: summary.userId,
    purpose: summary.purpose,
    amountKopecks: summary.amountKopecks,
    currency: summary.currency,
    provider: summary.provider,
    providerRef: summary.providerRef,
    status: summary.status,
    checkoutUrl: summary.checkoutUrl,
    fiscalReceiptUrl: summary.fiscalReceiptUrl,
    failureCode: summary.failureCode,
    refundedKopecks: summary.refundedKopecks,
    paidAt: summary.paidAt ? summary.paidAt.toISOString() : null,
    meta: summary.meta,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
    displayNumber: receipt.displayNumber,
    merchantName: receipt.merchantName,
    parking: receipt.parking
      ? {
          plateDisplay: receipt.parking.plateDisplay,
          paidUntil: receipt.parking.paidUntil ? receipt.parking.paidUntil.toISOString() : null,
          sessionId: receipt.parking.sessionId,
        }
      : null,
    operatorQrPayload: receipt.operatorQrPayload,
  };
}

export class PaymentPageDto {
  @ApiProperty({ type: [PaymentDto] })
  items: PaymentDto[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Pass as ?cursor= for the next page',
  })
  nextCursor: string | null;
}
