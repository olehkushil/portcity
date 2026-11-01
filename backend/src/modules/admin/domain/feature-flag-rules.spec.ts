import { DomainError } from '../../../common/errors/domain-error';
import {
  FEATURE_FLAG_KEY_MAX_LENGTH,
  assertFeatureFlagKey,
  featureFlagChanged,
  isValidFeatureFlagKey,
  nextFeatureFlagState,
  toFeatureFlagSnapshot,
  toFeatureFlagView,
} from './feature-flag-rules';

describe('feature flag keys', () => {
  it.each<[unknown, boolean]>([
    ['parking.info_mode', true],
    ['receipts.manual_submission', true],
    ['events.registration', true],
    ['a', true],
    ['a1.b_2.c3', true],
    ['x'.repeat(FEATURE_FLAG_KEY_MAX_LENGTH), true],
    ['x'.repeat(FEATURE_FLAG_KEY_MAX_LENGTH + 1), false],
    ['', false],
    ['Parking.Info', false],
    ['parking..mode', false],
    ['.parking', false],
    ['parking.', false],
    ['parking-mode', false],
    ['parking mode', false],
    ['1parking', false],
    [42, false],
    [null, false],
  ])('%p valid: %s', (key, expected) => {
    expect(isValidFeatureFlagKey(key)).toBe(expected);
    if (expected) {
      expect(() => assertFeatureFlagKey(key)).not.toThrow();
    } else {
      let caught: unknown;
      try {
        assertFeatureFlagKey(key);
      } catch (error) {
        caught = error;
      }
      expect(DomainError.is(caught)).toBe(true);
      expect((caught as DomainError).code).toBe('PC_FEATURE_FLAG_KEY_INVALID');
      expect((caught as DomainError).status).toBe(400);
    }
  });
});

describe('snapshots and views', () => {
  it('normalises non-object payloads to null', () => {
    expect(toFeatureFlagSnapshot({ key: 'k', enabled: true, payload: [1, 2] })).toEqual({
      key: 'k',
      enabled: true,
      payload: null,
    });
    expect(toFeatureFlagSnapshot({ key: 'k', enabled: false, payload: 'text' }).payload).toBeNull();
    expect(toFeatureFlagSnapshot({ key: 'k', enabled: false, payload: { a: 1 } }).payload).toEqual({
      a: 1,
    });
  });

  it('keeps updatedAt on views', () => {
    const updatedAt = new Date('2026-01-15T10:00:00.000Z');
    expect(toFeatureFlagView({ key: 'k', enabled: true, payload: null, updatedAt })).toEqual({
      key: 'k',
      enabled: true,
      payload: null,
      updatedAt,
    });
  });
});

describe('nextFeatureFlagState', () => {
  const before = { key: 'parking.info_mode', enabled: true, payload: { zones: ['surface'] } };

  it.each<
    [
      string,
      typeof before | null,
      { enabled: boolean; payload?: Record<string, unknown> | null },
      Record<string, unknown> | null,
    ]
  >([
    ['new flag without payload', null, { enabled: true }, null],
    ['new flag with payload', null, { enabled: false, payload: { a: 1 } }, { a: 1 }],
    ['omitted payload keeps the stored one', before, { enabled: false }, { zones: ['surface'] }],
    ['null payload clears it', before, { enabled: true, payload: null }, null],
    ['object payload replaces it', before, { enabled: true, payload: { b: 2 } }, { b: 2 }],
  ])('%s', (_name, previous, update, expectedPayload) => {
    expect(nextFeatureFlagState(previous, 'parking.info_mode', update)).toEqual({
      key: 'parking.info_mode',
      enabled: update.enabled,
      payload: expectedPayload,
    });
  });
});

describe('featureFlagChanged', () => {
  it('treats creation as a change', () => {
    expect(featureFlagChanged(null, { key: 'k', enabled: false, payload: null })).toBe(true);
  });

  it('ignores JSON key order', () => {
    expect(
      featureFlagChanged(
        { key: 'k', enabled: true, payload: { a: 1, b: { c: 2, d: 3 } } },
        { key: 'k', enabled: true, payload: { b: { d: 3, c: 2 }, a: 1 } },
      ),
    ).toBe(false);
  });

  it('detects toggles and payload edits', () => {
    const base = { key: 'k', enabled: true, payload: { a: 1 } };
    expect(featureFlagChanged(base, { ...base, enabled: false })).toBe(true);
    expect(featureFlagChanged(base, { ...base, payload: { a: 2 } })).toBe(true);
    expect(featureFlagChanged(base, { ...base, payload: null })).toBe(true);
  });
});
