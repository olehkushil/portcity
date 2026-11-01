import type { FeatureFlagView } from '../../../common/contracts/admin';
import { DomainError } from '../../../common/errors/domain-error';
import { canonicalJson } from '../../../common/idempotency/request-hash';
import { AdminErrors } from './errors';

/**
 * Feature flag rules: key format (`parking.info_mode`), payload normalisation and change
 * detection used by the admin CRUD (the read side lives in src/common/feature-flags).
 */

export const FEATURE_FLAG_KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
export const FEATURE_FLAG_KEY_MAX_LENGTH = 100;

export function isValidFeatureFlagKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length <= FEATURE_FLAG_KEY_MAX_LENGTH &&
    FEATURE_FLAG_KEY_PATTERN.test(key)
  );
}

export function assertFeatureFlagKey(key: unknown): asserts key is string {
  if (!isValidFeatureFlagKey(key)) {
    throw new DomainError(
      AdminErrors.PC_FEATURE_FLAG_KEY_INVALID,
      `Feature flag key must be lowercase dotted segments like "parking.info_mode" (max ${FEATURE_FLAG_KEY_MAX_LENGTH} chars)`,
      { details: { key: typeof key === 'string' ? key : String(key) } },
    );
  }
}

export function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface FeatureFlagSnapshot {
  key: string;
  enabled: boolean;
  payload: Record<string, unknown> | null;
}

export interface FeatureFlagRowLike {
  key: string;
  enabled: boolean;
  payload: unknown;
  updatedAt: Date;
}

export function toFeatureFlagSnapshot(
  row: Omit<FeatureFlagRowLike, 'updatedAt'>,
): FeatureFlagSnapshot {
  return {
    key: row.key,
    enabled: row.enabled,
    payload: isPlainJsonObject(row.payload) ? row.payload : null,
  };
}

export function toFeatureFlagView(row: FeatureFlagRowLike): FeatureFlagView {
  return { ...toFeatureFlagSnapshot(row), updatedAt: row.updatedAt };
}

export interface FeatureFlagUpdate {
  enabled: boolean;
  /** Omitted: keep the stored payload; null: clear it; object: replace it. */
  payload?: Record<string, unknown> | null;
}

/** State after applying `update` to `before` (null when the flag does not exist yet). */
export function nextFeatureFlagState(
  before: FeatureFlagSnapshot | null,
  key: string,
  update: FeatureFlagUpdate,
): FeatureFlagSnapshot {
  let payload: Record<string, unknown> | null;
  if (update.payload === undefined) {
    payload = before?.payload ?? null;
  } else if (update.payload === null) {
    payload = null;
  } else {
    payload = isPlainJsonObject(update.payload) ? update.payload : null;
  }
  return { key, enabled: update.enabled, payload };
}

/** Deep comparison through canonical JSON (key order does not matter). */
export function featureFlagChanged(
  before: FeatureFlagSnapshot | null,
  after: FeatureFlagSnapshot,
): boolean {
  if (before === null) {
    return true;
  }
  return canonicalJson(before) !== canonicalJson(after);
}
