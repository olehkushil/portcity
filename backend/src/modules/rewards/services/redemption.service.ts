import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redemption, Reward } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { CLUB_LEDGER_PORT, type ClubLedgerPort } from '../../../common/contracts/club';
import {
  CONTENT_PORT,
  type ContentPort,
  type TenantSummary,
} from '../../../common/contracts/content';
import {
  OUTBOX_AGGREGATES,
  REWARD_EVENTS,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import {
  PARKING_PORT,
  type ParkingPort,
  type ParkingSessionSummary,
} from '../../../common/contracts/parking';
import type { Tx } from '../../../common/contracts/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { RewardsErrors } from '../domain/errors';
import {
  REWARD_UNAVAILABLE_ERRORS,
  checkRewardAvailability,
  computeRewardVoucherExpiry,
  voucherKindForReward,
} from '../domain/reward-rules';
import type { RedeemRewardResponseDto } from '../dto/reward.dto';
import { REWARDS_CONFIG, type RewardsConfig } from '../rewards.config';
import { RewardsRepository } from './rewards.repository';
import { tryPort } from './safe-port';
import type { VoucherView } from './voucher.mapper';
import { VoucherService } from './voucher.service';

export interface RedeemResult {
  redemption: Redemption;
  voucher: VoucherView;
  pointsSpent: number;
  pointsTxId: string;
  /** Null when the ledger could not report the balance. */
  availableBalance: number | null;
}

/** HTTP projection of a redemption (POST /rewards/:id/redeem). */
export function toRedeemRewardResponse(result: RedeemResult): RedeemRewardResponseDto {
  return {
    redemption: {
      id: result.redemption.id,
      rewardId: result.redemption.rewardId,
      status: result.redemption.status,
      createdAt: result.redemption.createdAt,
    },
    voucher: result.voucher,
    pointsSpent: result.pointsSpent,
    pointsTxId: result.pointsTxId,
    availableBalance: result.availableBalance,
  };
}

/** "Aroma Kava, 1 поверх": the subtitle shown in the wallet and on the validator screen. */
export function tenantSubtitle(tenant: TenantSummary | null): string | null {
  if (!tenant) {
    return null;
  }
  return tenant.floor === null ? tenant.name : `${tenant.name}, ${tenant.floor} поверх`;
}

export function rewardVoucherMeta(
  reward: Pick<Reward, 'id' | 'kind' | 'costPoints'>,
  parkingSession: ParkingSessionSummary | null,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    rewardId: reward.id,
    rewardKind: reward.kind,
    costPoints: reward.costPoints,
  };
  if (reward.kind === 'parking_hour') {
    meta['parkingHours'] = 1;
    if (parkingSession) {
      meta['parkingSessionId'] = parkingSession.id;
      meta['parkingPlate'] = parkingSession.plate;
      meta['parkingZone'] = parkingSession.zone;
    }
  }
  return meta;
}

/**
 * Exchange of points for a reward (POST /rewards/:id/redeem, brief sections 6-8):
 * one transaction locks the reward row, checks availability, takes stock, writes the
 * redemption, spends points through the club ledger, issues the voucher and publishes
 * `redemption.created` (plus `voucher.issued` from the voucher service).
 */
@Injectable()
export class RedemptionService {
  private readonly logger = new Logger(RedemptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: RewardsRepository,
    private readonly vouchers: VoucherService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    @Inject(CLUB_LEDGER_PORT) private readonly ledger: ClubLedgerPort,
    @Inject(CONTENT_PORT) private readonly content: ContentPort,
    @Inject(PARKING_PORT) private readonly parking: ParkingPort,
    @Inject(REWARDS_CONFIG) private readonly config: RewardsConfig,
  ) {}

