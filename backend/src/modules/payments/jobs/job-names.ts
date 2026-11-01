/** Job names on the `payments-reconcile` queue (brief section 9). */
export const PAYMENT_JOBS = {
  /** Hourly: open payments older than the pending timeout are checked with the provider or expired. */
  reconcile: 'reconcile',
  /** After `payment.succeeded`: run the fiscalisation hook for one payment. */
  fiscalize: 'fiscalize',
  /** PaymentsPort.requestRefund: refund one payment the purpose module cannot use. */
  autoRefund: 'auto-refund',
} as const;

export type PaymentJobName = (typeof PAYMENT_JOBS)[keyof typeof PAYMENT_JOBS];

export const PAYMENTS_RECONCILE_SCHEDULE_ID = 'payments-reconcile-hourly';
export const PAYMENTS_RECONCILE_EVERY_MS = 3_600_000;

/** Long retry policy of an automatic refund (the provider may be down for a while). */
export const AUTO_REFUND_JOB_OPTIONS = {
  attempts: 12,
  backoff: { type: 'exponential' as const, delay: 60_000 },
};

export interface FiscalizeJobData {
  paymentId: string;
}

export interface AutoRefundJobData {
  paymentId: string;
}
