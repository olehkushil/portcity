import { parseEnvSection } from '../../common/config/env-section';
import { defaultParkingConfig, parkingEnvSchema } from './parking.config';

describe('parking environment section', () => {
  it('has development defaults', () => {
    expect(defaultParkingConfig()).toMatchObject({
      PARKING_PROVIDER: 'emulator',
      PARKING_EMULATOR_SCENARIO: 'payable',
      PARKING_EMULATOR_ANCHOR: 'today',
      PARKING_EMULATOR_PLATE: 'AC1234BC',
      PARKING_SYNC_EVERY_MS: 60_000,
      PARKING_UNVERIFIED_LOOKUPS_PER_HOUR: 10,
      PARKING_FREE_ENDING_REMINDER_MINUTES: 5,
      PARKING_EXIT_REMINDER_MINUTES: 10,
      PARKING_AIR_RAID_FREE_EXIT_MINUTES: 30,
      PARKING_INFO_MODE_DEFAULT: true,
      PARKING_INFO_TIMER_EVENTS: false,
    });
  });

  it('parses strings from the environment and treats blanks as unset', () => {
    const config = parseEnvSection(parkingEnvSchema, 'parking', {
      PARKING_PROVIDER: 'vendor',
      PARKING_SYNC_EVERY_MS: '30000',
      PARKING_INFO_TIMER_EVENTS: 'true',
      PARKING_VENDOR_BASE_URL: '  ',
    });
    expect(config).toMatchObject({
      PARKING_PROVIDER: 'vendor',
      PARKING_SYNC_EVERY_MS: 30_000,
      PARKING_INFO_TIMER_EVENTS: true,
    });
    expect(config.PARKING_VENDOR_BASE_URL).toBeUndefined();
  });

  it.each([
    [{ PARKING_PROVIDER: 'real' }],
    [{ PARKING_EMULATOR_SCENARIO: 'prototype' }],
    [{ PARKING_SYNC_EVERY_MS: '500' }],
    [{ NODE_ENV: 'production' }],
  ])('rejects %p', (raw) => {
    expect(() => parseEnvSection(parkingEnvSchema, 'parking', raw)).toThrow(
      'Invalid environment for section "parking"',
    );
  });

  it('accepts a real webhook secret in production', () => {
    expect(() =>
      parseEnvSection(parkingEnvSchema, 'parking', {
        NODE_ENV: 'production',
        PARKING_WEBHOOK_SECRET: 'a-real-secret-0123456789',
      }),
    ).not.toThrow();
  });
});
