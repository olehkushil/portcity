import { Injectable, Logger } from '@nestjs/common';
import type { User } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { TokenService } from '../../../common/auth/token.service';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { IdentityErrors } from '../domain/errors';
import { decideRefresh } from '../domain/refresh-rotation';
import { assertUserCanAuthenticate } from '../domain/user-status';
import type { SessionTokensDto } from '../dto/common.dto';
import { IdentityStore, type IdentityUow } from './identity.store';

export interface IssuedSession {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  refreshTokenId: string;
  family: string;
  deviceId: string | null;
}

export interface RefreshOutcome {
  session: IssuedSession;
  user: User;
}

export interface LogoutInput {
  refreshToken?: string;
  allDevices?: boolean;
}

export function toSessionTokensDto(session: IssuedSession): SessionTokensDto {
  return {
    tokenType: 'Bearer',
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
    refreshToken: session.refreshToken,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt.toISOString(),
  };
}

/**
 * Member sessions (brief section 3): access JWT (15 min, claims sub/typ/did) plus an opaque
 * refresh token stored as SHA-256 with a family id. Every refresh rotates the token; a rotated
 * token presented again outside the grace window revokes the whole family.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly store: IdentityStore,
    private readonly tokens: TokenService,
    private readonly clock: Clock,
  ) {}

  /** New login: a fresh family. Older families of the same device are revoked first. */
  async startSession(
    uow: IdentityUow,
    userId: string,
    deviceId: string | null,
    now: Date,
  ): Promise<IssuedSession> {
    if (deviceId) {
      await uow.revokeRefreshTokens({ userId, deviceId }, now);
    }
    return this.issue(uow, userId, deviceId, uuidv7(), now);
  }

  async refresh(rawToken: string): Promise<RefreshOutcome> {
    const now = this.clock.now();
    const token = await this.store.findRefreshTokenByHash(this.tokens.hashRefreshToken(rawToken));
    if (!token) {
      throw new DomainError(IdentityErrors.PC_REFRESH_INVALID, 'Refresh token is not recognised');
    }

    const decision = decideRefresh(token, now);
    if (decision === 'reused') {
      const revoked = await this.store.run((uow) =>
        uow.revokeRefreshTokens({ family: token.family }, now),
      );
      this.logger.warn(
        `Refresh token reuse for user ${token.userId}: family ${token.family} revoked (${revoked} tokens)`,
      );
      throw new DomainError(
        IdentityErrors.PC_REFRESH_REUSED,
        'This refresh token was already used; all sessions of this login were ended',
      );
    }
    if (decision === 'expired') {
      throw new DomainError(IdentityErrors.PC_REFRESH_INVALID, 'Refresh token has expired');
    }
    if (decision === 'revoked') {
      throw new DomainError(IdentityErrors.PC_REFRESH_INVALID, 'Refresh token was revoked');
    }

    const user = await this.store.findUserById(token.userId);
    if (!user || user.status !== 'active') {
      await this.store.run((uow) => uow.revokeRefreshTokens({ family: token.family }, now));
      if (!user) {
        throw new DomainError(IdentityErrors.PC_REFRESH_INVALID, 'Refresh token owner is gone');
      }
      assertUserCanAuthenticate(user.status);
    }

    const session = await this.store.run(async (uow) => {
      const claimed = await uow.claimRefreshToken(token.id, now);
      if (!claimed) {
        // A concurrent refresh with the same token won the race.
        throw new DomainError(IdentityErrors.PC_REFRESH_INVALID, 'Refresh token was already used');
      }
      const next = await this.issue(uow, token.userId, token.deviceId, token.family, now);
      await uow.linkReplacedBy(token.id, next.refreshTokenId);
      if (token.deviceId) {
        const device = await uow.findDeviceById(token.deviceId);
        if (device) {
          await uow.updateDevice(device.id, { lastSeenAt: now });
        }
      }
      return next;
    });
    return { session, user };
  }

  /**
   * Ends sessions and stops push to the affected devices:
   * - `allDevices`: every session of the member;
   * - `refreshToken`: the login (family) of that token, if it belongs to the member;
   * - otherwise: the sessions of the device bound to the access token.
   * Access tokens already issued stay valid until they expire (stateless JWT, 15 min).
   */
  async logout(
    userId: string,
    currentDeviceId: string | undefined,
    input: LogoutInput,
  ): Promise<number> {
    const now = this.clock.now();
    if (input.allDevices) {
      return this.store.run(async (uow) => {
        const revoked = await uow.revokeRefreshTokens({ userId }, now);
        await uow.clearPushTokens({ userId });
        return revoked;
      });
    }
    if (input.refreshToken) {
      const token = await this.store.findRefreshTokenByHash(
        this.tokens.hashRefreshToken(input.refreshToken),
      );
      if (!token || token.userId !== userId) {
        return 0;
      }
      return this.store.run(async (uow) => {
        const revoked = await uow.revokeRefreshTokens({ userId, family: token.family }, now);
        if (token.deviceId) {
          await uow.clearPushTokens({ userId, deviceId: token.deviceId });
        }
        return revoked;
      });
    }
    if (!currentDeviceId) {
      return 0;
    }
    return this.store.run(async (uow) => {
      const revoked = await uow.revokeRefreshTokens({ userId, deviceId: currentDeviceId }, now);
      await uow.clearPushTokens({ userId, deviceId: currentDeviceId });
      return revoked;
    });
  }

  private async issue(
    uow: IdentityUow,
    userId: string,
    deviceId: string | null,
    family: string,
    now: Date,
  ): Promise<IssuedSession> {
    const refresh = this.tokens.generateRefreshToken();
    const refreshTokenExpiresAt = this.tokens.refreshTokenExpiresAt(now);
    const row = await uow.createRefreshToken({
      id: uuidv7(),
      userId,
      deviceId,
      family,
      tokenHash: refresh.hash,
      expiresAt: refreshTokenExpiresAt,
      createdAt: now,
    });
    const access = this.tokens.signAccessToken({
      sub: userId,
      type: 'member',
      ...(deviceId ? { deviceId } : {}),
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.raw,
      refreshTokenExpiresAt,
      refreshTokenId: row.id,
      family,
      deviceId,
    };
  }
}
