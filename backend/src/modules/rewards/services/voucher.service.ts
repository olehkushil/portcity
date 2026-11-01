import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Voucher } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { randomCode } from '../../../common/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../../../common/config';
import { CLUB_LEDGER_PORT, type ClubLedgerPort } from '../../../common/contracts/club';
import { CONTENT_PORT, type ContentPort } from '../../../common/contracts/content';
import {
  OUTBOX_AGGREGATES,
  REWARD_EVENTS,
  type VoucherLifecyclePayload,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import type {
  CancelVoucherInput,
  IssueVoucherInput,
  VoucherDailyStats,
  VoucherIssuerPort,
  VoucherKind,
  VoucherSourceType,
  VoucherStatus,
  VoucherSummary,
} from '../../../common/contracts/rewards';
import type { ActorRef, DateRange, Tx } from '../../../common/contracts/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { isUniqueViolation } from '../../../common/prisma/prisma.errors';
import { type DbClient, PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import {
  type CodeGenerator,
  activationTokenHash,
  computeActivationWindow,
  generateActivationCode,
  signActivationToken,
} from '../domain/activation';
import { decideCancel } from '../domain/cancel-policy';
import { type CreatedAtCursor, createdAtCursorOf, isCreatedAtCursor } from '../domain/cursors';
import { RewardsErrors } from '../domain/errors';
import { toUnixSeconds } from '../domain/signed-token';
import {
  type SweepAction,
  VOUCHER_LIVE_STATUSES,
  effectiveVoucherStatus,
  isFinalVoucherStatus,
  isLiveVoucherStatus,
} from '../domain/voucher-state';
import { REWARDS_CONFIG, type RewardsConfig } from '../rewards.config';
import {
  type LiveVoucherFilter,
  RewardsRepository,
  type VoucherStatusCounts,
} from './rewards.repository';
import { loadTenantCards } from './tenant-cards';
import { type VoucherView, toVoucherSummary, toVoucherView, voucherMeta } from './voucher.mapper';

export interface ActivationResult {
  voucher: VoucherView;
  code: string;
  token: string;
  activatedAt: Date;
  activationExpiresAt: Date;
  /** Server clock at the time of the response, for the client-side countdown. */
  serverTime: Date;
}

export interface VoucherListQuery {
  /** Effective statuses; any of them matches (GET /vouchers?status=issued,active). */
  statuses?: readonly VoucherStatus[] | undefined;
  kind?: VoucherKind | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface AdminVoucherListQuery extends VoucherListQuery {
  userId?: string | undefined;
  tenantId?: string | undefined;
  sourceType?: VoucherSourceType | undefined;
}

export interface VoucherSummaryCounts {
  /** Effective status counts. */
  counts: VoucherStatusCounts;
  /** issued + active: the "Мої ваучери (N)" badge. */
  live: number;
  total: number;
}

export interface CancelOptions {
  reason: string;
  actor: ActorRef;
  refundPoints?: boolean | undefined;
}

export type SystemCancelResult = 'cancelled' | 'skipped' | 'missing';

/** Maximum number of live vouchers cancelled by one event (event cancelled, account deleted). */
const BULK_CANCEL_LIMIT = 1000;

export const EXPIRY_REFUND_REASON = 'Ваучер не використано вчасно: бали повернено';

export function voucherLifecyclePayload(voucher: Voucher): VoucherLifecyclePayload {
  return {
    voucherId: voucher.id,
    userId: voucher.userId,
    kind: voucher.kind,
    title: voucher.title,
    tenantId: voucher.tenantId,
    sourceType: voucher.sourceType,
    sourceId: voucher.sourceId,
    expiresAt: voucher.expiresAt ? voucher.expiresAt.toISOString() : null,
  };
}

function stringMeta(voucher: Voucher, field: string): string | null {
  const value = voucherMeta(voucher)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Vouchers: the VOUCHER_ISSUER_PORT implementation for promos/admin, the member wallet
 * (list, summary, activate, cancel) and the transitions used by the minute sweep and event
 * handlers. Validator redemption lives in ValidatorService; redemptions in RedemptionService.
 *
 * Concurrency: activation and cancellation start with `SELECT ... FOR UPDATE` on the voucher
 * and every state-changing write is conditional on the status that was read, so a cancelled
 * voucher can never be revived by a concurrent activation. Lock order everywhere is voucher ->
 * reward -> loyalty account (redeem takes reward -> account), which rules out deadlocks.
 */
@Injectable()
export class VoucherService implements VoucherIssuerPort {
  private readonly logger = new Logger(VoucherService.name);

  /** Replaceable in tests for deterministic codes. */
  codeGenerator: CodeGenerator = randomCode;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: RewardsRepository,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    @Inject(CLUB_LEDGER_PORT) private readonly ledger: ClubLedgerPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REWARDS_CONFIG) private readonly rewardsConfig: RewardsConfig,
    @Inject(CONTENT_PORT) private readonly content: ContentPort,
  ) {}

  private get pepper(): string {
    return this.config.VOUCHER_PEPPER;
  }

  /** Contract summary with the static QR (tickets, certificates) and the display number. */
  summarize(voucher: Voucher, now: Date): VoucherSummary {
    return toVoucherSummary(voucher, now, { pepper: this.pepper });
  }

  /**
   * HTTP views: summaries plus the tenant card (CONTENT_PORT, batch lookup by id; enrichment
   * only, a failing content module yields `tenant: null`) and the public image URL.
   */
  async decorate(summaries: readonly VoucherSummary[]): Promise<VoucherView[]> {
    const byId = await loadTenantCards(
      this.content,
      this.logger,
      summaries.map((summary) => summary.tenantId),
    );
    return summaries.map((summary) =>
      toVoucherView(
        summary,
        summary.tenantId ? (byId.get(summary.tenantId) ?? null) : null,
        this.config.S3_PUBLIC_BASE_URL,
      ),
    );
  }

  async decorateOne(summary: VoucherSummary): Promise<VoucherView> {
    const [view] = await this.decorate([summary]);
    return view as VoucherView;
  }

  // --- VoucherIssuerPort ---------------------------------------------------------------------

  async issue(input: IssueVoucherInput, tx?: Tx): Promise<VoucherSummary> {
    const now = this.clock.now();
    return this.prisma.runInTx(tx, async (db) =>
      this.summarize(await this.issueRow(db, input, now), now),
    );
  }

  /**
   * Idempotent per (sourceType, sourceId, kind); shared with RedemptionService. The pre-check
   * answers ordinary replays; the ON CONFLICT insert closes the race between two concurrent
   * callers (event redelivery, double tap) without aborting the caller's transaction.
   */
  async issueRow(db: Tx, input: IssueVoucherInput, now: Date): Promise<Voucher> {
    const existing = await this.repo.findVoucherBySource(
      db,
      input.sourceType,
      input.sourceId,
      input.kind,
    );
    if (existing) {
      return existing;
    }
    const voucher = await this.repo.createVoucher(db, {
      id: uuidv7(),
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      subtitle: input.subtitle ?? null,
      tenantId: input.tenantId ?? null,
      status: 'issued',
      expiresAt: input.expiresAt ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      meta: input.meta ?? {},
      imageKey: input.imageKey ?? null,
      createdAt: now,
    });
    if (!voucher) {
      // A concurrent issue for the same source won the insert: return its voucher, which
      // published voucher.issued already.
      const winner = await this.repo.findVoucherBySource(
        db,
        input.sourceType,
        input.sourceId,
        input.kind,
      );
      if (!winner) {
        throw new Error(
          `Voucher for ${input.sourceType}:${input.sourceId}/${input.kind} conflicted but cannot be read back`,
        );
      }
      return winner;
    }
    await this.outbox.publish(
      db,
      buildOutboxEvent(
        REWARD_EVENTS.voucherIssued,
        OUTBOX_AGGREGATES.voucher,
        voucher.id,
        voucherLifecyclePayload(voucher),
      ),
    );
    return voucher;
  }

  async cancel(input: CancelVoucherInput, tx?: Tx): Promise<VoucherSummary> {
    return this.prisma.runInTx(tx, async (db) => {
      const voucher = await this.lockExistingVoucher(db, input.voucherId);
      return this.cancelRow(db, voucher, {
        reason: input.reason,
        actor: input.actor,
        refundPoints: input.refundPoints,
      });
    });
  }

  async getVoucher(voucherId: string): Promise<VoucherSummary | null> {
    const voucher = await this.repo.findVoucherById(this.prisma, voucherId);
    return voucher ? this.summarize(voucher, this.clock.now()) : null;
  }

  async listBySource(sourceType: VoucherSourceType, sourceId: string): Promise<VoucherSummary[]> {
    const now = this.clock.now();
    const rows = await this.repo.listVouchersBySource(this.prisma, sourceType, sourceId);
    return rows.map((row) => this.summarize(row, now));
  }

  async getDailyStats(range: DateRange): Promise<VoucherDailyStats> {
    const [issued, redeemed, live] = await Promise.all([
      this.repo.countVouchersIssued(this.prisma, range),
      this.repo.countVouchersRedeemed(this.prisma, range),
      this.repo.countVouchersLive(this.prisma, range.to),
    ]);
    return { issued, redeemed, live };
  }

  // --- member wallet -------------------------------------------------------------------------

  async listForUser(userId: string, query: VoucherListQuery): Promise<Page<VoucherView>> {
    const now = this.clock.now();
    const cursor = decodeCursor<CreatedAtCursor>(query.cursor, isCreatedAtCursor);
    const rows = await this.repo.listVouchers(
      this.prisma,
      { userId, statuses: query.statuses, kind: query.kind, at: now },
      { cursor, limit: query.limit },
    );
    const page = toPage(rows, query.limit, createdAtCursorOf);
    return {
      items: await this.decorate(page.items.map((row) => this.summarize(row, now))),
      nextCursor: page.nextCursor,
    };
  }

  /** `GET /vouchers/summary`: effective status counts for the "Мої ваучери (N)" badge. */
  async summaryForUser(userId: string): Promise<VoucherSummaryCounts> {
    const counts = await this.repo.countUserVouchersByStatus(this.prisma, userId, this.clock.now());
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    return { counts, live: counts.issued + counts.active, total };
  }

  async getForUser(userId: string, voucherId: string): Promise<VoucherView> {
    const voucher = await this.repo.findVoucherById(this.prisma, voucherId);
    if (!voucher || voucher.userId !== userId) {
      throw this.notFound(voucherId);
    }
    return this.decorateOne(this.summarize(voucher, this.clock.now()));
  }

  /**
   * Activation (brief section 7). The voucher row is locked first; a live activation is
   * replayed as is (same code and token); otherwise a fresh 6-character code and a 120-second
   * window are issued with a write conditional on the status that was read. The partial unique
   * index on `code` can still reject a code taken between the pre-check and the write, in
   * which case the whole transaction is retried with a new code.
   */
  async activate(userId: string, voucherId: string): Promise<ActivationResult> {
    const maxAttempts = this.rewardsConfig.REWARDS_CODE_MAX_ATTEMPTS;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await this.prisma.withTx((tx) => this.activateInTx(tx, userId, voucherId));
        return { ...result, voucher: await this.decorateOne(result.voucher) };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        if (attempt >= maxAttempts) {
          throw new DomainError(
            RewardsErrors.PC_VOUCHER_CODE_EXHAUSTED,
            'No free activation code could be allocated; please retry',
            { details: { attempts: attempt }, cause: error },
          );
        }
        this.logger.warn(
          `Activation code collision for voucher ${voucherId}, retrying (${attempt})`,
        );
      }
    }
  }

  private async activateInTx(
    tx: Tx,
    userId: string,
    voucherId: string,
  ): Promise<Omit<ActivationResult, 'voucher'> & { voucher: VoucherSummary }> {
    const voucher = await this.lockOwnedVoucher(tx, userId, voucherId);
    const now = this.clock.now();
    const status = effectiveVoucherStatus(voucher, now);
    switch (status) {
      case 'redeemed':
        throw new DomainError(
          RewardsErrors.PC_VOUCHER_ALREADY_REDEEMED,
          'Voucher was already redeemed',
        );
      case 'cancelled':
        throw new DomainError(RewardsErrors.PC_VOUCHER_FINAL, 'Voucher was cancelled', {
          details: { status },
        });
      case 'expired':
        // The throw rolls the transaction back, so the stored status is left to the minute
        // sweep (vouchers-expire); the effective status already reads as expired everywhere.
        throw new DomainError(RewardsErrors.PC_VOUCHER_EXPIRED, 'Voucher has expired', {
          details: { expiresAt: voucher.expiresAt },
        });
      default:
        break;
    }

    if (status === 'active' && voucher.code && voucher.activationExpiresAt) {
      // Live activation: replay the same code; the token is deterministic given exp.
      const exp = toUnixSeconds(voucher.activationExpiresAt);
      const token = signActivationToken(voucher.id, exp, this.pepper);
      const tokenHash = activationTokenHash(token, this.pepper);
      let row = voucher;
      if (tokenHash !== voucher.tokenHash) {
        const changed = await this.repo.updateVoucherIf(
          tx,
          { id: voucher.id, statuses: ['active'], activationLiveAt: now, notExpiredAt: now },
          { tokenHash },
        );
        if (changed === 0) {
          throw await this.activationConflict(tx, voucher.id, now);
        }
        row = { ...voucher, tokenHash };
      }
      return {
        voucher: this.summarize(row, now),
        code: voucher.code,
        token,
        activatedAt: voucher.activatedAt ?? now,
        activationExpiresAt: voucher.activationExpiresAt,
        serverTime: now,
      };
    }

    const window = computeActivationWindow(now);
    const code = await this.allocateCode(tx);
    const token = signActivationToken(voucher.id, window.exp, this.pepper);
    // Conditional on the status read under the lock: `issued`, or `active` whose window lapsed.
    const changed = await this.repo.updateVoucherIf(
      tx,
      {
        id: voucher.id,
        statuses: [voucher.status],
        notExpiredAt: now,
        ...(voucher.status === 'active' ? { activationLapsedAt: now } : {}),
      },
      {
        status: 'active',
        code,
        tokenHash: activationTokenHash(token, this.pepper),
        activatedAt: window.activatedAt,
        activationExpiresAt: window.activationExpiresAt,
      },
    );
    if (changed === 0) {
      throw await this.activationConflict(tx, voucher.id, now);
    }
    const updated = (await this.repo.findVoucherById(tx, voucher.id)) ?? {
      ...voucher,
      status: 'active' as const,
      code,
      activatedAt: window.activatedAt,
      activationExpiresAt: window.activationExpiresAt,
    };
    await this.outbox.publish(
      tx,
      buildOutboxEvent(REWARD_EVENTS.voucherActivated, OUTBOX_AGGREGATES.voucher, voucher.id, {
        ...voucherLifecyclePayload(updated),
        activationExpiresAt: window.activationExpiresAt.toISOString(),
      }),
    );
    return {
      voucher: this.summarize(updated, now),
      code,
      token,
      activatedAt: window.activatedAt,
      activationExpiresAt: window.activationExpiresAt,
      serverTime: now,
    };
  }

  /** A conditional activation write matched no row: the voucher moved on since it was read. */
  private async activationConflict(tx: Tx, voucherId: string, now: Date): Promise<DomainError> {
    const fresh = await this.repo.findVoucherById(tx, voucherId);
    const status = fresh ? effectiveVoucherStatus(fresh, now) : 'cancelled';
    if (isFinalVoucherStatus(status)) {
      return new DomainError(RewardsErrors.PC_VOUCHER_FINAL, `Voucher is ${status}`, {
        details: { status },
      });
    }
    return new DomainError(
      RewardsErrors.PC_VOUCHER_NOT_ACTIVE,
      'The voucher changed while it was being activated; please retry',
      { details: { status } },
    );
  }

  private async allocateCode(db: DbClient): Promise<string> {
    const maxAttempts = this.rewardsConfig.REWARDS_CODE_MAX_ATTEMPTS;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const code = generateActivationCode(this.codeGenerator);
      const taken = await this.repo.findLiveVoucherByCode(db, code);
      if (!taken) {
        return code;
      }
    }
    throw new DomainError(
      RewardsErrors.PC_VOUCHER_CODE_EXHAUSTED,
      'No free activation code could be allocated; please retry',
      { details: { attempts: maxAttempts } },
    );
  }

  async cancelForMember(userId: string, voucherId: string, reason?: string): Promise<VoucherView> {
    const summary = await this.prisma.withTx(async (tx) => {
      const voucher = await this.lockOwnedVoucher(tx, userId, voucherId);
      return this.cancelRow(tx, voucher, {
        reason: reason?.trim() || 'Cancelled by the member',
        actor: { type: 'user', id: userId },
      });
    });
    return this.decorateOne(summary);
  }

  // --- back office ---------------------------------------------------------------------------

  async listForAdmin(query: AdminVoucherListQuery): Promise<Page<VoucherView>> {
    const now = this.clock.now();
    const cursor = decodeCursor<CreatedAtCursor>(query.cursor, isCreatedAtCursor);
    const rows = await this.repo.listVouchers(
      this.prisma,
      {
        userId: query.userId,
        statuses: query.statuses,
        kind: query.kind,
        tenantId: query.tenantId,
        sourceType: query.sourceType,
        at: now,
      },
      { cursor, limit: query.limit },
    );
    const page = toPage(rows, query.limit, createdAtCursorOf);
    return {
      items: await this.decorate(page.items.map((row) => this.summarize(row, now))),
      nextCursor: page.nextCursor,
    };
  }

  async getById(voucherId: string): Promise<VoucherView> {
    const voucher = await this.repo.findVoucherById(this.prisma, voucherId);
    if (!voucher) {
      throw this.notFound(voucherId);
    }
    return this.decorateOne(this.summarize(voucher, this.clock.now()));
  }

  // --- sweep (vouchers-expire job) -------------------------------------------------------------

  findSweepCandidates(now: Date, limit: number): Promise<Voucher[]> {
    return this.repo.findSweepCandidates(this.prisma, now, limit);
  }

  /** Applies one planned sweep action in its own transaction; false when the row moved on. */
  applySweepAction(
    voucher: Voucher,
    action: Exclude<SweepAction, 'none'>,
    now: Date,
  ): Promise<boolean> {
    return this.prisma.withTx((tx) =>
      action === 'expire'
        ? this.expireVoucher(tx, voucher, now)
        : this.deactivateVoucher(tx, voucher, now),
    );
  }

  /**
   * issued|active -> expired once `expiresAt` is reached; publishes voucher.expired. A voucher
   * bought with points (sourceType = redemption) that expires unused refunds them through the
   * ledger when REWARDS_REFUND_ON_EXPIRY is on (product decision: the app promises it), in the
   * same transaction; the ledger keeps one compensation per spend, so a retry never pays twice.
   */
  async expireVoucher(db: Tx, voucher: Voucher, now: Date): Promise<boolean> {
    const changed = await this.repo.updateVoucherIf(
      db,
      { id: voucher.id, statuses: VOUCHER_LIVE_STATUSES, expiredAt: now },
      { status: 'expired', code: null, tokenHash: null, activationExpiresAt: null },
    );
    if (changed === 0) {
      return false;
    }
    if (this.rewardsConfig.REWARDS_REFUND_ON_EXPIRY && voucher.sourceType === 'redemption') {
      await this.refundExpiredRedemption(db, voucher);
    }
    await this.outbox.publish(
      db,
      buildOutboxEvent(
        REWARD_EVENTS.voucherExpired,
        OUTBOX_AGGREGATES.voucher,
        voucher.id,
        voucherLifecyclePayload(voucher),
      ),
    );
    return true;
  }

  private async refundExpiredRedemption(db: Tx, voucher: Voucher): Promise<void> {
    const redemption = await this.repo.findRedemptionByVoucherId(db, voucher.id);
    if (!redemption || redemption.status !== 'issued' || !redemption.pointsTxId) {
      return;
    }
    // Lock order voucher (updated above) -> reward -> account (inside the ledger).
    await this.repo.lockReward(db, redemption.rewardId);
    await this.ledger.reverse(
      {
        txId: redemption.pointsTxId,
        idempotencyKey: `voucher-expire:${voucher.id}`,
        reason: EXPIRY_REFUND_REASON,
        title: 'Повернення балів',
        subtitle: `Ваучер «${voucher.title}» не використано`,
        counterparty: {
          rewardId: stringMeta(voucher, 'rewardId') ?? redemption.rewardId,
          rewardTitle: voucher.title,
          voucherId: voucher.id,
          tenantId: voucher.tenantId,
        },
      },
      db,
    );
    await this.repo.updateRedemption(db, redemption.id, { status: 'refunded' });
    await this.repo.returnRewardStock(db, redemption.rewardId);
  }

  /** active -> issued when the activation window lapsed; frees the code, no event. */
  async deactivateVoucher(db: Tx, voucher: Voucher, now: Date): Promise<boolean> {
    const changed = await this.repo.updateVoucherIf(
      db,
      { id: voucher.id, statuses: ['active'], activationLapsedAt: now, notExpiredAt: now },
      {
        status: 'issued',
        code: null,
        tokenHash: null,
        activatedAt: null,
        activationExpiresAt: null,
      },
    );
    return changed === 1;
  }

  // --- event handlers (rewards-events queue) -------------------------------------------------

  /** Cancels one voucher on behalf of the system; idempotent (final vouchers are skipped). */
  async cancelBySystem(
    voucherId: string,
    reason: string,
    refundPoints: boolean,
  ): Promise<SystemCancelResult> {
    return this.prisma.withTx(async (tx) => {
      const voucher = await this.repo.lockVoucher(tx, voucherId);
      if (!voucher) {
        return 'missing';
      }
      if (!isLiveVoucherStatus(effectiveVoucherStatus(voucher, this.clock.now()))) {
        return 'skipped';
      }
      await this.cancelRow(tx, voucher, {
        reason,
        actor: { type: 'system', id: 'rewards-events' },
        refundPoints,
      });
      return 'cancelled';
    });
  }

  /** Cancels every live voucher matching the filter, one transaction each; returns the count. */
  async cancelLiveVouchers(
    filter: LiveVoucherFilter,
    reason: string,
    refundPoints: boolean,
  ): Promise<number> {
    const candidates = await this.repo.listLiveVouchers(this.prisma, filter, BULK_CANCEL_LIMIT);
    let cancelled = 0;
    for (const candidate of candidates) {
      if ((await this.cancelBySystem(candidate.id, reason, refundPoints)) === 'cancelled') {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  // --- internals -----------------------------------------------------------------------------

  private notFound(voucherId: string): DomainError {
    return new DomainError(RewardsErrors.PC_VOUCHER_NOT_FOUND, `Voucher ${voucherId} not found`);
  }

  /** Locks the voucher row (`FOR UPDATE`) and reads it under the lock. */
  private async lockExistingVoucher(db: Tx, voucherId: string): Promise<Voucher> {
    const voucher = await this.repo.lockVoucher(db, voucherId);
    if (!voucher) {
      throw this.notFound(voucherId);
    }
    return voucher;
  }

  /** Members only ever see their own vouchers; a foreign id reads as not found. */
  private async lockOwnedVoucher(db: Tx, userId: string, voucherId: string): Promise<Voucher> {
    const voucher = await this.repo.lockVoucher(db, voucherId);
    if (!voucher || voucher.userId !== userId) {
      throw this.notFound(voucherId);
    }
    return voucher;
  }

  /**
   * issued|active -> cancelled with the points policy (domain/cancel-policy.ts): a redemption
   * voucher refunds its spend through the ledger (`reverse`) unless `refundPoints` is false,
   * the redemption becomes `refunded` or `cancelled` and limited stock is returned. The caller
   * holds the voucher lock; the reward row is locked before the ledger locks the account
   * (same order as the sweep, compatible with redeem's reward -> account).
   */
  private async cancelRow(
    db: Tx,
    voucher: Voucher,
    options: CancelOptions,
  ): Promise<VoucherSummary> {
    const now = this.clock.now();
    const status = effectiveVoucherStatus(voucher, now);
    const decision = decideCancel({
      status,
      sourceType: voucher.sourceType,
      refundPoints: options.refundPoints,
    });
    if (!decision.allowed) {
      throw this.notCancellable(status);
    }
    const changed = await this.repo.updateVoucherIf(
      db,
      { id: voucher.id, statuses: VOUCHER_LIVE_STATUSES, notExpiredAt: now },
      { status: 'cancelled', code: null, tokenHash: null, activationExpiresAt: null },
    );
    if (changed === 0) {
      const fresh = await this.repo.findVoucherById(db, voucher.id);
      throw this.notCancellable(fresh ? effectiveVoucherStatus(fresh, now) : status);
    }

    let pointsRefunded: number | null = null;
    const redemption = await this.repo.findRedemptionByVoucherId(db, voucher.id);
    if (redemption) {
      await this.repo.lockReward(db, redemption.rewardId);
      if (decision.refundPoints && redemption.pointsTxId) {
        const entry = await this.ledger.reverse(
          {
            txId: redemption.pointsTxId,
            idempotencyKey: `voucher-cancel:${voucher.id}`,
            reason: options.reason,
            title: 'Повернення балів',
            subtitle: `Скасовано ваучер «${voucher.title}»`,
            counterparty: {
              rewardId: stringMeta(voucher, 'rewardId') ?? redemption.rewardId,
              rewardTitle: voucher.title,
              voucherId: voucher.id,
              tenantId: voucher.tenantId,
            },
            ...(options.actor.type === 'admin' && options.actor.id
              ? { createdById: options.actor.id }
              : {}),
          },
          db,
        );
        pointsRefunded = Math.abs(entry.amount);
        await this.repo.updateRedemption(db, redemption.id, { status: 'refunded' });
      } else {
        await this.repo.updateRedemption(db, redemption.id, { status: 'cancelled' });
      }
      await this.repo.returnRewardStock(db, redemption.rewardId);
    }

    const updated = (await this.repo.findVoucherById(db, voucher.id)) ?? {
      ...voucher,
      status: 'cancelled' as const,
      code: null,
      tokenHash: null,
      activationExpiresAt: null,
    };
    await this.outbox.publish(
      db,
      buildOutboxEvent(REWARD_EVENTS.voucherCancelled, OUTBOX_AGGREGATES.voucher, voucher.id, {
        ...voucherLifecyclePayload(updated),
        reason: options.reason,
        pointsRefunded,
      }),
    );
    return this.summarize(updated, now);
  }

  private notCancellable(status: VoucherStatus): DomainError {
    if (status === 'redeemed') {
      return new DomainError(
        RewardsErrors.PC_VOUCHER_ALREADY_REDEEMED,
        'Voucher was already redeemed',
      );
    }
    return new DomainError(
      RewardsErrors.PC_VOUCHER_FINAL,
      `Voucher is ${status} and cannot be cancelled`,
      {
        details: { status },
      },
    );
  }
}
