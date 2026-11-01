import {
  compareCreatedAtDesc,
  compareSortOrderAsc,
  createdAtCursorOf,
  isAfterCreatedAtCursor,
  isAfterSortOrderCursor,
  isCreatedAtCursor,
  isSortOrderCursor,
  sortOrderCursorOf,
} from './cursors';

const T1 = new Date('2026-11-01T10:00:00.000Z');
const T2 = new Date('2026-11-01T11:00:00.000Z');

describe('cursor guards', () => {
  it.each([
    [{ sortOrder: 0, id: 'a' }, true],
    [{ sortOrder: -5, id: 'a' }, true],
    [{ sortOrder: 1.5, id: 'a' }, false],
    [{ sortOrder: '1', id: 'a' }, false],
    [{ sortOrder: 1 }, false],
    [{ id: 'a' }, false],
    [null, false],
    [[1, 'a'], false],
    ['cursor', false],
  ])('isSortOrderCursor(%j) = %p', (value, expected) => {
    expect(isSortOrderCursor(value)).toBe(expected);
  });

  it.each([
    [{ createdAt: T1.toISOString(), id: 'a' }, true],
    [{ createdAt: 'not a date', id: 'a' }, false],
    [{ createdAt: 123, id: 'a' }, false],
    [{ createdAt: T1.toISOString() }, false],
    [{ createdAt: T1.toISOString(), id: 7 }, false],
    [undefined, false],
  ])('isCreatedAtCursor(%j) = %p', (value, expected) => {
    expect(isCreatedAtCursor(value)).toBe(expected);
  });
});

describe('cursor builders', () => {
  it('build payloads from the last item', () => {
    expect(sortOrderCursorOf({ sortOrder: 3, id: 'x' })).toEqual({ sortOrder: 3, id: 'x' });
    expect(createdAtCursorOf({ createdAt: T1, id: 'x' })).toEqual({
      createdAt: '2026-11-01T10:00:00.000Z',
      id: 'x',
    });
  });
});

describe('ordering', () => {
  it('sorts by createdAt desc then id desc', () => {
    const rows = [
      { createdAt: T1, id: 'a' },
      { createdAt: T2, id: 'a' },
      { createdAt: T1, id: 'b' },
    ];
    expect([...rows].sort(compareCreatedAtDesc)).toEqual([
      { createdAt: T2, id: 'a' },
      { createdAt: T1, id: 'b' },
      { createdAt: T1, id: 'a' },
    ]);
  });

  it('sorts by sortOrder asc then id asc', () => {
    const rows = [
      { sortOrder: 2, id: 'a' },
      { sortOrder: 1, id: 'b' },
      { sortOrder: 1, id: 'a' },
    ];
    expect([...rows].sort(compareSortOrderAsc)).toEqual([
      { sortOrder: 1, id: 'a' },
      { sortOrder: 1, id: 'b' },
      { sortOrder: 2, id: 'a' },
    ]);
  });

  it('equal keys compare as 0', () => {
    expect(compareCreatedAtDesc({ createdAt: T1, id: 'a' }, { createdAt: T1, id: 'a' })).toBe(0);
    expect(compareSortOrderAsc({ sortOrder: 1, id: 'a' }, { sortOrder: 1, id: 'a' })).toBe(0);
  });
});

describe('position after a cursor', () => {
  const createdCursor = { createdAt: T2.toISOString(), id: 'm' };
  it.each([
    [{ createdAt: T1, id: 'z' }, true],
    [{ createdAt: T2, id: 'a' }, true],
    [{ createdAt: T2, id: 'm' }, false],
    [{ createdAt: T2, id: 'z' }, false],
    [{ createdAt: new Date(T2.getTime() + 1), id: 'a' }, false],
  ])('createdAt desc: %j after cursor = %p', (item, expected) => {
    expect(isAfterCreatedAtCursor(item, createdCursor)).toBe(expected);
  });

  const sortCursor = { sortOrder: 5, id: 'm' };
  it.each([
    [{ sortOrder: 6, id: 'a' }, true],
    [{ sortOrder: 5, id: 'z' }, true],
    [{ sortOrder: 5, id: 'm' }, false],
    [{ sortOrder: 5, id: 'a' }, false],
    [{ sortOrder: 4, id: 'z' }, false],
  ])('sortOrder asc: %j after cursor = %p', (item, expected) => {
    expect(isAfterSortOrderCursor(item, sortCursor)).toBe(expected);
  });
});
