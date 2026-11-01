import { Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { UserStatus } from '../../../common/contracts/identity';
import {
  IDENTITY_EVENTS,
  OUTBOX_AGGREGATES,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import { DomainError } from '../../../common/errors/domain-error';
import { clampLimit, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { Clock } from '../../../common/time/clock';
import { IdentityErrors } from '../domain/errors';
import { parseUserSearchQuery } from '../domain/user-search';
import { assertUserTransition } from '../domain/user-status';
import type {
  AdminMemberDto,
  AdminUserDetailsDto,
  AdminUserPageDto,
  RevokeSessionsResponseDto,
} from '../dto/admin.dto';
import { IdentityStore, type UserCursor } from './identity.store';
import { toAdminMemberDto, toConsentDtos, toDeletionRequestDto, toDeviceDto } from './mappers';

export interface AdminUserSearchInput {
  q?: string;
  status?: UserStatus;
  cursor?: string;
  limit?: number;
}

export interface AdminActor {
  id: string;
  ip?: string | null;
}

function isUserCursor(value: unknown): value is UserCursor & Record<string, string> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['createdAt'] === 'string' &&
    !Number.isNaN(Date.parse(record['createdAt'])) &&
    typeof record['id'] === 'string'
  );
}

/**
 * Back-office member lookup and support actions (`/admin/users`). Phones are always masked;
 * viewing a member card and every mutation are written to the audit log.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly store: IdentityStore,
    private readonly clock: Clock,
  ) {}

  async search(input: AdminUserSearchInput): Promise<AdminUserPageDto> {
    const limit = clampLimit(input.limit);
    const cursor = decodeCursor(input.cursor, isUserCursor);
    const rows = await this.store.searchUsers({
      terms: parseUserSearchQuery(input.q),
      ...(input.status ? { status: input.status } : {}),
      ...(cursor ? { cursor: { createdAt: cursor.createdAt, id: cursor.id } } : {}),
      limit,
    });
    const page = toPage(rows, limit, (last) => ({
      createdAt: last.createdAt.toISOString(),
      id: last.id,
    }));
    return { items: page.items.map(toAdminMemberDto), nextCursor: page.nextCursor };
  }

  async getDetails(userId: string, actor: AdminActor): Promise<AdminUserDetailsDto> {
    const user = await this.requireUser(userId);
    const now = this.clock.now();
    const [devices, consents, deletionRequest, sessions] = await Promise.all([
      this.store.listDevices(userId),
      this.store.listConsents(userId),
      this.store.findPendingDeletionRequest(userId),
      this.store.listActiveSessions(userId, now),
    ]);
    await this.store.run((uow) =>
      uow.audit({
        actor: { type: 'admin', id: actor.id },
        action: 'user.view',
        entityType: 'user',
        entityId: userId,
        ip: actor.ip ?? null,
      }),
    );
    return {
      user: toAdminMemberDto(user),
      devices: devices.map((device) => toDeviceDto(device)),
      consents: toConsentDtos(consents),
      deletionRequest: deletionRequest ? toDeletionRequestDto(deletionRequest) : null,
      activeSessions: sessions.length,
    };
  }

  /** Blocks the member: sessions are revoked, refresh and every member endpoint answer 403. */
  async block(userId: string, reason: string, actor: AdminActor): Promise<AdminMemberDto> {
    const user = await this.requireUser(userId);
    assertUserTransition(user.status, 'blocked');
    const now = this.clock.now();
    const updated = await this.store.run(async (uow) => {
      const row = await uow.updateUser(userId, { status: 'blocked' });
      await uow.revokeRefreshTokens({ userId }, now);
      await uow.publish(
        buildOutboxEvent(IDENTITY_EVENTS.blocked, OUTBOX_AGGREGATES.user, userId, {
          userId,
          reason,
        }),
      );
      await uow.audit({
        actor: { type: 'admin', id: actor.id },
        action: 'user.block',
        entityType: 'user',
        entityId: userId,
        before: { status: user.status },
        after: { status: 'blocked' },
        reason,
        ip: actor.ip ?? null,
      });
      return row;
    });
    return toAdminMemberDto(updated);
  }

  async unblock(userId: string, reason: string, actor: AdminActor): Promise<AdminMemberDto> {
    const user = await this.requireUser(userId);
    assertUserTransition(user.status, 'active');
    const updated = await this.store.run(async (uow) => {
      const row = await uow.updateUser(userId, { status: 'active' });
      await uow.publish(
        buildOutboxEvent(IDENTITY_EVENTS.unblocked, OUTBOX_AGGREGATES.user, userId, {
          userId,
          reason,
        }),
      );
      await uow.audit({
        actor: { type: 'admin', id: actor.id },
        action: 'user.unblock',
        entityType: 'user',
        entityId: userId,
        before: { status: user.status },
        after: { status: 'active' },
        reason,
        ip: actor.ip ?? null,
      });
      return row;
    });
    return toAdminMemberDto(updated);
  }

  /** Logs the member out everywhere (lost phone, suspected takeover). */
  async revokeSessions(
    userId: string,
    reason: string,
    actor: AdminActor,
  ): Promise<RevokeSessionsResponseDto> {
    await this.requireUser(userId);
    const now = this.clock.now();
    const revokedSessions = await this.store.run(async (uow) => {
      const revoked = await uow.revokeRefreshTokens({ userId }, now);
      await uow.clearPushTokens({ userId });
      await uow.audit({
        actor: { type: 'admin', id: actor.id },
        action: 'user.revoke_sessions',
        entityType: 'user',
        entityId: userId,
        after: { revokedSessions: revoked },
        reason,
        ip: actor.ip ?? null,
      });
      return revoked;
    });
    return { userId, revokedSessions };
  }

  private async requireUser(userId: string): Promise<User> {
    const user = await this.store.findUserById(userId);
    if (!user) {
      throw new DomainError(IdentityErrors.PC_USER_NOT_FOUND, 'User not found');
    }
    return user;
  }
}
