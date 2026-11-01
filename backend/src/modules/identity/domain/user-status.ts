import type { UserStatus } from '../../../common/contracts/identity';
import { DomainError } from '../../../common/errors/domain-error';
import { IdentityErrors } from './errors';

/**
 * User state machine: active <-> blocked, both -> deleted (terminal, reached only by the
 * account-deletion job after the cooling-off period).
 */
export const USER_TRANSITIONS: Readonly<Record<UserStatus, readonly UserStatus[]>> = Object.freeze({
  active: ['blocked', 'deleted'],
  blocked: ['active', 'deleted'],
  deleted: [],
});

export function canTransitionUser(from: UserStatus, to: UserStatus): boolean {
  return USER_TRANSITIONS[from].includes(to);
}

export function assertUserTransition(from: UserStatus, to: UserStatus): void {
  if (!canTransitionUser(from, to)) {
    throw new DomainError(
      IdentityErrors.PC_USER_INVALID_TRANSITION,
      `User status cannot change from ${from} to ${to}`,
      { details: { from, to, allowed: USER_TRANSITIONS[from] } },
    );
  }
}

/** Login, refresh and every member endpoint that loads the user go through this check. */
export function assertUserCanAuthenticate(status: UserStatus): void {
  if (status === 'blocked') {
    throw new DomainError(IdentityErrors.PC_USER_BLOCKED, 'This account is blocked');
  }
  if (status === 'deleted') {
    throw new DomainError(IdentityErrors.PC_USER_DELETED, 'This account has been deleted');
  }
}