  async redeem(userId: string, rewardId: string): Promise<RedeemResult> {
    const preview = await this.repo.findRewardById(this.prisma, rewardId);
    if (!preview) {
      throw new DomainError(RewardsErrors.PC_REWARD_NOT_FOUND, `Reward ${rewardId} not found`);
    }
    // Enrichment-only lookups stay outside the transaction and never block a redemption.
    const [tenant, parkingSession] = await Promise.all([
      preview.tenantId
        ? tryPort(
            this.logger,
            'content.getTenant',
            () => this.content.getTenant(preview.tenantId as string),
            null,
          )
        : Promise.resolve<TenantSummary | null>(null),
      preview.kind === 'parking_hour'
        ? tryPort(
            this.logger,
            'parking.getSessionForUser',
            () => this.parking.getSessionForUser(userId),
            null,
          )
        : Promise.resolve<ParkingSessionSummary | null>(null),
    ]);

    const result = await this.prisma.withTx(async (tx) => {
      // Lock order reward -> account (the ledger locks the account in spend()).
      await this.repo.lockReward(tx, rewardId);
      const reward = await this.repo.findRewardById(tx, rewardId);
      if (!reward) {
        throw new DomainError(RewardsErrors.PC_REWARD_NOT_FOUND, `Reward ${rewardId} not found`);
      }
      const now = this.clock.now();
      const userRedemptions = await this.repo.countUserRedemptions(tx, userId, rewardId);
      const availability = checkRewardAvailability(reward, now, userRedemptions);
      if (!availability.ok) {
        throw new DomainError(
          RewardsErrors[REWARD_UNAVAILABLE_ERRORS[availability.reason]],
          `Reward "${reward.title}" cannot be redeemed: ${availability.reason}`,
          { details: { reason: availability.reason } },
        );
      }
      if (!(await this.repo.takeRewardStock(tx, rewardId))) {
        throw new DomainError(
          RewardsErrors.PC_REWARD_OUT_OF_STOCK,
          `Reward "${reward.title}" is out of stock`,
          {
            details: { reason: 'out_of_stock' },
          },
        );
      }

      const redemptionId = uuidv7();
      await this.repo.createRedemption(tx, {
        id: redemptionId,
        userId,
        rewardId,
        status: 'created',
        pointsTxId: null,
        voucherId: null,
        createdAt: now,
      });

      const entry = await this.ledger.spend(
        {
          userId,
          amount: reward.costPoints,
          sourceType: 'redemption',
          sourceId: redemptionId,
          idempotencyKey: `redemption:${redemptionId}`,
          reason: `Reward: ${reward.title}`,
          title: 'Обмін на винагороду',
          subtitle: reward.title,
          counterparty: {
            rewardId: reward.id,
            rewardTitle: reward.title,
            tenantId: reward.tenantId,
            tenantName: tenant?.name ?? null,
          },
        },
        tx,
      );

      const voucher = await this.vouchers.issueRow(
        tx,
        {
          userId,
          kind: voucherKindForReward(reward.kind),
          title: reward.title,
          ...(tenantSubtitle(tenant) !== null
            ? { subtitle: tenantSubtitle(tenant) as string }
            : {}),
          ...(reward.tenantId ? { tenantId: reward.tenantId } : {}),
          expiresAt: computeRewardVoucherExpiry(reward, now, this.config.REWARDS_VOUCHER_TTL_DAYS),
          sourceType: 'redemption',
          sourceId: redemptionId,
          meta: rewardVoucherMeta(reward, parkingSession),
          imageKey: reward.imageKey,
        },
        now,
      );

      const redemption = await this.repo.updateRedemption(tx, redemptionId, {
        status: 'issued',
        pointsTxId: entry.id,
        voucherId: voucher.id,
      });
      await this.outbox.publish(
        tx,
        buildOutboxEvent(
          REWARD_EVENTS.redemptionCreated,
          OUTBOX_AGGREGATES.redemption,
          redemptionId,
          {
            redemptionId,
            userId,
            rewardId,
            voucherId: voucher.id,
            pointsTxId: entry.id,
            costPoints: reward.costPoints,
          },
        ),
      );

      const availableBalance = await this.safeBalance(userId, tx);
      return {
        redemption,
        voucher: this.vouchers.summarize(voucher, now),
        pointsSpent: reward.costPoints,
        pointsTxId: entry.id,
        availableBalance,
      };
    });
    return { ...result, voucher: await this.vouchers.decorateOne(result.voucher) };
  }

  private async safeBalance(userId: string, tx: Tx): Promise<number | null> {
    const balance = await tryPort(
      this.logger,
      'club.getBalance',
      () => this.ledger.getBalance(userId, tx),
      null,
    );
    return balance ? balance.available : null;
  }
}
