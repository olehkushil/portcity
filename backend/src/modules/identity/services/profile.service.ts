import { Inject, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import {
  IDENTITY_EVENTS,
  OUTBOX_AGGREGATES,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { type ConsentChange, planConsentChanges } from '../domain/consents';
import { IdentityErrors } from '../domain/errors';
import { withCurrentVersions } from '../domain/legal';
import { type ProfilePatch, applyProfilePatch, computeProfileCompletion } from '../domain/profile';
import { assertUserCanAuthenticate } from '../domain/user-status';
import type { ConsentsResponseDto, PersonalDataExportDto, ProfileDto } from '../dto/me.dto';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity.config';
import { applyConsentOps } from './consent-ops';
import { IdentityStore, StoreConflictError } from './identity.store';
import {
  toChildDto,
  toConsentDtos,
  toDeletionRequestDto,
  toDeviceDto,
  toSessionDto,
  toUserDto,
} from './mappers';
import { announceCompletedProfileFields } from './profile-fields';

/** Sessions listed in the personal data export (most recent first). */
export const EXPORT_SESSION_LIMIT = 100;

export const EXPORT_NOTE =
  'Цей файл містить дані модуля identity: профіль, дітей, пристрої, згоди, сесії входу та запити на ' +
  'видалення. Бали, чеки, ваучери, паркування та платежі доступні в застосунку у відповідних ' +
  'розділах; повну копію за запитом надає служба підтримки.';

/**
 * The member's own account: GET/PATCH /me, consents and the personal data export.
 * Every call loads the user and refuses blocked (403) and deleted (410) accounts, because
 * access tokens stay valid for up to 15 minutes after a block (accepted risk: member access
 * tokens are stateless; see README).
 *
 * PATCH /me answers 409 PC_USER_EMAIL_TAKEN for an e-mail used by another account. That reveals
 * whether an e-mail is registered to an authenticated member (accepted enumeration risk: the
 * caller needs a member session and the global throttler applies; see README).
 */
@Injectable()
export class ProfileService {
  constructor(
    private readonly store: IdentityStore,
    private readonly clock: Clock,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
  ) {}

  async getProfile(userId: string, currentDeviceId?: string): Promise<ProfileDto> {
    const user = await this.requireActiveUser(userId);
    return this.buildProfile(user, currentDeviceId);
  }

  async updateProfile(
    userId: string,
    currentDeviceId: string | undefined,
    patch: ProfilePatch,
  ): Promise<ProfileDto> {
    const user = await this.requireActiveUser(userId);
    const now = this.clock.now();
    const preview = applyProfilePatch(user, patch, now);

    if (preview.emailChanged && preview.data.email) {
      const owner = await this.store.findUserByEmail(preview.data.email);
      if (owner && owner.id !== userId) {
        throw this.emailTaken();
      }
    }
    if (Object.keys(preview.data).length === 0) {
      return this.buildProfile(user, currentDeviceId);
    }

    const updated = await this.store.run(async (uow) => {
      // Row lock: the first-time events (profile_completed, profile_field_completed) are decided
      // on the locked row, so parallel PATCHes cannot both announce the same field.
      const current = (await uow.lockUser(userId)) ?? user;
      const result = applyProfilePatch(current, patch, now);
      let row: User = current;
      if (Object.keys(result.data).length > 0) {
        try {
          row = await uow.updateUser(userId, result.data);
        } catch (error) {
          if (StoreConflictError.is(error) && error.has('email')) {
            throw this.emailTaken();
          }
          throw error;
        }
      }
      if (result.completedNow && row.profileCompletedAt) {
        await uow.publish(
          buildOutboxEvent(IDENTITY_EVENTS.profileCompleted, OUTBOX_AGGREGATES.user, userId, {
            userId,
            completedAt: row.profileCompletedAt.toISOString(),
          }),
        );
      }
      return announceCompletedProfileFields(uow, row, now);
    });
    return this.buildProfile(updated, currentDeviceId);
  }

  async updateConsents(userId: string, changes: ConsentChange[]): Promise<ConsentsResponseDto> {
    await this.requireActiveUser(userId);
    const now = this.clock.now();
    const rows = await this.store.run(async (uow) => {
      const ops = planConsentChanges(
        await uow.listConsents(userId),
        withCurrentVersions(changes, this.config),
      );
      await applyConsentOps(uow, userId, ops, now);
      return uow.listConsents(userId);
    });
    return { consents: toConsentDtos(rows) };
  }

  /**
   * GET /me/export: everything identity stores about the member. Blocked members may export
   * their data too (right of access); only anonymised accounts are refused.
   */
  async exportPersonalData(
    userId: string,
    currentDeviceId?: string,
  ): Promise<PersonalDataExportDto> {
    const user = await this.store.findUserById(userId);
    if (!user) {
      throw new DomainError(IdentityErrors.PC_USER_NOT_FOUND, 'User not found');
    }
    if (user.status === 'deleted') {
      throw new DomainError(IdentityErrors.PC_USER_DELETED, 'This account has been deleted');
    }
    const now = this.clock.now();
    const [children, devices, consents, deletionRequests, sessions] = await Promise.all([
      this.store.listChildren(userId),
      this.store.listDevices(userId),
      this.store.listConsents(userId),
      this.store.listDeletionRequests(userId),
      this.store.listRefreshTokens(userId, EXPORT_SESSION_LIMIT),
    ]);
    return {
      exportedAt: now.toISOString(),
      user: toUserDto(user),
      children: children.map(toChildDto),
      devices: devices.map((device) => toDeviceDto(device, currentDeviceId)),
      consentHistory: consents.map((row) => ({
        purpose: row.purpose,
        granted: row.revokedAt === null,
        version: row.version,
        grantedAt: row.grantedAt.toISOString(),
        revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      })),
      deletionRequests: deletionRequests.map(toDeletionRequestDto),
      sessions: sessions.map((token) => toSessionDto(token, now)),
      note: EXPORT_NOTE,
    };
  }

  /** Loads the member for a request authenticated by an access token. */
  async requireActiveUser(userId: string): Promise<User> {
    const user = await this.store.findUserById(userId);
    if (!user) {
      throw new DomainError(IdentityErrors.PC_USER_NOT_FOUND, 'User not found');
    }
    assertUserCanAuthenticate(user.status);
    return user;
  }

  private async buildProfile(user: User, currentDeviceId?: string): Promise<ProfileDto> {
    const [consents, deletionRequest, device, children] = await Promise.all([
      this.store.listConsents(user.id),
      this.store.findPendingDeletionRequest(user.id),
      currentDeviceId ? this.store.findDeviceById(currentDeviceId) : Promise.resolve(null),
      this.store.listChildren(user.id),
    ]);
    return {
      user: toUserDto(user),
      children: children.map(toChildDto),
      profileCompletion: computeProfileCompletion(
        { ...user, childrenCount: children.length },
        {
          perField: this.config.PROFILE_BONUS_PER_FIELD,
          complete: this.config.PROFILE_BONUS_COMPLETE,
        },
      ),
      consents: toConsentDtos(consents),
      deletionRequest: deletionRequest ? toDeletionRequestDto(deletionRequest) : null,
      currentDevice:
        device && device.userId === user.id ? toDeviceDto(device, currentDeviceId) : null,
    };
  }

  private emailTaken(): DomainError {
    return new DomainError(
      IdentityErrors.PC_USER_EMAIL_TAKEN,
      'This e-mail is already used by another account',
    );
  }
}
