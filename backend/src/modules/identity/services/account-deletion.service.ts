import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import {
  IDENTITY_EVENTS,
  OUTBOX_AGGREGATES,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import {
  anonymisedUserPatch,
  computeExecuteAfter,
  isAnonymisedPhone,
  isDeletionDue,
} from '../domain/deletion';
import { IdentityErrors } from '../domain/errors';
import { assertUserCanAuthenticate } from '../domain/user-status';
import type { DeletionRequestDto } from '../dto/common.dto';
import type { DeletionResponseDto } from '../dto/me.dto';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity.config';
import { IdentityStore } from './identity.store';
import { toDeletionRequestDto } from './mappers';

/** Actor id written to the audit log by the daily job. */
export const ACCOUNT_DELETION_ACTOR = 'account-deletion';

export type DeletionExecutionResult = 'executed' | 'skipped';

export interface DeletionRunSummary {
  due: number;
  executed: number;
  skipped: number;
  failed: number;
  failures: { requestId: string; error: string }[];
}

export interface PurgeSummary {
  otpChallenges: number;
  refreshTokens: number;
}

/**
 * Right to erasure (brief sections 4 and 9). `DELETE /me` files a request that executes after the
 * cooling-off period (ACCOUNT_DELETION_GRACE_DAYS, default 30); the member keeps using the app
 * meanwhile and may cancel. The daily `account-deletion` job anonymises the user row (phone
 * placeholder, no name, e-mail, birth date, gender or city), removes the children, wipes device
 * details and push tokens, revokes sessions and consents, and publishes `user.deleted` so modules
 * holding other personal data clean up. The row, its id and member code stay: the points ledger
 * and receipts keep an anonymised owner.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly store: IdentityStore,
    private readonly clock: Clock,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
  ) {}

  async requestDeletion(userId: string, reason?: string | null): Promise<DeletionResponseDto> {
    const user = await this.store.findUserById(userId);
    if (!user) {
      throw new DomainError(IdentityErrors.PC_USER_NOT_FOUND, 'User not found');
    }
    assertUserCanAuthenticate(user.status);
    const now = this.clock.now();
    const trimmed = reason?.trim() ? reason.trim().slice(0, 500) : null;

    const graceDays = this.config.ACCOUNT_DELETION_GRACE_DAYS;
    return this.store.run(async (uow) => {
      const pending = await uow.findPendingDeletionRequest(userId);
      if (pending) {
        return {
          request: toDeletionRequestDto(pending),
          created: false,
          executeAfter: pending.executeAfter.toISOString(),
          graceDays,
        };
      }
      const request = await uow.createDeletionRequest({
        id: uuidv7(),
        userId,
        requestedAt: now,
        executeAfter: computeExecuteAfter(now, graceDays),
        reason: trimmed,
      });
      await uow.publish(
        buildOutboxEvent(IDENTITY_EVENTS.deletionRequested, OUTBOX_AGGREGATES.user, userId, {
          userId,
          requestId: request.id,
          executeAfter: request.executeAfter.toISOString(),
        }),
      );
      return {
        request: toDeletionRequestDto(request),
        created: true,
        executeAfter: request.executeAfter.toISOString(),
        graceDays,
      };
    });
  }

  /** DELETE /me/deletion: the member changed their mind during the cooling-off period. */
  async cancelDeletion(userId: string): Promise<DeletionRequestDto> {
    const now = this.clock.now();
    return this.store.run(async (uow) => {
      const pending = await uow.findPendingDeletionRequest(userId);
      if (!pending) {
        throw new DomainError(
          IdentityErrors.PC_DELETION_NOT_PENDING,
          'No pending deletion request',
        );
      }
      const updated = await uow.updateDeletionRequest(pending.id, { cancelledAt: now });
      await uow.publish(
        buildOutboxEvent(IDENTITY_EVENTS.deletionCancelled, OUTBOX_AGGREGATES.user, userId, {
          userId,
          requestId: pending.id,
          cancelledAt: now.toISOString(),
        }),
      );
      await uow.audit({
        actor: { type: 'user', id: userId },
        action: 'account_deletion_request.cancel',
        entityType: 'account_deletion_request',
        entityId: pending.id,
        before: { cancelledAt: null },
        after: { cancelledAt: now.toISOString() },
      });
      return toDeletionRequestDto(updated);
    });
  }

  /** Daily job: executes every due request, each in its own transaction. */
  async executeDue(limit: number): Promise<DeletionRunSummary> {
    const now = this.clock.now();
    const due = await this.store.listDueDeletionRequests(now, limit);
    const summary: DeletionRunSummary = {
      due: due.length,
      executed: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    };
    for (const request of due) {
      try {
        const result = await this.execute(request.id);
        summary[result] += 1;
      } catch (error) {
        summary.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        summary.failures.push({ requestId: request.id, error: message });
        this.logger.error(`Account deletion ${request.id} failed: ${message}`);
      }
    }
    return summary;
  }

  /** Idempotent: a request that is no longer due (cancelled, executed, not yet due) is skipped. */
  async execute(requestId: string): Promise<DeletionExecutionResult> {
    const now = this.clock.now();
    return this.store.run(async (uow) => {
      const request = await uow.findDeletionRequestById(requestId);
      if (!request || !isDeletionDue(request, now)) {
        return 'skipped';
      }
      const user = await uow.findUserById(request.userId);
      if (user && user.status !== 'deleted') {
        const originalPhone = user.phone;
        await uow.updateUser(user.id, anonymisedUserPatch(user.id, now));
        await uow.deleteChildren(user.id);
        await uow.anonymiseDevices(user.id);
        await uow.revokeRefreshTokens({ userId: user.id }, now);
        for (const consent of await uow.listConsents(user.id)) {
          if (consent.revokedAt === null) {
            await uow.revokeConsent(consent.id, now);
          }
        }
        if (!isAnonymisedPhone(originalPhone)) {
          await uow.deleteOtpChallenges({ phone: originalPhone });
        }
      }
      await uow.updateDeletionRequest(request.id, { executedAt: now });
      await uow.publish(
        buildOutboxEvent(IDENTITY_EVENTS.deleted, OUTBOX_AGGREGATES.user, request.userId, {
          userId: request.userId,
          requestId: request.id,
          deletedAt: now.toISOString(),
        }),
      );
      await uow.audit({
        actor: { type: 'system', id: ACCOUNT_DELETION_ACTOR },
        action: 'user.anonymise',
        entityType: 'user',
        entityId: request.userId,
        before: user ? { status: user.status } : null,
        after: { status: 'deleted', deletedAt: now.toISOString() },
        reason: request.reason,
      });
      return 'executed';
    });
  }

  /**
   * Housekeeping in the same daily job: OTP challenges older than `otpDays` (phone and IP are
   * personal data; rate-limit windows are at most a day) and refresh tokens that expired or were
   * revoked more than `refreshDays` ago (keeping rotated tokens that long preserves reuse detection).
   */
  async purge(retention: { otpDays: number; refreshDays: number }): Promise<PurgeSummary> {
    const nowMs = this.clock.nowMs();
    return this.store.run(async (uow) => ({
      otpChallenges: await uow.deleteOtpChallenges({
        createdBefore: new Date(nowMs - retention.otpDays * 86_400_000),
      }),
      refreshTokens: await uow.deleteRefreshTokens(
        new Date(nowMs - retention.refreshDays * 86_400_000),
      ),
    }));
  }
}
