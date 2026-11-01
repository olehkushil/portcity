import type { IncomingHttpHeaders } from 'node:http';

export const PRINCIPAL_TYPES = ['member', 'admin'] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const ADMIN_ROLES = ['owner', 'manager', 'moderator', 'support', 'validator'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Claims carried by an access JWT (brief section 3). */
export interface AccessTokenClaims {
  iss?: string;
  sub: string;
  typ: PrincipalType;
  roles: string[];
  /** Device id for member tokens. */
  did?: string;
  jti: string;
  iat: number;
  exp: number;
}

/** What guards attach to `request.user`. */
export interface AuthenticatedUser {
  id: string;
  type: PrincipalType;
  roles: string[];
  deviceId?: string;
  tokenId: string;
  tokenExpiresAt: Date;
}

export interface AuthenticatedRequest {
  user?: AuthenticatedUser;
  headers: IncomingHttpHeaders;
  id?: unknown;
  ip?: string;
  method?: string;
  originalUrl?: string;
  url?: string;
}

export interface SignAccessTokenInput {
  sub: string;
  type: PrincipalType;
  roles?: string[];
  deviceId?: string;
  ttlSeconds?: number;
  /** Additional claims; standard claims above always win. */
  extraClaims?: Record<string, unknown>;
}

export interface IssuedAccessToken {
  token: string;
  expiresAt: Date;
  jti: string;
}
