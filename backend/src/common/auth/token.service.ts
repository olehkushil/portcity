import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { APP_CONFIG, type AppConfig } from '../config';
import { DomainError } from '../errors/domain-error';
import { CommonErrors } from '../errors/error-codes';
import { Clock } from '../time/clock';
import {
  type AccessTokenClaims,
  type AuthenticatedUser,
  type IssuedAccessToken,
  PRINCIPAL_TYPES,
  type PrincipalType,
  type SignAccessTokenInput,
} from './auth.types';
import { randomToken, sha256Hex } from './crypto';
import { type JwtClaims, JwtError, signJwtHs256, verifyJwtHs256 } from './jwt';

const CLOCK_TOLERANCE_SECONDS = 5;

/** Issues and verifies access JWTs (HS256) and derives refresh-token hashes. */
@Injectable()
export class TokenService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  signAccessToken(input: SignAccessTokenInput): IssuedAccessToken {
    const iat = Math.floor(this.clock.nowMs() / 1000);
    const ttl = input.ttlSeconds ?? this.config.JWT_ACCESS_TTL_SECONDS;
    const exp = iat + ttl;
    const jti = uuidv7();
    const claims: AccessTokenClaims = {
      iss: this.config.JWT_ISSUER,
      sub: input.sub,
      typ: input.type,
      roles: input.roles ?? [],
      jti,
      iat,
      exp,
    };
    if (input.deviceId) {
      claims.did = input.deviceId;
    }
    const token = signJwtHs256({ ...input.extraClaims, ...claims }, this.config.JWT_SECRET);
    return { token, expiresAt: new Date(exp * 1000), jti };
  }

  /** Throws PC_AUTH_TOKEN_EXPIRED / PC_AUTH_TOKEN_INVALID. */
  verifyAccessToken(token: string): AccessTokenClaims {
    let claims: JwtClaims;
    try {
      claims = verifyJwtHs256(token, this.config.JWT_SECRET, {
        now: this.clock.now(),
        issuer: this.config.JWT_ISSUER,
        clockToleranceSeconds: CLOCK_TOLERANCE_SECONDS,
      });
    } catch (error) {
      if (error instanceof JwtError && error.reason === 'expired') {
        throw new DomainError(CommonErrors.PC_AUTH_TOKEN_EXPIRED, 'Access token has expired', {
          cause: error,
        });
      }
      throw new DomainError(CommonErrors.PC_AUTH_TOKEN_INVALID, 'Access token is invalid', {
        cause: error,
      });
    }
    return parseAccessClaims(claims);
  }

  toAuthenticatedUser(claims: AccessTokenClaims): AuthenticatedUser {
    const user: AuthenticatedUser = {
      id: claims.sub,
      type: claims.typ,
      roles: claims.roles,
      tokenId: claims.jti,
      tokenExpiresAt: new Date(claims.exp * 1000),
    };
    if (claims.did) {
      user.deviceId = claims.did;
    }
    return user;
  }

  /** Opaque refresh token: the raw value goes to the client, only the hash is stored. */
  generateRefreshToken(): { raw: string; hash: string } {
    const raw = randomToken(32);
    return { raw, hash: this.hashRefreshToken(raw) };
  }

  hashRefreshToken(raw: string): string {
    return sha256Hex(raw);
  }

  refreshTokenExpiresAt(from: Date = this.clock.now()): Date {
    return new Date(from.getTime() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  }
}

function isPrincipalType(value: unknown): value is PrincipalType {
  return typeof value === 'string' && (PRINCIPAL_TYPES as readonly string[]).includes(value);
}

export function parseAccessClaims(claims: JwtClaims): AccessTokenClaims {
  const invalid = (reason: string): DomainError =>
    new DomainError(CommonErrors.PC_AUTH_TOKEN_INVALID, `Access token is invalid: ${reason}`);

  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw invalid('missing sub');
  }
  if (!isPrincipalType(claims['typ'])) {
    throw invalid('unknown principal type');
  }
  const roles = claims['roles'] ?? [];
  if (!Array.isArray(roles) || !roles.every((role) => typeof role === 'string')) {
    throw invalid('roles must be a string array');
  }
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
    throw invalid('missing exp/iat');
  }
  if (typeof claims.jti !== 'string' || claims.jti.length === 0) {
    throw invalid('missing jti');
  }
  const parsed: AccessTokenClaims = {
    sub: claims.sub,
    typ: claims['typ'],
    roles: roles,
    jti: claims.jti,
    iat: claims.iat,
    exp: claims.exp,
  };
  if (typeof claims.iss === 'string') {
    parsed.iss = claims.iss;
  }
  if (typeof claims['did'] === 'string') {
    parsed.did = claims['did'];
  }
  return parsed;
}
