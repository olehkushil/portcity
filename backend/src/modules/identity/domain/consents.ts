import { CONSENT_PURPOSES, type ConsentPurpose } from '../../../common/contracts/identity';
import { DomainError } from '../../../common/errors/domain-error';
import { IdentityErrors } from './errors';

/** Version label of the consent text, e.g. `2026-10` or `v3`. */
export const CONSENT_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/;

export interface ConsentRowLike {
  id: string;
  purpose: ConsentPurpose;
  version: string;
  grantedAt: Date;
  revokedAt: Date | null;
}

export interface ConsentState {
  purpose: ConsentPurpose;
  granted: boolean;
  version: string | null;
  grantedAt: Date | null;
  revokedAt: Date | null;
}

export interface ConsentChange {
  purpose: ConsentPurpose;
  granted: boolean;
  /** Required when granting: the version of the text the member accepted. */
  version?: string;
}

export type ConsentOp =
  | { kind: 'grant'; purpose: ConsentPurpose; version: string }
  | { kind: 'revoke'; consentId: string };

/** Latest row per purpose (by grantedAt, then id, which is a time-ordered UUID v7). */
export function latestConsentRows(
  rows: readonly ConsentRowLike[],
): Map<ConsentPurpose, ConsentRowLike> {
  const latest = new Map<ConsentPurpose, ConsentRowLike>();
  for (const row of rows) {
    const current = latest.get(row.purpose);
    if (
      !current ||
      row.grantedAt.getTime() > current.grantedAt.getTime() ||
      (row.grantedAt.getTime() === current.grantedAt.getTime() && row.id > current.id)
    ) {
      latest.set(row.purpose, row);
    }
  }
  return latest;
}

/** One entry per purpose, in CONSENT_PURPOSES order; purposes never granted appear as not granted. */
export function currentConsents(rows: readonly ConsentRowLike[]): ConsentState[] {
  const latest = latestConsentRows(rows);
  return CONSENT_PURPOSES.map((purpose) => {
    const row = latest.get(purpose);
    if (!row) {
      return { purpose, granted: false, version: null, grantedAt: null, revokedAt: null };
    }
    return {
      purpose,
      granted: row.revokedAt === null,
      version: row.version,
      grantedAt: row.grantedAt,
      revokedAt: row.revokedAt,
    };
  });
}

/** Contract semantics: the latest consent for the purpose is granted and not revoked. */
export function hasActiveConsent(
  rows: readonly ConsentRowLike[],
  purpose: ConsentPurpose,
): boolean {
  const row = latestConsentRows(rows).get(purpose);
  return row !== undefined && row.revokedAt === null;
}

/**
 * Turns the requested changes into store operations:
 * - grant: no-op when the latest row is active with the same version, otherwise a new row
 *   (a new text version creates a new row, the old row stays as history);
 * - revoke: marks the latest active row revoked; nothing to do when none is active;
 * - the `program` purpose cannot be revoked here (the account would have to be deleted).
 */
export function planConsentChanges(
  rows: readonly ConsentRowLike[],
  changes: readonly ConsentChange[],
): ConsentOp[] {
  const latest = latestConsentRows(rows);
  const ops: ConsentOp[] = [];
  const seen = new Set<ConsentPurpose>();
  for (const change of changes) {
    if (seen.has(change.purpose)) {
      throw new DomainError(
        'PC_COMMON_VALIDATION',
        `Consent purpose "${change.purpose}" is listed more than once`,
      );
    }
    seen.add(change.purpose);
    const current = latest.get(change.purpose);
    if (change.granted) {
      const version = change.version?.trim() ?? '';
      if (!CONSENT_VERSION_PATTERN.test(version)) {
        throw new DomainError(
          'PC_COMMON_VALIDATION',
          `Granting "${change.purpose}" requires the version of the accepted text`,
        );
      }
      if (current && current.revokedAt === null && current.version === version) {
        continue;
      }
      ops.push({ kind: 'grant', purpose: change.purpose, version });
      continue;
    }
    if (change.purpose === 'program') {
      throw new DomainError(
        IdentityErrors.PC_CONSENT_PROGRAM_REQUIRED,
        'Participation consent is required for the account; use account deletion instead',
      );
    }
    if (current && current.revokedAt === null) {
      ops.push({ kind: 'revoke', consentId: current.id });
    }
  }
  return ops;
}
