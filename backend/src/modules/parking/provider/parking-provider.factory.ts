import type { FactoryProvider } from '@nestjs/common';
import { Clock } from '../../../common/time/clock';
import { PARKING_CONFIG, type ParkingConfig } from '../parking.config';
import { EmulatorParkingProvider } from './emulator.provider';
import { ParkingProviderPort } from './parking-provider.port';
import { VendorParkingProvider } from './vendor.provider';

/** Picks the provider adapter from configuration (PARKING_PROVIDER). */
export function createParkingProvider(config: ParkingConfig, clock: Clock): ParkingProviderPort {
  switch (config.PARKING_PROVIDER) {
    case 'emulator':
      return new EmulatorParkingProvider(
        {
          scenario: config.PARKING_EMULATOR_SCENARIO,
          plate: config.PARKING_EMULATOR_PLATE,
          webhookSecret: config.PARKING_WEBHOOK_SECRET,
          anchor: config.PARKING_EMULATOR_ANCHOR,
        },
        clock,
      );
    case 'vendor':
      return new VendorParkingProvider({
        baseUrl: config.PARKING_VENDOR_BASE_URL ?? null,
        apiKey: config.PARKING_VENDOR_API_KEY ?? null,
        webhookSecret: config.PARKING_WEBHOOK_SECRET,
      });
  }
}

export const parkingProviderFactory: FactoryProvider<ParkingProviderPort> = {
  provide: ParkingProviderPort,
  inject: [PARKING_CONFIG, Clock],
  useFactory: createParkingProvider,
};
