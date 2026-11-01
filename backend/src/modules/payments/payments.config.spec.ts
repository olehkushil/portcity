import { parseEnvSection } from '../../common/config/env-section';
import {
  DEV_MOCK_WEBHOOK_SECRET,
  defaultPaymentsConfig,
  paymentsEnvSchema,
} from './payments.config';

describe('payments environment section', () => {
  it('applies development defaults', () => {
    const config = parseEnvSection(paymentsEnvSchema, 'payments', {});
    expect(config).toMatchObject({
      PAYMENTS_PROVIDER: 'mock',
      PAYMENTS_MOCK_WEBHOOK_SECRET: DEV_MOCK_WEBHOOK_SECRET,
      PAYMENTS_MOCK_CHECKOUT_BASE_URL: 'http://localhost:3000/api/v1/mock-checkout',
      PAYMENTS_RETURN_URL: 'portcity://payments/return',
      PAYMENTS_PENDING_TIMEOUT_MINUTES: 20,
      PAYMENTS_RECONCILE_BATCH: 200,
      PAYMENTS_FISCALIZATION: 'none',
    });
  });

  it('coerces numbers and narrows enums', () => {
    const config = parseEnvSection(paymentsEnvSchema, 'payments', {
      PAYMENTS_PENDING_TIMEOUT_MINUTES: '45',
      PAYMENTS_RECONCILE_BATCH: '10',
      PAYMENTS_FISCALIZATION: 'mock',
      PAYMENTS_PROVIDER: 'mock',
    });
    expect(config.PAYMENTS_PENDING_TIMEOUT_MINUTES).toBe(45);
    expect(config.PAYMENTS_RECONCILE_BATCH).toBe(10);
    expect(config.PAYMENTS_FISCALIZATION).toBe('mock');
  });

  it.each([
    [{ PAYMENTS_PROVIDER: 'stripe' }, 'PAYMENTS_PROVIDER'],
    [{ PAYMENTS_PENDING_TIMEOUT_MINUTES: '0' }, 'PAYMENTS_PENDING_TIMEOUT_MINUTES'],
    [{ PAYMENTS_MOCK_WEBHOOK_SECRET: 'short' }, 'PAYMENTS_MOCK_WEBHOOK_SECRET'],
    [{ PAYMENTS_MOCK_CHECKOUT_BASE_URL: 'not a url' }, 'PAYMENTS_MOCK_CHECKOUT_BASE_URL'],
    [{ PAYMENTS_FISCALIZATION: 'checkbox' }, 'PAYMENTS_FISCALIZATION'],
  ])('rejects %j', (raw, variable) => {
    expect(() => parseEnvSection(paymentsEnvSchema, 'payments', raw)).toThrow(variable);
  });

  it('refuses the mock provider and the dev secret in production', () => {
    expect(() =>
      parseEnvSection(paymentsEnvSchema, 'payments', { NODE_ENV: 'production' }),
    ).toThrow(/PAYMENTS_PROVIDER[\s\S]*PAYMENTS_MOCK_WEBHOOK_SECRET/);
  });

  it('builds test defaults with overrides', () => {
    expect(defaultPaymentsConfig({ PAYMENTS_FISCALIZATION: 'mock' })).toMatchObject({
      NODE_ENV: 'test',
      PAYMENTS_PROVIDER: 'mock',
      PAYMENTS_FISCALIZATION: 'mock',
    });
  });
});
