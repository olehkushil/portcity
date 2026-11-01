import {
  ANONYMISED_PHONE_PREFIX,
  anonymisedPhone,
  anonymisedUserPatch,
  computeExecuteAfter,
  deletionRequestState,
  isAnonymisedPhone,
  isDeletionDue,
} from './deletion';

describe('account deletion rules', () => {
  const requestedAt = new Date('2026-01-15T10:00:00Z');

  it('executes 30 days after the request by default', () => {
    expect(computeExecuteAfter(requestedAt)).toEqual(new Date('2026-02-14T10:00:00Z'));
    expect(computeExecuteAfter(requestedAt, 1)).toEqual(new Date('2026-01-16T10:00:00Z'));
  });

  const executeAfter = new Date('2026-02-14T10:00:00Z');
  it.each([
    ['pending, before due', null, null, new Date('2026-02-01T00:00:00Z'), 'pending', false],
    ['pending, due exactly', null, null, executeAfter, 'pending', true],
    ['pending, overdue', null, null, new Date('2026-03-01T00:00:00Z'), 'pending', true],
    [
      'executed',
      new Date('2026-02-15T00:00:00Z'),
      null,
      new Date('2026-03-01T00:00:00Z'),
      'executed',
      false,
    ],
    [
      'cancelled',
      null,
      new Date('2026-01-20T00:00:00Z'),
      new Date('2026-03-01T00:00:00Z'),
      'cancelled',
      false,
    ],
    [
      'executed wins over cancelled',
      new Date('2026-02-15T00:00:00Z'),
      new Date('2026-02-16T00:00:00Z'),
      new Date('2026-03-01T00:00:00Z'),
      'executed',
      false,
    ],
  ] as const)('%s', (_name, executedAt, cancelledAt, now, state, due) => {
    const request = { executeAfter, executedAt, cancelledAt };
    expect(deletionRequestState(request)).toBe(state);
    expect(isDeletionDue(request, now)).toBe(due);
  });

  it('builds a deterministic, short, non-personal placeholder phone', () => {
    const phone = anonymisedPhone('0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11');
    expect(phone.startsWith(ANONYMISED_PHONE_PREFIX)).toBe(true);
    expect(phone.length).toBeLessThanOrEqual(32);
    expect(phone).toBe(anonymisedPhone('0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11'));
    expect(phone).not.toBe(anonymisedPhone('0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e12'));
    expect(isAnonymisedPhone(phone)).toBe(true);
    expect(isAnonymisedPhone('+380501234567')).toBe(false);
  });

  it('removes every personal field and marks the row deleted', () => {
    const now = new Date('2026-02-14T10:00:00Z');
    expect(anonymisedUserPatch('user-1', now)).toEqual({
      phone: anonymisedPhone('user-1'),
      email: null,
      firstName: null,
      lastName: null,
      birthDate: null,
      gender: null,
      city: null,
      status: 'deleted',
      deletedAt: now,
    });
  });

  it('computes executeAfter from the configured grace period', () => {
    const requestedAt = new Date('2026-02-14T10:00:00Z');
    expect(computeExecuteAfter(requestedAt)).toEqual(new Date('2026-03-16T10:00:00Z'));
    expect(computeExecuteAfter(requestedAt, 7)).toEqual(new Date('2026-02-21T10:00:00Z'));
  });
});
