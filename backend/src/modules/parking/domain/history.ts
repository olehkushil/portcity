import type { ParkingSessionSource, ParkingSessionStatus } from '../../../common/contracts/parking';
import type { PaymentStatus } from '../../../common/contracts/payments';
import { kyivLocalToUtc } from '../../../common/time/kyiv';
import { isFinalStatus } from './session-state';

/** An app payment linked to a session, as the session card and the history show it. */
export interface SessionPaymentView {
  id: string;
  amountKopecks: number;
  paidAt: Date | null;
  /** Exit deadline the payment bought (null for unknown legacy links). */
  paidUntil: Date | null;
  status: PaymentStatus;
}

/** Payment statuses in which the money stays with the operator. */
export const PAID_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'succeeded',
  'fiscalized',
  'partially_refunded',
];

/** Payment statuses worth listing in the history (money moved at some point). */
export const LISTED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  ...PAID_PAYMENT_STATUSES,
  'refunded',
];

export const PAID_VIA = ['app', 'paymat', 'free', 'none'] as const;
export type PaidVia = (typeof PAID_VIA)[number];

/**
 * How a stay was paid, for the history card: `app` when an app payment is kept, `paymat` when
 * the operator reports a payment the app did not make (or the member said so for a timer),
 * `free` for free stays (within the free minutes, air-raid or privilege), `none` otherwise.
 */
export function paidVia(input: {
  status: ParkingSessionStatus;
  source: ParkingSessionSource;
  paidUntil: Date | null;
  amountPaidKopecks: number;
  stayTotalKopecks: number;
  appPaidKopecks: number;
}): PaidVia {
  if (input.appPaidKopecks > 0) {
    return 'app';
  }
  if (input.status === 'closed_free') {
    return 'free';
  }
  if (input.paidUntil || input.amountPaidKopecks > 0) {
    return 'paymat';
  }
  if (
    isFinalStatus(input.status) &&
    input.status !== 'closed_unpaid' &&
    input.stayTotalKopecks === 0
  ) {
    return 'free';
  }
  return 'none';
}

/** Sum of the kept app payments (refunded parts excluded). */
export function appPaidKopecks(
  payments: ReadonlyArray<{
    status: PaymentStatus;
    amountKopecks: number;
    refundedKopecks?: number;
  }>,
): number {
  return payments
    .filter((payment) => PAID_PAYMENT_STATUSES.includes(payment.status))
    .reduce((total, payment) => total + payment.amountKopecks - (payment.refundedKopecks ?? 0), 0);
}

/** `YYYY-MM` (Kyiv calendar month) to the UTC interval [from, to). Null for a malformed month. */
export function kyivMonthRange(month: string): { from: Date; to: Date } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) {
    return null;
  }
  const from = kyivLocalToUtc({ year, month: monthNumber, day: 1 });
  const to =
    monthNumber === 12
      ? kyivLocalToUtc({ year: year + 1, month: 1, day: 1 })
      : kyivLocalToUtc({ year, month: monthNumber + 1, day: 1 });
  return { from, to };
}
