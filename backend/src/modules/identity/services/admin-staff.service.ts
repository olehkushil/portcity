import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AdminUser } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { AdminAccessGate } from '../../../common/auth/admin-access';
import { type ScryptParams, hashPassword, scryptParamsWithLogN } from '../../../common/auth/crypto';
import type { AdminRole } from '../../../common/auth/auth.types';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { IdentityErrors } from '../domain/errors';
import type { AdminUserDto } from '../dto/common.dto';
import type { AdminUserListDto } from '../dto/admin.dto';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity.config';
import { type AdminUpdateData, IdentityStore, StoreConflictError } from './identity.store';
import { toAdminUserDto } from './mappers';
import type { AdminActor } from './admin-users.service';

export interface CreateAdminInput {
  email: string;
  password: string;
  role: AdminRole;
  name?: string;
}

export interface UpdateAdminInput {
  role?: AdminRole;
  active?: boolean;
  name?: string | null;
  password?: string;
}

/** Audit snapshot without secrets. */
function snapshot(admin: AdminUser): Record<string, unknown> {
  return {
    email: admin.email,
    role: admin.role,
    name: admin.name,
    active: admin.active,
    totpEnabled: admin.totpSecret !== null,
  };
}

/**
 * Back-office accounts (`/admin/admin-users`, owner only): list, create, change role, name,
 * password or activity. Accounts are deactivated, never deleted (other tables reference them).
 * The last active owner cannot be demoted or deactivated, and nobody deactivates or demotes
 * themselves. Every change is audited without password hashes or TOTP secrets.
 */
@Injectable()
export class AdminStaffService {
  /** New and changed passwords use the admin cost (ADMIN_PASSWORD_SCRYPT_LOG_N, N = 2^17). */
  private readonly passwordParams: ScryptParams;

  constructor(
    private readonly store: IdentityStore,
    private readonly clock: Clock,
    @Inject(IDENTITY_CONFIG) config: IdentityConfig,
    /** Cache of the shared AdminGuard; optional so unit tests can build the service bare. */
    @Optional() private readonly adminAccess?: AdminAccessGate,
  ) {
    this.passwordParams = scryptParamsWithLogN(config.ADMIN_PASSWORD_SCRYPT_LOG_N);
  }

  async list(): Promise<AdminUserListDto> {
    const admins = await this.store.listAdmins();
    return { items: admins.map(toAdminUserDto) };
  }

  async create(input: CreateAdminInput, actor: AdminActor): Promise<AdminUserDto> {
    const email = input.email.trim().toLowerCase();
    if (await this.store.findAdminByEmail(email)) {
      throw this.emailTaken();
    }
    const passwordHash = await hashPassword(input.password, this.passwordParams);
    const now = this.clock.now();
    const created = await this.store.run(async (uow) => {
      let admin: AdminUser;
      try {
        admin = await uow.createAdmin({
          id: uuidv7(),
          email,
          passwordHash,
          role: input.role,
          name: input.name?.trim() ? input.name.trim() : null,
          active: true,
          createdAt: now,
        });
      } catch (error) {
        if (StoreConflictError.is(error) && error.has('email')) {
          throw this.emailTaken();
        }
        throw error;
      }
      await uow.audit({
        actor: { type: 'admin', id: actor.id },
        action: 'admin_user.create',
        entityType: 'admin_user',
        entityId: admin.id,
        after: snapshot(admin),
        ip: actor.ip ?? null,
      });
      return admin;
    });
    return toAdminUserDto(created);
  }

  async update(adminId: string, input: UpdateAdminInput, actor: AdminActor): Promise<AdminUserDto> {
    const admin = await this.store.findAdminById(adminId);
    if (!admin) {
      throw new DomainError(IdentityErrors.PC_ADMIN_NOT_FOUND, 'Admin user not found');
    }
    const data: AdminUpdateData = {};
    if (input.role !== undefined && input.role !== admin.role) {
      data.role = input.role;
    }
    if (input.active !== undefined && input.active !== admin.active) {
      data.active = input.active;
    }
    if (input.name !== undefined) {
      data.name = input.name?.trim() ? input.name.trim() : null;
    }

    const losesOwner =
      admin.role === 'owner' &&
      admin.active &&
      ((data.role !== undefined && data.role !== 'owner') || data.active === false);
    if (adminId === actor.id && (data.active === false || losesOwner)) {
      throw new DomainError(
        IdentityErrors.PC_ADMIN_SELF_ACTION,
        'You cannot deactivate or demote your own account',
      );
    }
    if (losesOwner && (await this.store.countActiveOwners()) <= 1) {
      throw new DomainError(
        IdentityErrors.PC_ADMIN_LAST_OWNER,
        'The last active owner cannot be demoted or deactivated',
      );
    }
    if (input.password !== undefined) {
      data.passwordHash = await hashPassword(input.password, this.passwordParams);
      // A reset password also unlocks the account and voids a pending TOTP login challenge.
      data.failedLoginCount = 0;
      data.lastFailedLoginAt = null;
      data.lockedUntil = null;
      data.loginChallengeId = null;
      data.loginChallengeAttempts = 0;
    }
    if (Object.keys(data).length === 0) {
      return toAdminUserDto(admin);
    }

    const updated = await this.store.run(async (uow) => {
      const row = await uow.updateAdmin(adminId, data);
      await uow.audit({
        actor: { type: 'admin', id: actor.id },
        action: 'admin_user.update',
        entityType: 'admin_user',
        entityId: adminId,
        before: snapshot(admin),
        after: { ...snapshot(row), passwordChanged: data.passwordHash !== undefined },
        ip: actor.ip ?? null,
      });
      return row;
    });
    if (data.role !== undefined || data.active !== undefined || data.passwordHash !== undefined) {
      // Committed: this replica's AdminGuard sees the change at once, others within the cache TTL.
      this.adminAccess?.invalidate(adminId);
    }
    return toAdminUserDto(updated);
  }

  private emailTaken(): DomainError {
    return new DomainError(
      IdentityErrors.PC_ADMIN_EMAIL_TAKEN,
      'An admin with this e-mail already exists',
    );
  }
}
