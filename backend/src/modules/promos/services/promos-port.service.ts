import { Injectable } from '@nestjs/common';
import type {
  ClaimCheck,
  ClaimValidation,
  EventSummary,
  PromoSummary,
  PromosPort,
} from '../../../common/contracts/promos';
import { EventsService } from './events.service';
import { PromosService } from './promos.service';

/** PROMOS_PORT: the read side other modules (admin, notifications) may use. */
@Injectable()
export class PromosPortService implements PromosPort {
  constructor(
    private readonly promos: PromosService,
    private readonly events: EventsService,
  ) {}

  getPromo(promoId: string): Promise<PromoSummary | null> {
    return this.promos.getPromoSummary(promoId);
  }

  getEvent(eventId: string): Promise<EventSummary | null> {
    return this.events.getEventSummary(eventId);
  }

  validateClaim(check: ClaimCheck): Promise<ClaimValidation> {
    return this.promos.validateClaim(check);
  }
}
