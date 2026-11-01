import { Module, type OnModuleInit } from '@nestjs/common';
import { envSectionProvider } from '../../common/config/env-section';
import { IDENTITY_EVENTS } from '../../common/contracts/events';
import { PAYMENTS_PORT } from '../../common/contracts/payments';
import { OutboxRouter } from '../../common/outbox/outbox-router';
import { QUEUES } from '../../common/queue/queue.constants';
import { QueueModule } from '../../common/queue/queue.module';
import { WorkerSchedules } from '../../common/queue/worker-schedules.service';
import { Clock } from '../../common/time/clock';
import { AdminPaymentsController } from './controllers/admin-payments.controller';
import { MockCheckoutController } from './controllers/mock-checkout.controller';
import { PaymentWebhooksController } from './controllers/payment-webhooks.controller';
import { PaymentsController } from './controllers/payments.controller';
import {
  PAYMENTS_RECONCILE_EVERY_MS,
  PAYMENTS_RECONCILE_SCHEDULE_ID,
  PAYMENT_JOBS,
} from './jobs/job-names';
import { PaymentsEventsProcessor } from './jobs/payments-events.processor';
import { PaymentsReconcileProcessor } from './jobs/payments-reconcile.processor';
import { PAYMENTS_CONFIG, type PaymentsConfig, paymentsEnvSchema } from './payments.config';
import {
  FiscalizationPort,
  MockFiscalizationAdapter,
  NoopFiscalizationAdapter,
} from './services/fiscalization.port';
import { MockCheckoutService } from './services/mock-checkout.service';
import { PaymentWebhooksService } from './services/payment-webhooks.service';
import { PaymentProviderPort } from './services/payment-provider.port';
import { PaymentsErasureService } from './services/payments-erasure.service';
import { PaymentsService } from './services/payments.service';
import { MockPaymentProvider } from './services/providers/mock-payment-provider';
import { PaymentProviderRegistry } from './services/providers/provider.registry';

export function createMockPaymentProvider(
  config: PaymentsConfig,
  clock: Clock,
): MockPaymentProvider {
  return new MockPaymentProvider({
    secret: config.PAYMENTS_MOCK_WEBHOOK_SECRET,
    checkoutBaseUrl: config.PAYMENTS_MOCK_CHECKOUT_BASE_URL,
    now: () => clock.now(),
    checkoutTtlMinutes: config.PAYMENTS_PENDING_TIMEOUT_MINUTES,
  });
}

export function createProviderRegistry(
  config: PaymentsConfig,
  mock: MockPaymentProvider,
): PaymentProviderRegistry {
  // Real acquirer adapters (liqpay | mono | wayforpay | fondy | portmone) are added here once
  // the Discovery shortlist and KYC are done; each adapter is a PaymentProviderPort.
  return new PaymentProviderRegistry([mock], config.PAYMENTS_PROVIDER);
}

export function createFiscalizationAdapter(config: PaymentsConfig): FiscalizationPort {
  return config.PAYMENTS_FISCALIZATION === 'mock'
    ? new MockFiscalizationAdapter(config.PAYMENTS_MOCK_FISCAL_BASE_URL)
    : new NoopFiscalizationAdapter();
}

/**
 * Payments: payments through a pluggable provider port (mock in dev), signed idempotent
 * webhooks, refunds, the fiscalisation hook, the hourly `payments-reconcile` queue and the
 * `payments-events` consumer of `user.deleted` (personal data in payment meta).
 * Provides PAYMENTS_PORT (PaymentsService). Depends on the common layer only; consumed by
 * parking and admin. In development the mock provider's checkout URL is served by
 * MockCheckoutController (404 in production).
 */
@Module({
  imports: [QueueModule.registerQueue(QUEUES.paymentsReconcile, QUEUES.paymentsEvents)],
  controllers: [
    PaymentsController,
    PaymentWebhooksController,
    AdminPaymentsController,
    MockCheckoutController,
  ],
  providers: [
    envSectionProvider(PAYMENTS_CONFIG, paymentsEnvSchema, 'payments'),
    {
      provide: MockPaymentProvider,
      inject: [PAYMENTS_CONFIG, Clock],
      useFactory: createMockPaymentProvider,
    },
    {
      provide: PaymentProviderRegistry,
      inject: [PAYMENTS_CONFIG, MockPaymentProvider],
      useFactory: createProviderRegistry,
    },
    {
      provide: PaymentProviderPort,
      inject: [PaymentProviderRegistry],
      useFactory: (registry: PaymentProviderRegistry) => registry.default,
    },
    {
      provide: FiscalizationPort,
      inject: [PAYMENTS_CONFIG],
      useFactory: createFiscalizationAdapter,
    },
    PaymentsService,
    PaymentWebhooksService,
    MockCheckoutService,
    PaymentsErasureService,
    PaymentsReconcileProcessor,
    PaymentsEventsProcessor,
    { provide: PAYMENTS_PORT, useExisting: PaymentsService },
  ],
  exports: [PAYMENTS_PORT, PaymentsService, PaymentProviderRegistry, PaymentProviderPort],
})
export class PaymentsModule implements OnModuleInit {
  constructor(
    private readonly schedules: WorkerSchedules,
    private readonly router: OutboxRouter,
  ) {}

  onModuleInit(): void {
    // Account erased by identity: strip personal details from the member's payments.
    this.router.addRoute(IDENTITY_EVENTS.deleted, QUEUES.paymentsEvents);
    this.schedules.register({
      id: PAYMENTS_RECONCILE_SCHEDULE_ID,
      queue: QUEUES.paymentsReconcile,
      jobName: PAYMENT_JOBS.reconcile,
      every: PAYMENTS_RECONCILE_EVERY_MS,
    });
  }
}
