import { Inject, Injectable } from '@nestjs/common';
import {
  FEATURE_FLAGS_PORT,
  FEATURE_FLAG_KEYS,
  type FeatureFlagsPort,
} from '../../../common/contracts/admin';
import { type AirRaidAlert, parseAirRaidFlag } from '../domain/air-raid';
import { PARKING_CONFIG, type ParkingConfig } from '../parking.config';

/**
 * Air-raid alert source for Release 1: the feature flag FEATURE_FLAG_KEYS.parkingAirRaid
 * (`parking.air_raid`, seeded disabled) that the duty officer
 * switches in the back office (design brief 4.3, open question 4). A public alert API can replace
 * this class later without touching the session logic.
 */
@Injectable()
export class AirRaidService {
  constructor(
    @Inject(FEATURE_FLAGS_PORT) private readonly flags: FeatureFlagsPort,
    @Inject(PARKING_CONFIG) private readonly config: ParkingConfig,
  ) {}

  async current(): Promise<AirRaidAlert | null> {
    const flag = await this.flags.get(FEATURE_FLAG_KEYS.parkingAirRaid);
    return parseAirRaidFlag(flag, this.config.PARKING_AIR_RAID_FREE_EXIT_MINUTES);
  }
}
