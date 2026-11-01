import { z } from 'zod';
import {
  PAYMENT_PENDING_TIMEOUT_MINUTES,
  PAYMENT_PROVIDERS,
} from '../../common/contracts/payments';

/** Injection token for the validated payments slice of the environment (`PaymentsConfig`). */
export const PAYMENTS_CONFIG = Symbol('PAYMENTS_CONFIG');

export const FISCALIZATION_DRIVERS = ['none', 'mock'] as const;
export type FiscalizationDriver = (typeof FISCALIZATION_DRIVERS)[number];

export const DEV_MOCK_WEBHOOK_SECRET = 'dev-only-payments-mock-webhook-secret';
export const DEV_RECEIPT_QR_SECRET = 'dev-only-payments-receipt-qr-secret';

/**
 * Module-specific environment (documented in the module README; the integration agent merges
 * the variables into `.env.example`). `PAYMENTS_PROVIDER` is also declared in the shared
 * schema as a free string; here it is narrowed to the providers the contract knows.
 */
export const paymentsEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PAYMENTS_PROVIDER: z.enum(PAYMENT_PROVIDERS).default('mock'),
    /** HMAC secret for `X-Mock-Signature` on `POST /webhooks/payments/mock`. */
    PAYMENTS_MOCK_WEBHOOK_SECRET: z.string().min(8).default(DEV_MOCK_WEBHOOK_SECRET),
    /**
     * Base of the checkout URL the mock provider returns (`<base>/<providerRef>`); the default
     * points at the dev page served by MockCheckoutController under the global `/api/v1` prefix.
     */
    PAYMENTS_MOCK_CHECKOUT_BASE_URL: z.url().default('http://localhost:3000/api/v1/mock-checkout'),
    /** Deep link the provider redirects to after checkout when the caller gives none. */
    PAYMENTS_RETURN_URL: z.string().min(1).default('portcity://payments/return'),
    /** Open payments older than this are reconciled with the provider or expired. */
    PAYMENTS_PENDING_TIMEOUT_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(1440)
      .default(PAYMENT_PENDING_TIMEOUT_MINUTES),
    /** Max open payments one reconciliation run inspects. */
    PAYMENTS_RECONCILE_BATCH: z.coerce.number().int().min(1).max(1000).default(200),
    /** `none`: the provider (or a legal exception) covers fiscalisation; `mock`: fake receipts in dev. */
    PAYMENTS_FISCALIZATION: z.enum(FISCALIZATION_DRIVERS).default('none'),
    /** Base of the fake fiscal receipt URL produced by the mock fiscalisation adapter. */
    PAYMENTS_MOCK_FISCAL_BASE_URL: z.url().default('http://localhost:3000/mock-fiscal'),
    /** Strict (real) adapters reject timestamped notifications older than this. */
    PAYMENTS_WEBHOOK_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(86_400).default(600),
    /** Merchant shown on the receipt screen of non-parking payments. */
    PAYMENTS_MERCHANT_NAME: z.string().min(1).max(200).default('ТРЦ «Порт City»'),
    /** Merchant shown on parking receipts: the parking operator (ФОП) who receives the money. */
    PAYMENTS_PARKING_MERCHANT_NAME: z
      .string()
      .min(1)
      .max(200)
      .default('Оператор паркінгу ТРЦ «Порт City» (ФОП)'),
    /** HMAC secret of the operator QR on the parking receipt screen (`operatorQrPayload`). */
    PAYMENTS_RECEIPT_QR_SECRET: z.string().min(16).default(DEV_RECEIPT_QR_SECRET),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.PAYMENTS_PROVIDER === 'mock') {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYMENTS_PROVIDER'],
        message: 'the mock provider must not be used in production',
      });
    }
    if (
      env.NODE_ENV === 'production' &&
      env.PAYMENTS_MOCK_WEBHOOK_SECRET === DEV_MOCK_WEBHOOK_SECRET
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYMENTS_MOCK_WEBHOOK_SECRET'],
        message: 'must not use the development default in production',
      });
    }
    if (env.NODE_ENV === 'production' && env.PAYMENTS_RECEIPT_QR_SECRET === DEV_RECEIPT_QR_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYMENTS_RECEIPT_QR_SECRET'],
        message: 'must not use the development default in production',
      });
    }
  });

export type PaymentsConfig = z.output<typeof paymentsEnvSchema>;

/** Defaults for unit tests and factories that do not go through the environment. */
export function defaultPaymentsConfig(overrides: Partial<PaymentsConfig> = {}): PaymentsConfig {
  return { ...paymentsEnvSchema.parse({ NODE_ENV: 'test' }), ...overrides };
}
