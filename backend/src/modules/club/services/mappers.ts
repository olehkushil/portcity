import type { LedgerEntry, PointsBalance } from '../../../common/contracts/club';
import { spendBlockReason } from '../domain/balance';
import type { AccountRecord, EntryRecord } from './club.repository';

export function toLedgerEntry(entry: EntryRecord): LedgerEntry {
  return {
    id: entry.id,
    accountId: entry.accountId,
    userId: entry.userId,
    type: entry.type,
    state: entry.state,
    amount: entry.amount,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    idempotencyKey: entry.idempotencyKey,
    availableAt: entry.availableAt,
    expiresAt: entry.expiresAt,
    reason: entry.reason,
    createdById: entry.createdById,
    createdAt: entry.createdAt,
    title: entry.title,
    subtitle: entry.subtitle,
    counterparty: entry.counterparty ? { ...entry.counterparty } : null,
  };
}

export function toPointsBalance(account: AccountRecord, now: Date): PointsBalance {
  return {
    accountId: account.id,
    userId: account.userId,
    available: account.availableBalance,
    pending: account.pendingBalance,
    lifetimeEarned: account.lifetimeEarned,
    newcomerLockUntil: account.newcomerLockUntil,
    spendBlockedBy: spendBlockReason(account.availableBalance, account.newcomerLockUntil, now),
  };
}

export function isoOrNull(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}
