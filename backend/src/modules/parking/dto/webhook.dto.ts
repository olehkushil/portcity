import { ApiProperty } from '@nestjs/swagger';
import {
  PARKING_SESSION_STATUSES,
  type ParkingSessionStatus,
} from '../../../common/contracts/parking';
import type { WebhookOutcome } from '../services/session-sync.service';

export class ParkingWebhookAckDto {
  @ApiProperty({ example: true })
  received: boolean;

  @ApiProperty({ example: 'evt-1' })
  eventId: string;

  @ApiProperty({ example: 'session.updated' })
  type: string;

  @ApiProperty({ description: 'False when the plate belongs to no member (nothing stored)' })
  tracked: boolean;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  sessionId: string | null;

  @ApiProperty({ enum: PARKING_SESSION_STATUSES, nullable: true })
  status: ParkingSessionStatus | null;

  @ApiProperty({ description: 'False for a repeated delivery of the same facts' })
  changed: boolean;

  @ApiProperty({
    description:
      'True when this provider event id was handled before (acknowledged, not re-applied)',
  })
  duplicate: boolean;
}

export function toWebhookAckDto(outcome: WebhookOutcome): ParkingWebhookAckDto {
  return { received: true, ...outcome };
}
