import { sha256Hex } from '../../../common/auth/crypto';
import { ACCOUNT_DELETION_DELAY_DAYS } from '../../../common/contracts/identity';

const DAY_MS = 86_400_000;

/** Placeholder phone of an anonymised account; `users.phone` stays unique and non-personal. */
export const ANONYMISED_PHONE_PREFIX = 'anon:';

export interface DeletionRequestLike {
  executeAfter: Date;
  executedAt: Date | null;
  cancelledAt: Date | null;
}

export type DeletionRequestState = 'pending' | 'executed' | 'cancelled';

/** `requestedAt + ACCOUNT_DELETION_GRACE_DAYS` (default 30, brief section 4). */
export function computeExecuteAfter(
  requestedAt: Date,
  delayDays: number = ACCOUNT_DELETION_DELAY_DAYS,
): Date {
  return new Date(requestedAt.getTime() + delayDays * DAY_MS);
}

/** State machine: pending -> executed | cancelled; both terminal. */
export function deletionRequestState(request: DeletionRequestLike): DeletionRequestState {
  if (request.executedAt) {
    return 'executed';
  }
  if (request.cancelledAt) {
    return 'cancelled';
  }
  return 'pending';
}

export function isDeletionDue(request: DeletionRequestLike, now: Date): boolean {
  return (
    deletionRequestState(request) === 'pending' && request.executeAfter.getTime() <= now.getTime()
  );
}

export interface AnonymisedUserPatch {
  phone: string;
  email: null;
  firstName: null;
  lastName: null;
  birthDate: null;
  gender: null;
  city: null;
  status: 'deleted';
  deletedAt: Date;
}

/** Deterministic per user, so re-running the job is idempotent; 29 characters fit `VarChar(32)`. */
export function anonymisedPhone(userId: string): string {
  return `${ANONYMISED_PHONE_PREFIX}${sha256Hex(userId).slice(0, 24)}`;
}

export function isAnonymisedPhone(phone: string): boolean {
  return phone.startsWith(ANONYMISED_PHONE_PREFIX);
}

/**
 * What the account-deletion job writes to `users`: personal data removed, the row, its id and
 * member code kept so the points ledger and receipts stay consistent with an anonymised owner.
 */
export function anonymisedUserPatch(userId: string, now: Date): AnonymisedUserPatch {
  return {
    phone: anonymisedPhone(userId),
    email: null,
    firstName: null,
    lastName: null,
    birthDate: null,
    gender: null,
    city: null,
    status: 'deleted',
    deletedAt: now,
  };
}
