import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import {
  MOCK_CHECKOUT_OUTCOMES,
  type MockCheckoutOutcome,
} from '../services/mock-checkout.service';
import { WebhookAckDto } from './webhook-ack.dto';

export class CompleteMockCheckoutDto {
  @ApiProperty({ enum: MOCK_CHECKOUT_OUTCOMES, example: 'succeeded' })
  @IsIn(MOCK_CHECKOUT_OUTCOMES)
  outcome: MockCheckoutOutcome;

  @ApiPropertyOptional({
    example: 'card_declined',
    description: 'Failure code reported by the simulated provider when outcome = failed',
  })
  @IsOptional()
  @Matches(/^[a-z0-9_]{1,50}$/)
  failureCode?: string;
}

export class MockCheckoutResultDto {
  @ApiProperty({ example: 'mock_01900000-0000-7000-8000-000000000001' })
  providerRef: string;

  @ApiProperty({ format: 'uuid' })
  paymentId: string;

  @ApiProperty({ enum: MOCK_CHECKOUT_OUTCOMES })
  outcome: MockCheckoutOutcome;

  @ApiProperty({ type: WebhookAckDto, description: 'Answer of POST /webhooks/payments/mock' })
  webhook: WebhookAckDto;

  @ApiProperty({ example: 'portcity://payments/return' })
  returnUrl: string;
}
