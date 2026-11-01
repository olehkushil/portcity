import { DEFAULT_REWARDS_CONFIG, rewardsEnvSchema } from './rewards.config';

describe('rewards env section', () => {
  it('has safe defaults', () => {
    expect(DEFAULT_REWARDS_CONFIG).toEqual({
      REWARDS_VOUCHER_TTL_DAYS: 30,
      REWARDS_CODE_MAX_ATTEMPTS: 8,
      REWARDS_SWEEP_BATCH_SIZE: 500,
      VALIDATOR_SHIFT_HOURS: 12,
      REWARDS_REFUND_ON_EXPIRY: true,
    });
  });

  it('coerces numeric and boolean strings from the environment', () => {
    expect(
      rewardsEnvSchema.parse({
        REWARDS_VOUCHER_TTL_DAYS: '14',
        REWARDS_CODE_MAX_ATTEMPTS: '3',
        REWARDS_SWEEP_BATCH_SIZE: '100',
        VALIDATOR_SHIFT_HOURS: '8.5',
        REWARDS_REFUND_ON_EXPIRY: 'false',
      }),
    ).toEqual({
      REWARDS_VOUCHER_TTL_DAYS: 14,
      REWARDS_CODE_MAX_ATTEMPTS: 3,
      REWARDS_SWEEP_BATCH_SIZE: 100,
      VALIDATOR_SHIFT_HOURS: 8.5,
      REWARDS_REFUND_ON_EXPIRY: false,
    });
    expect(rewardsEnvSchema.parse({ REWARDS_REFUND_ON_EXPIRY: '1' }).REWARDS_REFUND_ON_EXPIRY).toBe(
      true,
    );
  });

  it.each([
    { REWARDS_VOUCHER_TTL_DAYS: '0' },
    { REWARDS_VOUCHER_TTL_DAYS: '366' },
    { REWARDS_CODE_MAX_ATTEMPTS: '0' },
    { REWARDS_SWEEP_BATCH_SIZE: '5' },
    { VALIDATOR_SHIFT_HOURS: '49' },
    { REWARDS_VOUCHER_TTL_DAYS: 'abc' },
    { REWARDS_REFUND_ON_EXPIRY: 'sometimes' },
  ])('rejects %j', (env) => {
    expect(rewardsEnvSchema.safeParse(env).success).toBe(false);
  });
});
