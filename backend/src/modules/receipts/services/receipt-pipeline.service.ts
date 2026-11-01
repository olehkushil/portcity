import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Receipt } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import {
  CLUB_LEDGER_PORT,
  type ClubLedgerPort,
  type CreditPointsInput,
  type LedgerEntry,
  type LoyaltyRules,
} from '../../../common/contracts/club';
import {
  CONTENT_PORT,
  type ContentPort,
  type EffectiveTenantRule,
  type FiscalNumberLookup,
  type TenantSummary,
} from '../../../common/contracts/content';
import {
  OUTBOX_AGGREGATES,
  RECEIPT_EVENTS,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import { IDENTITY_PORT, type IdentityPort } from '../../../common/contracts/identity';
import type { ReceiptStatus } from '../../../common/contracts/receipts';
import { DomainError } from '../../../common/errors/domain-error';
import { formatUah } from '../../../common/money/money';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { PrismaService, type Tx } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { addKyivDays, startOfKyivDay } from '../../../common/time/kyiv';
import { ReceiptErrors } from '../domain/errors';
import { numericFiscalId } from '../domain/fiscal-ids';
import { parseTaxQr } from '../domain/qr-parser';
import {
  type CreditPlan,
  DEVICE_SHARED_WINDOW_MS,
  FISCAL_ID_ORDER_NEIGHBOURS,
  type ModerationReason,
  NO_PATTERNS,
  ROUND_TOTAL_WINDOW_MS,
  type ReceiptDecision,
  type ReceiptPatterns,
  type RuleTenant,
  type RuleTenantRule,
  SAME_FN_BURST_WINDOW_MS,
  SAME_TOTAL_WINDOW_MS,
  type TaxCheckStatus,
  assessRisk,
  buildCreditPlan,
  describeDecision,
  evaluateReceipt,
  exceedsDailyQrCap,
  isFiscalIdOutOfOrder,
  isRoundTotal,
  isRoundTotalRepeat,
  verificationHoldUntil,
} from '../domain/rules';
import { assertTransition, isCreditable } from '../domain/state-machine';
import { parseModerationReasons } from '../domain/submission-view';
import { RECEIPTS_CONFIG, type ReceiptsConfig } from '../receipts.config';
import { iso, parseRiskFlags } from './receipt-view';
import { ReceiptsRepository } from './receipts.repository';
import { type TaxReceiptCheckResult, TaxReceiptVerifierPort } from './tax-receipt-verifier';

/**
 * Ledger idempotency key of a receipt credit: one ledger row per receipt. A receipt whose first
 * credit was reversed (tax check rejected it during the hold) and that a moderator approved
 * after an appeal is credited once more under the `reinstated` key.
 */
export function receiptLedgerKey(receiptId: string, attempt?: 'reinstated'): string {
  return attempt ? `receipt:${receiptId}:${attempt}` : `receipt:${receiptId}`;
}

export interface PipelineCredit {
  plan: CreditPlan;
  /** Null when the plan awarded 0 points (tenant daily cap reached). */
  entry: LedgerEntry | null;
}

export interface PipelineResult {
  receipt: Receipt;
  /** Set when this run evaluated the rules (parsed -> decision). */
  decision: ReceiptDecision | null;
  /** Set when this run credited the receipt. */
  credit: PipelineCredit | null;
  /** Active rules when this run loaded them. */
  rules: LoyaltyRules | null;
  /** Tenant of the receipt when this run loaded it. */
  tenant: TenantSummary | null;
}

interface TenantContext {
  lookup: FiscalNumberLookup | null;
  tenant: TenantSummary | null;
  ruleTenant: RuleTenant | null;
  tenantRule: RuleTenantRule | null;
}

/** Thrown inside a transaction to roll it back when another worker moved the receipt first. */
class ReceiptMovedConcurrently extends Error {
  constructor(readonly receiptId: string) {
    super(`Receipt ${receiptId} was moved by a concurrent transaction`);
    this.name = 'ReceiptMovedConcurrently';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toRuleTenant(tenant: TenantSummary | null, excluded = false): RuleTenant | null {
  return tenant
    ? {
        id: tenant.id,
        name: tenant.name,
        participates: tenant.participates,
        excludedFromProgram: tenant.excludedFromProgram || excluded,
        ratePercentOverride: tenant.ratePercentOverride,
      }
    : null;
}

export function toRuleTenantRule(rule: EffectiveTenantRule | null): RuleTenantRule | null {
  return rule
    ? {
        ratePercent: rule.ratePercent,
        minTotalKopecks: rule.minTotalKopecks,
        dailyCapPoints: rule.dailyCapPoints,
      }
    : null;
}

function statusOfDecision(decision: ReceiptDecision): ReceiptStatus {
  return decision.kind;
}

type CreditOutcome =
  | { kind: 'credited'; row: Receipt; entry: LedgerEntry | null; plan: CreditPlan }
  | { kind: 'moderated'; row: Receipt };

/**
 * The receipt pipeline (brief sections 6, 7, 9): uploaded -> parsed -> rules ->
 * auto_approved | needs_moderation | rejected, and auto_approved | approved -> credited through
 * CLUB_LEDGER_PORT. Every step is its own short transaction guarded by an optimistic status
 * check, so the synchronous path (submission, approval) and the `receipts-process` job share
 * this code and a retry never credits twice (ledger idempotency key `receipt:<id>`).
 *
 * Anti-fraud (forged QR receipts cannot be verified online): fraud patterns and the tax checker
 * answer feed the rules; auto-approved QR receipts of new accounts or above the fast-track total
 * are credited as pending (verification hold); the daily QR points cap and the tenant daily cap
 * are computed under a per-member advisory lock inside the credit transaction.
 */
@Injectable()
export class ReceiptPipelineService {
  private readonly logger = new Logger(ReceiptPipelineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: ReceiptsRepository,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    @Inject(CONTENT_PORT) private readonly content: ContentPort,
    @Inject(CLUB_LEDGER_PORT) private readonly ledger: ClubLedgerPort,
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    private readonly verifier: TaxReceiptVerifierPort,
    @Inject(RECEIPTS_CONFIG) private readonly config: ReceiptsConfig,
  ) {}

  /** Moves the receipt as far as the pipeline can take it; throws when a step fails. */
  async process(receiptId: string): Promise<PipelineResult> {
    let receipt = await this.load(receiptId);
    const result: PipelineResult = {
      receipt,
      decision: null,
      credit: null,
      rules: null,
      tenant: null,
    };

    if (receipt.status === 'uploaded') {
      receipt = await this.markParsed(receipt);
    }
    if (receipt.status === 'parsed') {
      const decided = await this.decide(receipt);
      receipt = decided.receipt;
      result.decision = decided.decision;
      result.rules = decided.rules;
      result.tenant = decided.tenant;
    }
    if (isCreditable(receipt.status)) {
      const credited = await this.credit(receipt);
      receipt = credited.receipt;
      result.credit = credited.credit;
      result.rules = credited.rules;
      result.tenant = credited.tenant ?? result.tenant;
    }
    result.receipt = receipt;
    return result;
  }

  async load(receiptId: string): Promise<Receipt> {
    const receipt = await this.repo.findById(this.prisma, receiptId);
    if (!receipt) {
      throw new DomainError(ReceiptErrors.PC_RECEIPT_NOT_FOUND, `Receipt ${receiptId} not found`);
    }
    return receipt;
  }

  /** Asks the tax checker; never throws (an unavailable checker is `unknown`). */
  async checkTax(receipt: Receipt): Promise<TaxReceiptCheckResult> {
    if (receipt.fn === null) {
      return { status: 'unknown', detail: 'no cash register number' };
    }
    const parsed = receipt.rawQr ? parseTaxQr(receipt.rawQr) : null;
    try {
      return await this.verifier.verify({
        receiptId: receipt.id,
        fn: receipt.fn,
        fiscalId: receipt.fiscalId,
        issuedAt: receipt.issuedAt,
        totalKopecks: receipt.totalKopecks,
        mac: parsed?.ok ? (parsed.value.mac ?? null) : null,
        rawQr: receipt.rawQr,
      });
    } catch (error) {
      this.logger.warn(`Tax check of receipt ${receipt.id} failed: ${describe(error)}`);
      return { status: 'unknown', detail: `checker error: ${describe(error)}` };
    }
  }

  private async markParsed(receipt: Receipt): Promise<Receipt> {
    assertTransition('uploaded', 'parsed', 'system');
    const now = this.clock.now();
    const moved = await this.prisma.withTx(async (tx) => {
      const row = await this.repo.transitionStatus(tx, receipt.id, 'uploaded', {
        status: 'parsed',
      });
      if (row) {
        await this.addEvent(tx, receipt.id, 'uploaded', 'parsed', 'fields validated', now);
      }
      return row;
    });
    return moved ?? this.load(receipt.id);
  }

  /**
   * Tenant of the receipt: from the fiscal-number whitelist when `fn` is known, otherwise the
   * tenant the member picked on the manual form (`tenantHint`).
   */
  private async loadTenantContext(
    fn: string | null,
    tenantHint: string | null,
    at: Date,
  ): Promise<TenantContext> {
    const lookup = fn === null ? null : await this.content.findTenantByFiscalNumber(fn);
    const tenantId = lookup?.tenantId ?? tenantHint;
    const tenant =
      (lookup?.tenantId ? lookup.tenant : null) ??
      (tenantId ? await this.content.getTenant(tenantId) : null);
    if (!tenant) {
      return { lookup, tenant: null, ruleTenant: null, tenantRule: null };
    }
    const [excluded, effectiveRule] = await Promise.all([
      this.content.isExcluded(tenant.id),
      this.content.getTenantRule(tenant.id, at),
    ]);
    return {
      lookup,
      tenant,
      ruleTenant: toRuleTenant(tenant, excluded),
      tenantRule: toRuleTenantRule(effectiveRule),
    };
  }

  /** Fraud patterns that force moderation (README, "Захист від підроблених чеків"). */
  private async detectPatterns(receipt: Receipt): Promise<ReceiptPatterns> {
    const submittedMs = receipt.submittedAt.getTime();
    const fn = receipt.fn;
    const [sameTotalOtherUser, roundTotalRepeat, fiscalIdOutOfOrder] = await Promise.all([
      fn === null
        ? Promise.resolve(false)
        : this.repo.existsSameTotalFromOtherUser(this.prisma, {
            receiptId: receipt.id,
            userId: receipt.userId,
            fn,
            totalKopecks: receipt.totalKopecks,
            since: new Date(submittedMs - SAME_TOTAL_WINDOW_MS),
          }),
      isRoundTotal(receipt.totalKopecks)
        ? this.repo
            .listTotalsForUserSince(
              this.prisma,
              receipt.userId,
              new Date(submittedMs - ROUND_TOTAL_WINDOW_MS),
              receipt.id,
            )
            .then((totals) => isRoundTotalRepeat(receipt.totalKopecks, totals))
        : Promise.resolve(false),
      fn === null || numericFiscalId(receipt.fiscalId) === null
        ? Promise.resolve(false)
        : this.repo
            .listFiscalIdNeighbours(this.prisma, {
              receiptId: receipt.id,
              fn,
              issuedAt: receipt.issuedAt,
              limit: FISCAL_ID_ORDER_NEIGHBOURS,
            })
            .then((neighbours) =>
              isFiscalIdOutOfOrder(
                { fiscalId: receipt.fiscalId, issuedAt: receipt.issuedAt },
                neighbours,
              ),
            ),
    ]);
    if (!sameTotalOtherUser && !roundTotalRepeat && !fiscalIdOutOfOrder) {
      return NO_PATTERNS;
    }
    return { sameTotalOtherUser, roundTotalRepeat, fiscalIdOutOfOrder };
  }

  private async decide(receipt: Receipt): Promise<{
    receipt: Receipt;
    decision: ReceiptDecision | null;
    rules: LoyaltyRules;
    tenant: TenantSummary | null;
  }> {
    const now = this.clock.now();
    const { rules } = await this.ledger.getActiveRules(now);
    const context = await this.loadTenantContext(receipt.fn, receipt.tenantId, receipt.issuedAt);
    const submittedMs = receipt.submittedAt.getTime();
    const dayStart = startOfKyivDay(receipt.submittedAt);
    const [receiptsToday, sameFnRecent, deviceShared, qrPointsToday, patterns] = await Promise.all([
      this.repo.countForUserBetween(
        this.prisma,
        receipt.userId,
        dayStart,
        receipt.submittedAt,
        receipt.id,
      ),
      receipt.fn === null
        ? Promise.resolve(0)
        : this.repo.countForUserFromFnSince(
            this.prisma,
            receipt.userId,
            receipt.fn,
            new Date(submittedMs - SAME_FN_BURST_WINDOW_MS),
            receipt.id,
          ),
      receipt.deviceId
        ? this.repo.hasOtherUserReceiptsForDevice(this.prisma, {
            receiptId: receipt.id,
            userId: receipt.userId,
            deviceId: receipt.deviceId,
            since: new Date(submittedMs - DEVICE_SHARED_WINDOW_MS),
          })
        : Promise.resolve(false),
      this.repo.sumQrPointsForUserBetween(
        this.prisma,
        receipt.userId,
        dayStart,
        addKyivDays(dayStart, 1),
        receipt.id,
      ),
      this.detectPatterns(receipt),
    ]);
    const taxCheck: TaxReceiptCheckResult | null =
      receipt.source === 'qr' ? await this.checkTax(receipt) : null;

    const decision = evaluateReceipt({
      source: receipt.source,
      fn: receipt.fn ?? '',
      issuedAt: receipt.issuedAt,
      totalKopecks: receipt.totalKopecks,
      submittedAt: receipt.submittedAt,
      // Windows (too old / future) are measured from the submission, not from a job retry.
      now: receipt.submittedAt,
      fiscalNumber: context.lookup
        ? { status: context.lookup.status, tenantId: context.lookup.tenantId }
        : null,
      tenant: context.ruleTenant,
      tenantRule: context.tenantRule,
      receiptsToday,
      sameFnRecent,
      deviceShared,
      rules,
      qrPointsToday,
      dailyQrPointsCap: this.config.RECEIPTS_DAILY_POINTS_CAP,
      patterns,
      taxCheck: taxCheck?.status ?? 'unknown',
    });
    const to = statusOfDecision(decision);
    assertTransition('parsed', to, 'system');
    const verification = verificationOfTaxCheck(taxCheck?.status ?? null);

    const moved = await this.prisma.withTx(async (tx) => {
      if (receipt.fn !== null && context.lookup === null) {
        // Unknown cash register: let content queue it for mapping (status pending); the receipt
        // id travels in tenant.fiscal_number_seen so moderators see where the number came from.
        await this.content.recordSeenFiscalNumber(receipt.fn, tx, { receiptId: receipt.id });
      }
      const row = await this.repo.transitionStatus(tx, receipt.id, 'parsed', {
        status: to,
        tenantId: context.tenant?.id ?? null,
        riskFlags: decision.risk.flags,
        riskScore: decision.risk.score,
        moderationReasons: decision.kind === 'needs_moderation' ? decision.reasons : [],
        rejectionCode: decision.kind === 'rejected' ? decision.code : null,
        ...(verification !== null ? { verification, verificationCheckedAt: now } : {}),
        ...(decision.kind === 'rejected'
          ? { decisionReason: decision.reason, decidedAt: now }
          : {}),
      });
      if (!row) {
        return null;
      }
      const taxNote =
        taxCheck && taxCheck.status !== 'unknown' ? `; tax check: ${taxCheck.status}` : '';
      await this.addEvent(
        tx,
        receipt.id,
        'parsed',
        to,
        `${describeDecision(decision)}${taxNote}`,
        now,
      );
      if (decision.kind === 'needs_moderation') {
        await this.publishNeedsModeration(tx, row, decision.risk.flags, decision.risk.score);
      } else if (decision.kind === 'rejected') {
        await this.outbox.publish(
          tx,
          buildOutboxEvent(RECEIPT_EVENTS.rejected, OUTBOX_AGGREGATES.receipt, row.id, {
            receiptId: row.id,
            userId: row.userId,
            moderatorId: null,
            reason: decision.reason,
            code: decision.code,
          }),
        );
      }
      return row;
    });

    if (!moved) {
      return {
        receipt: await this.load(receipt.id),
        decision: null,
        rules,
        tenant: context.tenant,
      };
    }
    return { receipt: moved, decision, rules, tenant: context.tenant };
  }

  /** Registration time of the member; null when identity cannot tell (treated as new). */
  private async accountCreatedAt(userId: string): Promise<Date | null> {
    try {
      return (await this.identity.getUser(userId))?.createdAt ?? null;
    } catch (error) {
      this.logger.warn(`Account age of ${userId} unavailable, holding as new: ${describe(error)}`);
      return null;
    }
  }

  private async credit(receipt: Receipt): Promise<{
    receipt: Receipt;
    credit: PipelineCredit | null;
    rules: LoyaltyRules;
    tenant: TenantSummary | null;
  }> {
    const from = receipt.status;
    assertTransition(from, 'credited', 'system');
    const now = this.clock.now();
    const { rules } = await this.ledger.getActiveRules(now);
    const tenant = receipt.tenantId ? await this.content.getTenant(receipt.tenantId) : null;
    const tenantRule = tenant
      ? toRuleTenantRule(await this.content.getTenantRule(tenant.id, receipt.issuedAt))
      : null;
    // Only the auto-approval of a QR receipt is fast-tracked; a moderator decision is final.
    const autoQr = from === 'auto_approved' && receipt.source === 'qr';
    const holdUntil = autoQr
      ? verificationHoldUntil({
          source: receipt.source,
          autoApproved: true,
          totalKopecks: receipt.totalKopecks,
          accountCreatedAt: await this.accountCreatedAt(receipt.userId),
          taxCheck: receipt.verification === 'confirmed' ? 'confirmed' : null,
          now,
          settings: {
            verifyHoldHours: this.config.RECEIPTS_VERIFY_HOLD_HOURS,
            newAccountDays: this.config.RECEIPTS_NEW_ACCOUNT_DAYS,
            fastTrackMaxKopecks: this.config.RECEIPTS_FAST_TRACK_MAX_KOPECKS,
          },
        })
      : null;
    const dayStart = startOfKyivDay(receipt.submittedAt);
    const dayEnd = addKyivDays(dayStart, 1);

    try {
      const outcome = await this.prisma.withTx(async (tx): Promise<CreditOutcome> => {
        // Daily caps and the first-receipt flag are read after every concurrent credit of the
        // same member has committed (finding: two parallel receipts both passing the cap).
        await this.repo.lockMember(tx, receipt.userId);
        const tenantPointsToday =
          tenant && tenantRule?.dailyCapPoints !== null && tenantRule?.dailyCapPoints !== undefined
            ? await this.repo.sumPointsForTenantBetween(
                tx,
                receipt.userId,
                tenant.id,
                dayStart,
                dayEnd,
                receipt.id,
              )
            : 0;
        const firstReceipt =
          (await this.repo.countCreditedForUser(tx, receipt.userId, receipt.id)) === 0;
        const plan = buildCreditPlan({
          totalKopecks: receipt.totalKopecks,
          rules,
          tenant: toRuleTenant(tenant),
          tenantRule,
          tenantPointsToday,
          now,
          verificationHoldUntil: holdUntil,
        });

        if (autoQr) {
          const qrPointsToday = await this.repo.sumQrPointsForUserBetween(
            tx,
            receipt.userId,
            dayStart,
            dayEnd,
            receipt.id,
          );
          if (
            exceedsDailyQrCap(qrPointsToday, plan.points, this.config.RECEIPTS_DAILY_POINTS_CAP)
          ) {
            return { kind: 'moderated', row: await this.moderateOverCap(tx, receipt, rules, now) };
          }
        }

        let entry: LedgerEntry | null = null;
        if (plan.points > 0) {
          const input: CreditPointsInput = {
            userId: receipt.userId,
            amount: plan.points,
            type: 'earn',
            sourceType: 'receipt',
            sourceId: receipt.id,
            idempotencyKey: receiptLedgerKey(
              receipt.id,
              receipt.pointsTxId !== null ? 'reinstated' : undefined,
            ),
            expiresAt: plan.expiresAt,
            reason: `Чек ${tenant?.name ?? receipt.fn ?? receipt.fiscalId}`,
            ...receiptLedgerDisplay(receipt, tenant),
          };
          entry =
            plan.state === 'pending'
              ? await this.ledger.hold({ ...input, availableAt: plan.availableAt }, tx)
              : await this.ledger.credit(input, tx);
        }
        const verificationPending = plan.verificationHold && entry !== null;
        const row = await this.repo.transitionStatus(tx, receipt.id, from, {
          status: 'credited',
          pointsAwarded: plan.points,
          pointsTxId: entry?.id ?? null,
          ...(verificationPending
            ? { verification: 'pending', verifyUntil: plan.availableAt }
            : {}),
        });
        if (!row) {
          throw new ReceiptMovedConcurrently(receipt.id);
        }
        const holdNote = verificationPending ? ' (verification hold)' : '';
        const note =
          entry === null
            ? 'tenant daily cap reached: 0 points'
            : plan.state === 'pending'
              ? `+${plan.points} points pending until ${plan.availableAt.toISOString()}${holdNote}`
              : `+${plan.points} points available`;
        await this.addEvent(tx, receipt.id, from, 'credited', note, now);
        if (entry !== null) {
          await this.outbox.publish(
            tx,
            buildOutboxEvent(RECEIPT_EVENTS.credited, OUTBOX_AGGREGATES.receipt, row.id, {
              receiptId: row.id,
              userId: row.userId,
              tenantId: row.tenantId,
              totalKopecks: row.totalKopecks,
              pointsAwarded: plan.points,
              pointsTxId: entry.id,
              pointsState: entry.state === 'pending' ? 'pending' : 'available',
              availableAt:
                entry.state === 'pending' ? iso(entry.availableAt ?? plan.availableAt) : null,
              firstReceipt,
            }),
          );
        }
        return { kind: 'credited', row, entry, plan };
      });
      if (outcome.kind === 'moderated') {
        return { receipt: outcome.row, credit: null, rules, tenant };
      }
      return {
        receipt: outcome.row,
        credit: { plan: outcome.plan, entry: outcome.entry },
        rules,
        tenant,
      };
    } catch (error) {
      if (error instanceof ReceiptMovedConcurrently) {
        return { receipt: await this.load(receipt.id), credit: null, rules, tenant };
      }
      throw error;
    }
  }

  /**
   * auto_approved -> needs_moderation when a concurrent receipt of the same member used up the
   * daily QR points cap between the decision and the credit (re-checked under the lock).
   */
  private async moderateOverCap(
    tx: Tx,
    receipt: Receipt,
    rules: LoyaltyRules,
    now: Date,
  ): Promise<Receipt> {
    assertTransition('auto_approved', 'needs_moderation', 'system');
    const reasons: ModerationReason[] = [
      ...new Set<ModerationReason>([
        ...parseModerationReasons(receipt.moderationReasons),
        'daily_points_cap',
      ]),
    ];
    const risk = assessRisk(
      {
        issuedAt: receipt.issuedAt,
        submittedAt: receipt.submittedAt,
        totalKopecks: receipt.totalKopecks,
        // The receipt passed the whitelist when it was auto-approved.
        fiscalNumber: { status: 'active', tenantId: receipt.tenantId },
        deviceShared: parseRiskFlags(receipt.riskFlags).includes('device_shared'),
        rules,
      },
      reasons,
    );
    const row = await this.repo.transitionStatus(tx, receipt.id, 'auto_approved', {
      status: 'needs_moderation',
      moderationReasons: reasons,
      riskFlags: parseRiskFlags(receipt.riskFlags),
      riskScore: Math.max(receipt.riskScore, risk.score),
    });
    if (!row) {
      throw new ReceiptMovedConcurrently(receipt.id);
    }
    await this.addEvent(
      tx,
      receipt.id,
      'auto_approved',
      'needs_moderation',
      'moderation: daily_points_cap (reached by a concurrent receipt)',
      now,
    );
    await this.publishNeedsModeration(tx, row, parseRiskFlags(row.riskFlags), row.riskScore);
    return row;
  }

  private async publishNeedsModeration(
    tx: Tx,
    row: Receipt,
    riskFlags: ReturnType<typeof parseRiskFlags>,
    riskScore: number,
  ): Promise<void> {
    await this.outbox.publish(
      tx,
      buildOutboxEvent(RECEIPT_EVENTS.needsModeration, OUTBOX_AGGREGATES.receipt, row.id, {
        receiptId: row.id,
        userId: row.userId,
        tenantId: row.tenantId,
        totalKopecks: row.totalKopecks,
        riskFlags,
        riskScore,
      }),
    );
  }

  private async addEvent(
    tx: Tx,
    receiptId: string,
    fromStatus: ReceiptStatus | null,
    toStatus: ReceiptStatus,
    note: string | null,
    createdAt: Date,
  ): Promise<void> {
    await this.repo.addEvent(tx, {
      id: uuidv7(),
      receiptId,
      fromStatus,
      toStatus,
      actorType: 'system',
      actorId: null,
      note,
      createdAt,
    });
  }
}

/**
 * Display data of the ledger row of a receipt credit (member history): "Нарахування за чек",
 * "INTERTOP · 6 000 ₴" and the counterparty with the tenant and the receipt total.
 */
export function receiptLedgerDisplay(
  receipt: Pick<Receipt, 'id' | 'tenantId' | 'totalKopecks' | 'fiscalId'>,
  tenant: Pick<TenantSummary, 'id' | 'name'> | null,
): Pick<CreditPointsInput, 'title' | 'subtitle' | 'counterparty'> {
  const total = formatUah(receipt.totalKopecks, { fraction: 'auto' });
  return {
    title: 'Нарахування за чек',
    subtitle: tenant ? `${tenant.name} · ${total}` : `Чек № ${receipt.fiscalId} · ${total}`,
    counterparty: {
      tenantId: tenant?.id ?? receipt.tenantId,
      tenantName: tenant?.name ?? null,
      receiptId: receipt.id,
      receiptTotalKopecks: receipt.totalKopecks,
    },
  };
}

/** Verification column written by the decision; null keeps the default (`not_required`). */
function verificationOfTaxCheck(status: TaxCheckStatus | null): 'confirmed' | 'rejected' | null {
  return status === 'confirmed' || status === 'rejected' ? status : null;
}
