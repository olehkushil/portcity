import { Inject, Injectable } from '@nestjs/common';
import {
  IDENTITY_PORT,
  type IdentityPort,
  type MarketingAudiencePage,
} from '../../../common/contracts/identity';

/**
 * Recipients of marketing broadcasts (`promo.published` -> `promo_published`): active members
 * whose latest `marketing` consent is granted, read page by page from IDENTITY_PORT.
 * notify() re-checks the consent and the member's preference for every recipient, so a consent
 * revoked between the page read and the send still wins.
 */
@Injectable()
export class MarketingAudience {
  constructor(@Inject(IDENTITY_PORT) private readonly identity: IdentityPort) {}

  page(cursor: string | null, limit: number): Promise<MarketingAudiencePage> {
    return this.identity.listMarketingAudience(cursor, limit);
  }
}
