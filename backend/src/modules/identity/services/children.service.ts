import { Injectable } from '@nestjs/common';
import type { Child, User } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import type { Gender } from '../../../common/contracts/identity';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { MAX_CHILDREN, assertChildBirth, assertChildLimit } from '../domain/children';
import { IdentityErrors } from '../domain/errors';
import { assertUserCanAuthenticate } from '../domain/user-status';
import type { ChildDto, ChildrenResponseDto } from '../dto/me.dto';
import { type ChildUpdateData, IdentityStore } from './identity.store';
import { toChildDto } from './mappers';
import { announceCompletedProfileFields } from './profile-fields';

export interface ChildCreateInput {
  birthMonth: number;
  birthYear: number;
  gender?: Gender;
}

export interface ChildUpdateInput {
  birthMonth?: number;
  birthYear?: number;
  gender?: Gender;
}

/**
 * `GET/POST/PATCH/DELETE /me/children`: up to MAX_CHILDREN (6) children per member, birth month
 * and year only (no names, no exact dates). The first child fills the `children` profile field
 * (one `user.profile_field_completed`). Creation runs under the user row lock, so parallel POSTs
 * cannot exceed the limit.
 */
@Injectable()
export class ChildrenService {
  constructor(
    private readonly store: IdentityStore,
    private readonly clock: Clock,
  ) {}

  async list(userId: string): Promise<ChildrenResponseDto> {
    await this.requireActiveUser(userId);
    const children = await this.store.listChildren(userId);
    return { items: children.map(toChildDto), max: MAX_CHILDREN };
  }

  async create(userId: string, input: ChildCreateInput): Promise<ChildDto> {
    const user = await this.requireActiveUser(userId);
    const now = this.clock.now();
    assertChildBirth(input, now);
    const child = await this.store.run(async (uow) => {
      const locked = (await uow.lockUser(userId)) ?? user;
      assertChildLimit((await uow.listChildren(userId)).length);
      const created = await uow.createChild({
        id: uuidv7(),
        userId,
        birthMonth: input.birthMonth,
        birthYear: input.birthYear,
        gender: input.gender ?? 'unspecified',
        createdAt: now,
      });
      await announceCompletedProfileFields(uow, locked, now);
      return created;
    });
    return toChildDto(child);
  }

  async update(userId: string, childId: string, input: ChildUpdateInput): Promise<ChildDto> {
    await this.requireActiveUser(userId);
    const child = await this.requireOwnChild(userId, childId);
    const data: ChildUpdateData = {};
    if (input.birthMonth !== undefined) {
      data.birthMonth = input.birthMonth;
    }
    if (input.birthYear !== undefined) {
      data.birthYear = input.birthYear;
    }
    if (input.gender !== undefined) {
      data.gender = input.gender;
    }
    if (Object.keys(data).length === 0) {
      return toChildDto(child);
    }
    assertChildBirth(
      {
        birthMonth: data.birthMonth ?? child.birthMonth,
        birthYear: data.birthYear ?? child.birthYear,
      },
      this.clock.now(),
    );
    const updated = await this.store.run((uow) => uow.updateChild(child.id, data));
    return toChildDto(updated);
  }

  /** Removes a child. The `children` field stays announced (no second bonus after re-adding). */
  async remove(userId: string, childId: string): Promise<void> {
    await this.requireActiveUser(userId);
    const child = await this.requireOwnChild(userId, childId);
    await this.store.run((uow) => uow.deleteChild(child.id));
  }

  private async requireActiveUser(userId: string): Promise<User> {
    const user = await this.store.findUserById(userId);
    if (!user) {
      throw new DomainError(IdentityErrors.PC_USER_NOT_FOUND, 'User not found');
    }
    assertUserCanAuthenticate(user.status);
    return user;
  }

  /** Another member's child answers 404 like a missing one (ids are not probeable). */
  private async requireOwnChild(userId: string, childId: string): Promise<Child> {
    const child = await this.store.findChildById(childId);
    if (!child || child.userId !== userId) {
      throw new DomainError(IdentityErrors.PC_USER_CHILD_NOT_FOUND, 'Child not found');
    }
    return child;
  }
}
