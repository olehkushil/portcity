import { decodeCursor, encodeCursor } from '../../../common/pagination/cursor';
import { cursorOf, isListCursor, keysetWhere } from './list-cursor';

describe('list cursor', () => {
  const createdAt = new Date('2026-01-15T10:00:00.123Z');

  it('builds a cursor from the last row and recognises it after a round trip', () => {
    const cursor = cursorOf({ createdAt, id: 'row-1' });
    expect(cursor).toEqual({ createdAt: '2026-01-15T10:00:00.123Z', id: 'row-1' });
    expect(decodeCursor(encodeCursor(cursor), isListCursor)).toEqual(cursor);
  });

  it.each<[string, unknown, boolean]>([
    ['valid', { createdAt: '2026-01-15T10:00:00.000Z', id: 'x' }, true],
    ['missing id', { createdAt: '2026-01-15T10:00:00.000Z' }, false],
    ['empty id', { createdAt: '2026-01-15T10:00:00.000Z', id: '' }, false],
    ['bad date', { createdAt: 'yesterday', id: 'x' }, false],
    ['numeric date', { createdAt: 1700000000, id: 'x' }, false],
    ['array', [], false],
    ['null', null, false],
    ['string', 'cursor', false],
  ])('%s cursor valid: %s', (_name, value, expected) => {
    expect(isListCursor(value)).toBe(expected);
  });

  it('rejects a cursor that does not match this list with PC_COMMON_CURSOR_INVALID', () => {
    const foreign = encodeCursor({ offset: 10 });
    expect(() => decodeCursor(foreign, isListCursor)).toThrow(/does not match this list/);
  });

  it('selects rows strictly after the cursor in (createdAt desc, id desc) order', () => {
    expect(keysetWhere({ createdAt: '2026-01-15T10:00:00.123Z', id: 'row-1' })).toEqual({
      OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: 'row-1' } }],
    });
  });
});
