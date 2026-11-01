import { RECEIPT_STATUSES, type ReceiptStatus } from '../../../common/contracts/receipts';
import type { ActorType } from '../../../common/contracts/shared';
import { DomainError } from '../../../common/errors/domain-error';
import {
  MAX_APPEALS_PER_RECEIPT,
  RECEIPT_TRANSITIONS,
  assertTransition,
  canAppeal,
  canAppealWith,
  canTransition,
  isCreditable,
  isFinalStatus,
  nextStatuses,
} from './state-machine';

const ALLOWED: ReadonlyArray<[ReceiptStatus, ReceiptStatus, ActorType]> = [
  ['uploaded', 'parsed', 'system'],
  ['parsed', 'auto_approved', 'system'],
  ['parsed', 'needs_moderation', 'system'],
  ['parsed', 'rejected', 'system'],
  ['auto_approved', 'credited', 'system'],
  ['auto_approved', 'needs_moderation', 'system'],
  ['needs_moderation', 'approved', 'admin'],
  ['needs_moderation', 'rejected', 'admin'],
  ['approved', 'credited', 'system'],
  ['credited', 'rejected', 'system'],
  ['rejected', 'appealed', 'user'],
  ['appealed', 'needs_moderation', 'admin'],
  ['appealed', 'needs_moderation', 'system'],
];

describe('receipt state machine', () => {
  it('covers every brief transition and nothing else', () => {
    const table: Array<[ReceiptStatus, ReceiptStatus, boolean]> = [];
    for (const from of RECEIPT_STATUSES) {
      for (const to of RECEIPT_STATUSES) {
        table.push([from, to, ALLOWED.some(([f, t]) => f === from && t === to)]);
      }
    }
    expect(table).toHaveLength(RECEIPT_STATUSES.length ** 2);
    for (const [from, to, expected] of table) {
      expect({ from, to, allowed: canTransition(from, to) }).toEqual({
        from,
        to,
        allowed: expected,
      });
    }
    expect(RECEIPT_TRANSITIONS).toHaveLength(12);
  });

  it.each(ALLOWED)('%s -> %s is allowed for %s', (from, to, actor) => {
    expect(canTransition(from, to, actor)).toBe(true);
    expect(() => assertTransition(from, to, actor)).not.toThrow();
  });

  const WRONG_ACTOR: ReadonlyArray<[ReceiptStatus, ReceiptStatus, ActorType]> = [
    ['needs_moderation', 'approved', 'user'],
    ['needs_moderation', 'approved', 'system'],
    ['needs_moderation', 'rejected', 'user'],
    ['rejected', 'appealed', 'admin'],
    ['rejected', 'appealed', 'system'],
    ['parsed', 'auto_approved', 'admin'],
    ['approved', 'credited', 'admin'],
    ['appealed', 'needs_moderation', 'user'],
    ['auto_approved', 'needs_moderation', 'admin'],
    ['credited', 'rejected', 'admin'],
    ['credited', 'rejected', 'user'],
  ];

  it.each(WRONG_ACTOR)('%s -> %s is refused for %s', (from, to, actor) => {
    expect(canTransition(from, to, actor)).toBe(false);
    try {
      assertTransition(from, to, actor);
      throw new Error('expected a throw');
    } catch (error) {
      expect(DomainError.is(error)).toBe(true);
      const domainError = error as DomainError;
      expect(domainError.code).toBe('PC_RECEIPT_INVALID_TRANSITION');
      expect(domainError.status).toBe(409);
      expect(domainError.details).toMatchObject({ from, to, actor });
    }
  });

  it('lists next statuses per actor', () => {
    expect(nextStatuses('parsed')).toEqual(['auto_approved', 'needs_moderation', 'rejected']);
    expect(nextStatuses('needs_moderation', 'admin')).toEqual(['approved', 'rejected']);
    expect(nextStatuses('needs_moderation', 'user')).toEqual([]);
    expect(nextStatuses('credited', 'admin')).toEqual([]);
    expect(nextStatuses('credited', 'user')).toEqual([]);
    expect(nextStatuses('credited', 'system')).toEqual(['rejected']);
    expect(nextStatuses('auto_approved', 'system')).toEqual(['credited', 'needs_moderation']);
  });

  it('knows final, creditable and appealable statuses', () => {
    expect(RECEIPT_STATUSES.filter(isFinalStatus)).toEqual(['credited']);
    expect(RECEIPT_STATUSES.filter(isCreditable)).toEqual(['auto_approved', 'approved']);
    expect(RECEIPT_STATUSES.filter(canAppeal)).toEqual(['rejected']);
  });

  it.each<[ReceiptStatus, number, boolean]>([
    ['rejected', 0, true],
    ['rejected', MAX_APPEALS_PER_RECEIPT, false],
    ['appealed', 0, false],
    ['credited', 0, false],
    ['needs_moderation', 0, false],
  ])('canAppealWith(%s, %d) = %s', (status, appeals, expected) => {
    expect(canAppealWith(status, appeals)).toBe(expected);
  });
});
