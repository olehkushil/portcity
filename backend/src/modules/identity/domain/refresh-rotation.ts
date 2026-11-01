/**
 * Refresh token rotation rules (brief section 3): opaque tokens, rotated on every refresh,
 * reuse of a rotated token revokes the whole family.
 */
export interface RefreshTokenLike {
  expiresAt: Date;
  revokedAt: Date | null;
  /** Set when the token was rotated; the successor id. */
  replacedById: string | null;
}

export type RefreshDecision = 'rotate' | 'reused' | 'revoked' | 'expired';

/**
 * A rotated token presented again within this many seconds after its rotation is treated as
 * a plain invalid token (no family revocation): mobile clients sometimes fire two refreshes
 * at once and the second one must not log the member out. After the window it is a reuse.
 */
export const REFRESH_REUSE_GRACE_SECONDS = 10;

export interface RefreshDecisionOptions {
  reuseGraceSeconds?: number;
}

/**
 * - rotated token presented again -> `reused` (theft indicator: revoke the family), except
 *   inside the short grace window after rotation -> `revoked`;
 * - token revoked by logout, block or an earlier reuse -> `revoked` (plain 401);
 * - past `expiresAt` -> `expired`;
 * - otherwise -> `rotate`.
 */
export function decideRefresh(
  token: RefreshTokenLike,
  now: Date,
  options: RefreshDecisionOptions = {},
): RefreshDecision {
  const grace = (options.reuseGraceSeconds ?? REFRESH_REUSE_GRACE_SECONDS) * 1000;
  if (token.replacedById !== null) {
    if (token.revokedAt !== null && now.getTime() - token.revokedAt.getTime() < grace) {
      return 'revoked';
    }
    return 'reused';
  }
  if (token.revokedAt !== null) {
    return 'revoked';
  }
  if (token.expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  return 'rotate';
}

/** Active session = usable refresh token: not rotated, not revoked, not expired. */
export function isActiveSession(token: RefreshTokenLike, now: Date): boolean {
  return decideRefresh(token, now) === 'rotate';
}
