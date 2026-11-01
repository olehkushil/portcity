export { PaymentsModule } from './payments.module';
export { PaymentsService, describeOutcome } from './services/payments.service';
export type {
  AdminPaymentDetail,
  ApplyOutcome,
  AutoRefundOutcome,
  EventSource,
  FiscalizeOutcome,
  JobQueue,
  ListPaymentsFilter,
  PaymentReceiptFields,
  ReconcileOutcome,
  RefundRequest,
} from './services/payments.service';
export {
  MAX_PAYMENT_ATTEMPTS,
  attemptKey,
  isCheckoutExpired,
  isCheckoutStuck,
  parseAttemptKey,
} from './domain/attempts';
export { webhookPolicyViolation } from './domain/webhook-policy';
export type { WebhookPolicy, WebhookPolicyViolation } from './domain/webhook-policy';
export {
  OPERATOR_QR_PREFIX,
  displayNumberOf,
  signOperatorQr,
  verifyOperatorQr,
} from './domain/receipt';
export { decideAfterCancel, decideReconciliation } from './domain/reconcile';
export { PaymentWebhooksService } from './services/payment-webhooks.service';
export type { WebhookAck } from './services/payment-webhooks.service';
export { PaymentsErasureService } from './services/payments-erasure.service';
export type { PaymentsErasureSummary } from './services/payments-erasure.service';
export { PERSONAL_META_KEYS, erasePersonalMeta } from './domain/erasure';
export { PAYMENTS_CONSUMED_EVENTS, handlePaymentsEvent } from './jobs/payments-events.handler';
export {
  MOCK_CHECKOUT_OUTCOMES,
  MockCheckoutService,
  mockCheckoutEventId,
} from './services/mock-checkout.service';
export type {
  MockCheckoutOutcome,
  MockCheckoutResult,
  MockCheckoutView,
} from './services/mock-checkout.service';
export { PaymentProviderPort, headerValue } from './services/payment-provider.port';
export type {
  CheckoutSession,
  CreateCheckoutInput,
  ProviderCancelResult,
  ProviderRefundResult,
  ProviderWebhookRequest,
} from './services/payment-provider.port';
export { PaymentProviderRegistry } from './services/providers/provider.registry';
export {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
  parseMockWebhookBody,
  signMockWebhookBody,
} from './services/providers/mock-payment-provider';
export type { MockWebhookBody } from './services/providers/mock-payment-provider';
export {
  FiscalizationPort,
  MockFiscalizationAdapter,
  NoopFiscalizationAdapter,
} from './services/fiscalization.port';
export type { FiscalizationInput, FiscalizationResult } from './services/fiscalization.port';
export { PAYMENTS_CONFIG, paymentsEnvSchema, defaultPaymentsConfig } from './payments.config';
export type { PaymentsConfig } from './payments.config';
export { PaymentErrors } from './domain/errors';
export {
  LATE_SUCCESS_SOURCES,
  PAYMENT_TRANSITIONS,
  assertTransition,
  canTransition,
  isFinalStatus,
  isLateSuccessSource,
  isOpenStatus,
  isRefundableStatus,
  isReusableStatus,
  isSettledStatus,
} from './domain/state-machine';
export { planRefund } from './domain/refunds';
export { applyProviderEvent } from './domain/provider-events';
export type { ProviderEventKind, ProviderPaymentEvent } from './domain/provider-events';
export { PAYMENT_JOBS } from './jobs/job-names';
