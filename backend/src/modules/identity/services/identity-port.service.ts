import { Injectable } from '@nestjs/common';
import type {
  AdminAccess,
  ConsentPurpose,
  DeviceSummary,
  IdentityPort,
  MarketingAudiencePage,
  UserSummary,
} from '../../../common/contracts/identity';
import type { Tx } from '../../../common/contracts/shared';
import { hasActiveConsent } from '../domain/consents';
import { isWellFormedMemberCode } from '../domain/member-code';
import { IdentityStore } from './identity.store';
import { toDeviceSummary, toUserSummary } from './mappers';

/** Page size bounds of listMarketingAudience. */
export const MARKETING_AUDIENCE_MAX_PAGE = 1000;

/**
 * IDENTITY_PORT implementation for club, notifications, admin and the shared AdminGuard
 * (read-only).
 */
@Injectable()
export class IdentityPortService implements IdentityPort {
  constructor(private readonly store: IdentityStore) {}

  async getUser(userId: string, tx?: Tx): Promise<UserSummary | null> {
    const user = await this.store.bind(tx).findUserById(userId);
    return user ? toUserSummary(user) : null;
  }

  async getUsers(userIds: readonly string[]): Promise<UserSummary[]> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) {
      return [];
    }
    const users = await this.store.findUsersByIds(unique);
    return users.map(toUserSummary);
  }

  async getDevice(deviceId: string): Promise<DeviceSummary | null> {
    const device = await this.store.findDeviceById(deviceId);
    return device ? toDeviceSummary(device) : null;
  }

  async resolveMemberCode(memberCode: string): Promise<UserSummary | null> {
    const code = memberCode.replace(/\s+/g, '');
    if (!isWellFormedMemberCode(code)) {
      return null;
    }
    const user = await this.store.findUserByMemberCode(code);
    return user ? toUserSummary(user) : null;
  }

  async listPushDevices(userId: string): Promise<DeviceSummary[]> {
    const devices = await this.store.listPushDevices(userId);
    return devices.map(toDeviceSummary);
  }

  async hasConsent(userId: string, purpose: ConsentPurpose): Promise<boolean> {
    return hasActiveConsent(await this.store.listConsents(userId), purpose);
  }

  async listMarketingAudience(
    cursor: string | null,
    limit: number,
  ): Promise<MarketingAudiencePage> {
    const size = Math.min(
      MARKETING_AUDIENCE_MAX_PAGE,
      Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 1),
    );
    const ids = await this.store.listMarketingAudience(cursor, size + 1);
    const userIds = ids.slice(0, size);
    const nextCursor = ids.length > size ? (userIds[userIds.length - 1] ?? null) : null;
    return { userIds, nextCursor };
  }

  async getAdminAccess(adminId: string): Promise<AdminAccess | null> {
    const admin = await this.store.findAdminById(adminId);
    return admin ? { active: admin.active, role: admin.role } : null;
  }
}
