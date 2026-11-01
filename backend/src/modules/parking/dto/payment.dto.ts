import { ApiProperty } from '@nestjs/swagger';
import {
  PAYMENT_PROVIDERS,
  PAYMENT_STATUSES,
  type PaymentProvider,
  type PaymentStatus,
} from '../../../common/contracts/payments';
import type { ParkingPaymentView } from '../services/parking-payments.service';
import { ChargeLineDto, toChargeLines } from './session.dto';

export class ParkingPaymentInfoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: PAYMENT_STATUSES, example: 'created' })
  status: PaymentStatus;

  @ApiProperty({ enum: PAYMENT_PROVIDERS, example: 'mock' })
  provider: PaymentProvider;

  @ApiProperty({ example: 6000 })
  amountKopecks: number;

  @ApiProperty({ example: 'UAH' })
  currency: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Hosted checkout page to open (Apple Pay / Google Pay / card)',
  })
  checkoutUrl: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
}

export class ParkingPaymentDto {
  @ApiProperty({ format: 'uuid' })
  sessionId: string;

  @ApiProperty({ example: 6000 })
  amountKopecks: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: '«Після оплати — виїзд до 16:00»: the exit deadline this payment buys',
  })
  paidUntil: string;

  @ApiProperty({
    description:
      'True when fewer than PARKING_PAY_MIN_MINUTES_LEFT (5) minutes were left in the running hour, so the next hour is charged too',
  })
  includesNextHour: boolean;

  @ApiProperty({ type: [ChargeLineDto] })
  breakdown: ChargeLineDto[];

  @ApiProperty({ type: ParkingPaymentInfoDto })
  payment: ParkingPaymentInfoDto;
}

export function toParkingPaymentDto(view: ParkingPaymentView): ParkingPaymentDto {
  return {
    sessionId: view.sessionId,
    amountKopecks: view.amountKopecks,
    paidUntil: view.paidUntil.toISOString(),
    includesNextHour: view.includesNextHour,
    breakdown: toChargeLines(view.breakdown),
    payment: {
      id: view.payment.id,
      status: view.payment.status,
      provider: view.payment.provider,
      amountKopecks: view.payment.amountKopecks,
      currency: view.payment.currency,
      checkoutUrl: view.payment.checkoutUrl,
      createdAt: view.payment.createdAt.toISOString(),
    },
  };
}
