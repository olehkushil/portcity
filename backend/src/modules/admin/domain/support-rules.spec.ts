import {
  SUPPORT_REQUEST_STATUSES,
  type SupportRequestStatus,
} from '../../../common/contracts/admin';
import { DomainError } from '../../../common/errors/domain-error';
import {
  assertSupportStatusChange,
  canChangeSupportStatus,
  isDecidedSupportStatus,
  isOwnSupportPhotoKey,
  isSupportPhotoContentType,
  remainingSupportRequests,
  supportPhotoPrefix,
} from './support-rules';

describe('support request status machine', () => {
  const allowed = new Set([
    'new>in_progress',
    'new>resolved',
    'new>closed',
    'in_progress>resolved',
    'in_progress>closed',
    'resolved>in_progress',
    'resolved>closed',
    // Same status: note-only update, except on a closed request.
    'new>new',
    'in_progress>in_progress',
    'resolved>resolved',
  ]);
  const table: Array<[SupportRequestStatus, SupportRequestStatus, boolean]> = [];
  for (const from of SUPPORT_REQUEST_STATUSES) {
    for (const to of SUPPORT_REQUEST_STATUSES) {
      table.push([from, to, allowed.has(`${from}>${to}`)]);
    }
  }

  it.each(table)('%s -> %s allowed = %s', (from, to, expected) => {
    expect(canChangeSupportStatus(from, to)).toBe(expected);
    if (expected) {
      expect(() => assertSupportStatusChange('r-1', from, to)).not.toThrow();
    } else {
      try {
        assertSupportStatusChange('r-1', from, to);
        throw new Error('expected a DomainError');
      } catch (error) {
        expect(DomainError.is(error) && error.code).toBe('PC_SUPPORT_REQUEST_INVALID_TRANSITION');
      }
    }
  });

  it('marks resolved and closed as decided', () => {
    expect(SUPPORT_REQUEST_STATUSES.filter(isDecidedSupportStatus)).toEqual(['resolved', 'closed']);
  });
});

describe('support request limits and photos', () => {
  it('counts the remaining requests of the day', () => {
    expect(remainingSupportRequests(0)).toBe(5);
    expect(remainingSupportRequests(4)).toBe(1);
    expect(remainingSupportRequests(7)).toBe(0);
  });

  it('accepts only own photo keys', () => {
    const user = '01900000-0000-7000-8000-000000000001';
    expect(supportPhotoPrefix(user)).toBe(`support/${user}`);
    expect(isOwnSupportPhotoKey(user, `support/${user}/2026/11/a.jpg`)).toBe(true);
    expect(isOwnSupportPhotoKey(user, 'support/someone-else/2026/11/a.jpg')).toBe(false);
    expect(isOwnSupportPhotoKey(user, `support/${user}/../other/a.jpg`)).toBe(false);
    expect(isOwnSupportPhotoKey(user, `receipts/${user}/a.jpg`)).toBe(false);
  });

  it('accepts common photo types only', () => {
    expect(isSupportPhotoContentType('image/jpeg')).toBe(true);
    expect(isSupportPhotoContentType('IMAGE/PNG')).toBe(true);
    expect(isSupportPhotoContentType('application/pdf')).toBe(false);
  });
});
