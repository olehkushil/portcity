import { DomainError } from '../errors/domain-error';
import { clampLimit, decodeCursor, encodeCursor, toPage } from './cursor';

describe('cursor pagination', () => {
  it('round-trips a payload', () => {
    const cursor = encodeCursor({ createdAt: '2026-01-01T00:00:00.000Z', id: 'abc' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual({ createdAt: '2026-01-01T00:00:00.000Z', id: 'abc' });
  });

  it('returns undefined for an absent cursor', () => {
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor(null)).toBeUndefined();
    expect(decodeCursor('')).toBeUndefined();
  });

  it('rejects malformed cursors with PC_COMMON_CURSOR_INVALID', () => {
    for (const bad of ['not-base64!', Buffer.from('[1,2]').toString('base64url'), 'bnVsbA']) {
      expect(() => decodeCursor(bad)).toThrow(DomainError);
      try {
        decodeCursor(bad);
      } catch (error) {
        expect((error as DomainError).code).toBe('PC_COMMON_CURSOR_INVALID');
      }
    }
  });

  it('applies a shape guard', () => {
    const isIdCursor = (value: unknown): value is { id: string } =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { id?: unknown }).id === 'string';
    expect(decodeCursor(encodeCursor({ id: 'x' }), isIdCursor)).toEqual({ id: 'x' });
    expect(() => decodeCursor(encodeCursor({ other: 1 }), isIdCursor)).toThrow(DomainError);
  });

  it('builds pages from limit + 1 rows', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const page = toPage(rows, 2, (last) => ({ id: last.id }));
    expect(page.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(decodeCursor(page.nextCursor)).toEqual({ id: 2 });

    const lastPage = toPage(rows, 3, (last) => ({ id: last.id }));
    expect(lastPage.items).toHaveLength(3);
    expect(lastPage.nextCursor).toBeNull();

    expect(toPage([], 10, () => ({})).nextCursor).toBeNull();
  });

  it('clamps limits', () => {
    expect(clampLimit(undefined)).toBe(20);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(1000)).toBe(100);
    expect(clampLimit(7.9)).toBe(7);
  });
});
