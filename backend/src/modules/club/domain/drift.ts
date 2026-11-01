/**
 * Nightly balance consistency check (brief section 5): the cached balances on LoyaltyAccount
 * must equal the ledger sums, and the expiry buckets must hold exactly the spendable points
 * (`sum(buckets) === max(availableBalance, 0)`, see balance.ts). The job reports, it never
 * rewrites balances: a drift means a bug or a manual SQL edit that needs a human.
 */

export interface CachedBalances {
  availableBalance: number;
  pendingBalance: number;
}

export interface LedgerBalances {
  available: number;
  pending: number;
}

export type DriftKind = 'available' | 'pending' | 'buckets';

export interface BalanceDrift {
  accountId: string;
  userId: string;
  kinds: DriftKind[];
  cached: { available: number; pending: number };
  ledger: { available: number; pending: number };
  bucketsSum: number;
  /** What the buckets should sum to. */
  expectedBuckets: number;
}

/** Null when the account is consistent. */
export function detectBalanceDrift(
  account: CachedBalances & { id: string; userId: string },
  ledger: LedgerBalances,
  bucketsSum: number,
): BalanceDrift | null {
  const kinds: DriftKind[] = [];
  if (account.availableBalance !== ledger.available) {
    kinds.push('available');
  }
  if (account.pendingBalance !== ledger.pending) {
    kinds.push('pending');
  }
  const expectedBuckets = Math.max(ledger.available, 0);
  if (bucketsSum !== expectedBuckets) {
    kinds.push('buckets');
  }
  if (kinds.length === 0) {
    return null;
  }
  return {
    accountId: account.id,
    userId: account.userId,
    kinds,
    cached: { available: account.availableBalance, pending: account.pendingBalance },
    ledger: { available: ledger.available, pending: ledger.pending },
    bucketsSum,
    expectedBuckets,
  };
}
