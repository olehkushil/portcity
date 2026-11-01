import { USER_STATUSES, type UserStatus } from '../../../common/contracts/identity';
import { captureError } from '../testing/errors';
import {
  USER_TRANSITIONS,
  assertUserCanAuthenticate,
  assertUserTransition,
  canTransitionUser,
} from './user-status';

describe('user status machine', () => {
  const table: Array<[UserStatus, UserStatus, boolean]> = [
    ['active', 'blocked', true],
    ['active', 'deleted', true],
    ['active', 'active', false],
    ['blocked', 'active', true],
    ['blocked', 'deleted', true],
    ['blocked', 'blocked', false],
    ['deleted', 'active', false],
    ['deleted', 'blocked', false],
    ['deleted', 'deleted', false],
  ];

  it.each(table)('%s -> %s allowed=%s', (from, to, allowed) => {
    expect(canTransitionUser(from, to)).toBe(allowed);
    if (allowed) {
      expect(() => assertUserTransition(from, to)).not.toThrow();
    } else {
      expect(captureError(() => assertUserTransition(from, to))).toMatchObject({
        code: 'PC_USER_INVALID_TRANSITION',
        status: 409,
      });
    }
  });

  it('covers every status in the transition table', () => {
    expect(Object.keys(USER_TRANSITIONS).sort()).toEqual([...USER_STATUSES].sort());
  });

  it.each([
    ['active', null],
    ['blocked', 'PC_USER_BLOCKED'],
    ['deleted', 'PC_USER_DELETED'],
  ] as const)('authentication for %s user -> %s', (status, code) => {
    if (code === null) {
      expect(() => assertUserCanAuthenticate(status)).not.toThrow();
    } else {
      expect(captureError(() => assertUserCanAuthenticate(status))).toMatchObject({ code });
    }
  });
});
