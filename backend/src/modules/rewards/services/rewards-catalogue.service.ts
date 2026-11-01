import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Reward } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { APP_CONFIG, type AppConfig } from '../../../common/config';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import { CLUB_LEDGER_PORT, type ClubLedgerPort } from '../../../common/contracts/club';
import {
  CONTENT_PORT,
  type ContentPort,
  type TenantSummary,
} from '../../../common/contracts/content';
import type { RewardKind } from '../../../common/contracts/rewards';
import type { ActorRef } from '../../../common/contracts/shared';
import { CommonErrors } from '../../../common/errors/error-codes';
import { DomainError } from '../../../common/errors/domain-error';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { type SortOrderCursor, isSortOrderCursor, sortOrderCursorOf } from '../domain/cursors';
import { RewardsErrors } from '../domain/errors';
import { isRewardListed } from '../domain/reward-rules';
import type { RewardDto } from '../dto/reward.dto';
import { toRewardDto } from './reward.mapper';
import { type NewReward, type RewardPatch, RewardsRepository } from './rewards.repository';
import { tryPort } from './safe-port';
import { loadTenantCards } from './tenant-cards';

export interface MemberRewardListQuery {
  affordable?: boolean | undefined;
  kind?: RewardKind | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface AdminRewardListQuery {
  active?: boolean | undefined;
  kind?: RewardKind | undefined;
  tenantId?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface RewardInput {
  title: string;
  description?: string | null | undefined;
  costPoints: number;
  kind: RewardKind;
  tenantId?: string | null | undefined;
  stock?: number | null | undefined;
  perUserLimit?: number | null | undefined;
  active?: boolean | undefined;
  validFrom?: Date | null | undefined;
  validTo?: Date | null | undefined;
  imageKey?: string | null | undefined;
  terms?: string | null | undefined;
  sortOrder?: number | undefined;
}

export interface AdminContext {
  actor: ActorRef;
  ip?: string | null | undefined;
  reason?: string | null | undefined;
}

function assertPeriod(validFrom: Date | null, validTo: Date | null): void {
  if (validFrom && validTo && validFrom.getTime() >= validTo.getTime()) {
    throw new DomainError(
      CommonErrors.PC_COMMON_VALIDATION,
      'validFrom must be earlier than validTo',
      {
        details: [{ path: 'validTo', messages: ['validTo must be later than validFrom'] }],
      },
    );
  }
}

/** Reward catalogue: member listing with affordability and per-user limits, back-office CRUD. */
@Injectable()
export class RewardsCatalogueService {
  private readonly logger = new Logger(RewardsCatalogueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: RewardsRepository,
    private readonly clock: Clock,
    @Inject(CLUB_LEDGER_PORT) private readonly ledger: ClubLedgerPort,
    @Inject(CONTENT_PORT) private readonly content: ContentPort,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get publicBaseUrl(): string | undefined {
    return this.config.S3_PUBLIC_BASE_URL;
  }

  // --- members and guests --------------------------------------------------------------------

  /**
   * Listed rewards (active, inside their period) with `affordable`, `available` and
   * `remainingForUser`. `affordable=true` filters by cost against the member's balance; when
   * the balance is unknown the filter cannot be applied and `affordable` is null per item.
   * Guests (no `userId`, product decision: the catalogue is guest-readable) get the same list
   * with the per-user fields (`affordable`, `remainingForUser`) set to null.
   */
  async listForMember(
    userId: string | undefined,
    query: MemberRewardListQuery,
  ): Promise<Page<RewardDto>> {
    const now = this.clock.now();
    const balance = userId ? await this.memberBalance(userId) : null;
    const cursor = decodeCursor<SortOrderCursor>(query.cursor, isSortOrderCursor);
    const rows = await this.repo.listRewards(
      this.prisma,
      {
        listedAt: now,
        kind: query.kind,
        maxCostPoints: query.affordable === true && balance !== null ? balance : undefined,
      },
      { cursor, limit: query.limit },
    );
    const page = toPage(rows, query.limit, sortOrderCursorOf);
    const items = await this.decorateForMember(page.items, userId, balance, now);
    return { items, nextCursor: page.nextCursor };
  }

  async getForMember(userId: string | undefined, rewardId: string): Promise<RewardDto> {
    const now = this.clock.now();
    const reward = await this.repo.findRewardById(this.prisma, rewardId);
    if (!reward || !isRewardListed(reward, now)) {
      throw new DomainError(RewardsErrors.PC_REWARD_NOT_FOUND, `Reward ${rewardId} not found`);
    }
    const balance = userId ? await this.memberBalance(userId) : null;
    const [dto] = await this.decorateForMember([reward], userId, balance, now);
    return dto as RewardDto;
  }

  private async decorateForMember(
    rewards: Reward[],
    userId: string | undefined,
    availableBalance: number | null,
    now: Date,
  ): Promise<RewardDto[]> {
    const [tenants, counts] = await Promise.all([
      this.tenantsOf(rewards),
      userId
        ? this.repo.countUserRedemptionsForRewards(
            this.prisma,
            userId,
            rewards.filter((reward) => reward.perUserLimit !== null).map((reward) => reward.id),
          )
        : Promise.resolve(new Map<string, number>()),
    ]);
    return rewards.map((reward) =>
      toRewardDto(reward, {
        now,
        tenant: reward.tenantId ? (tenants.get(reward.tenantId) ?? null) : null,
        publicBaseUrl: this.publicBaseUrl,
        member: userId
          ? { userRedemptions: counts.get(reward.id) ?? 0, availableBalance }
          : undefined,
      }),
    );
  }

  private async memberBalance(userId: string): Promise<number | null> {
    const balance = await tryPort(
      this.logger,
      'club.getBalance',
      () => this.ledger.getBalance(userId),
      null,
    );
    return balance ? balance.available : null;
  }

  /** Tenant cards by id (display summaries with content's logo URL when available). */
  private tenantsOf(rewards: Reward[]): Promise<Map<string, TenantSummary>> {
    return loadTenantCards(
      this.content,
      this.logger,
      rewards.map((reward) => reward.tenantId),
    );
  }

  // --- back office ---------------------------------------------------------------------------

  async listForAdmin(query: AdminRewardListQuery): Promise<Page<RewardDto>> {
    const now = this.clock.now();
    const cursor = decodeCursor<SortOrderCursor>(query.cursor, isSortOrderCursor);
    const rows = await this.repo.listRewards(
      this.prisma,
      { active: query.active, kind: query.kind, tenantId: query.tenantId },
      { cursor, limit: query.limit },
    );
    const page = toPage(rows, query.limit, sortOrderCursorOf);
    const tenants = await this.tenantsOf(page.items);
    return {
      items: page.items.map((reward) =>
        toRewardDto(reward, {
          now,
          tenant: reward.tenantId ? (tenants.get(reward.tenantId) ?? null) : null,
          publicBaseUrl: this.publicBaseUrl,
        }),
      ),
      nextCursor: page.nextCursor,
    };
  }

  async getForAdmin(rewardId: string): Promise<RewardDto> {
    const reward = await this.requireReward(rewardId);
    return this.getForAdminRow(reward);
  }

  async create(input: RewardInput, context: AdminContext): Promise<RewardDto> {
    const now = this.clock.now();
    const data: NewReward = {
      id: uuidv7(),
      title: input.title.trim(),
      description: input.description ?? null,
      costPoints: input.costPoints,
      kind: input.kind,
      tenantId: input.tenantId ?? null,
      stock: input.stock ?? null,
      perUserLimit: input.perUserLimit ?? null,
      active: input.active ?? true,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      imageKey: input.imageKey ?? null,
      terms: input.terms ?? null,
      sortOrder: input.sortOrder ?? 0,
      createdAt: now,
    };
    assertPeriod(data.validFrom, data.validTo);
    await this.assertTenantExists(data.tenantId);
    const reward = await this.prisma.withTx(async (tx) => {
      const created = await this.repo.createReward(tx, data);
      await this.audit.audit(
        {
          actor: context.actor,
          action: 'reward.create',
          entityType: 'reward',
          entityId: created.id,
          after: created,
          reason: context.reason ?? null,
          ip: context.ip ?? null,
        },
        tx,
      );
      return created;
    });
    return this.getForAdminRow(reward);
  }

  async update(
    rewardId: string,
    patch: Partial<RewardInput>,
    context: AdminContext,
  ): Promise<RewardDto> {
    const before = await this.requireReward(rewardId);
    const data: RewardPatch = {};
    if (patch.title !== undefined) data.title = patch.title.trim();
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.costPoints !== undefined) data.costPoints = patch.costPoints;
    if (patch.kind !== undefined) data.kind = patch.kind;
    if (patch.tenantId !== undefined) data.tenantId = patch.tenantId;
    if (patch.stock !== undefined) data.stock = patch.stock;
    if (patch.perUserLimit !== undefined) data.perUserLimit = patch.perUserLimit;
    if (patch.active !== undefined) data.active = patch.active;
    if (patch.validFrom !== undefined) data.validFrom = patch.validFrom;
    if (patch.validTo !== undefined) data.validTo = patch.validTo;
    if (patch.imageKey !== undefined) data.imageKey = patch.imageKey;
    if (patch.terms !== undefined) data.terms = patch.terms;
    if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
    assertPeriod(data.validFrom ?? before.validFrom, data.validTo ?? before.validTo);
    if (data.tenantId !== undefined) {
      await this.assertTenantExists(data.tenantId);
    }
    const reward = await this.prisma.withTx(async (tx) => {
      const updated = await this.repo.updateReward(tx, rewardId, data);
      await this.audit.audit(
        {
          actor: context.actor,
          action: 'reward.update',
          entityType: 'reward',
          entityId: rewardId,
          before,
          after: updated,
          reason: context.reason ?? null,
          ip: context.ip ?? null,
        },
        tx,
      );
      return updated;
    });
    return this.getForAdminRow(reward);
  }

  /** Rewards are never deleted (redemptions reference them); DELETE deactivates. */
  async deactivate(rewardId: string, context: AdminContext): Promise<RewardDto> {
    const before = await this.requireReward(rewardId);
    const reward = await this.prisma.withTx(async (tx) => {
      const updated = before.active
        ? await this.repo.updateReward(tx, rewardId, { active: false })
        : before;
      await this.audit.audit(
        {
          actor: context.actor,
          action: 'reward.deactivate',
          entityType: 'reward',
          entityId: rewardId,
          before: { active: before.active },
          after: { active: false },
          reason: context.reason ?? null,
          ip: context.ip ?? null,
        },
        tx,
      );
      return updated;
    });
    return this.getForAdminRow(reward);
  }

  private async getForAdminRow(reward: Reward): Promise<RewardDto> {
    const tenants = await this.tenantsOf([reward]);
    return toRewardDto(reward, {
      now: this.clock.now(),
      tenant: reward.tenantId ? (tenants.get(reward.tenantId) ?? null) : null,
      publicBaseUrl: this.publicBaseUrl,
    });
  }

  private async requireReward(rewardId: string): Promise<Reward> {
    const reward = await this.repo.findRewardById(this.prisma, rewardId);
    if (!reward) {
      throw new DomainError(RewardsErrors.PC_REWARD_NOT_FOUND, `Reward ${rewardId} not found`);
    }
    return reward;
  }

  /** Rejects unknown tenants when the content module can answer; skips the check otherwise. */
  private async assertTenantExists(tenantId: string | null): Promise<void> {
    if (tenantId === null) {
      return;
    }
    // 'unknown' means the content port could not answer: the check is skipped, not failed.
    const tenant = await tryPort<TenantSummary | null | 'unknown'>(
      this.logger,
      'content.getTenant',
      () => this.content.getTenant(tenantId),
      'unknown',
    );
    if (tenant === null) {
      throw new DomainError(
        CommonErrors.PC_COMMON_VALIDATION,
        `Tenant ${tenantId} does not exist`,
        {
          details: [{ path: 'tenantId', messages: ['tenant does not exist'] }],
        },
      );
    }
  }
}
