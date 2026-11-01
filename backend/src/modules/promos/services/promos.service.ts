import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import {
  OUTBOX_AGGREGATES,
  PROMO_EVENTS,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import {
  type ClaimCheck,
  type ClaimValidation,
  GUEST_CLAIM_CODE,
  type PromoSummary,
} from '../../../common/contracts/promos';
import { VOUCHER_ISSUER_PORT, type VoucherIssuerPort } from '../../../common/contracts/rewards';
import { DomainError } from '../../../common/errors/domain-error';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { type DbClient, PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { PromosErrors } from '../domain/errors';
import {
  type ClaimContext,
  type ClaimDecision,
  couponExpiresAt,
  decideClaim,
  remainingCoupons,
} from '../domain/promo-rules';
import { buildCouponDraft } from '../domain/ticket';
import type { ListPromosQueryDto } from '../dto/promo-query.dto';
import type { ClaimResultDto, ClaimStateDto, PromoDetailDto, PromoDto } from '../dto/promo.dto';
import { isPromoCursor } from './cursors';
import {
  type PromoWithTemplate,
  toCouponTemplateSummary,
  toPromoSummary,
  toVoucherDto,
} from './mappers';
import { PromosPresenter } from './promos-presenter.service';

/** Result of the voucher.cancelled consumer for a coupon. */
export type CouponClaimCancelOutcome = 'coupon_released' | 'already_cancelled' | 'not_found';

function claimRejection(decision: Extract<ClaimDecision, { allowed: false }>): DomainError {
  return new DomainError(PromosErrors[decision.code], decision.detail);
}

/**
 * Member-facing promos: the published list, the detail with the caller's claim state and the
 * coupon claim itself (brief section 8). List and detail are guest-readable (`@OptionalAuth()`);
 * a guest gets `claim = { allowed: false, code: PC_AUTH_REQUIRED }`. Every claim is a
 * `coupon_claims` row; the coupon itself is a voucher issued through VOUCHER_ISSUER_PORT with
 * `sourceType = promo`, `sourceId = claim id`.
 */
@Injectable()
export class PromosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    @Inject(VOUCHER_ISSUER_PORT) private readonly vouchers: VoucherIssuerPort,
    private readonly presenter: PromosPresenter,
  ) {}

  /** Published promos inside their validity window, highest priority first. */
  async listPublished(query: ListPromosQueryDto): Promise<Page<PromoDto>> {
    const now = this.clock.now();
    const cursor = decodeCursor(query.cursor, isPromoCursor);
    const conditions: Prisma.PromoWhereInput[] = [
      { status: 'published', validFrom: { lte: now }, validTo: { gte: now } },
    ];
    if (query.tenantId) {
      conditions.push({ tenantId: query.tenantId });
    }
    if (query.kind) {
      conditions.push({ kind: query.kind });
    }
    if (query.category) {
      conditions.push({ category: query.category });
    }
    if (cursor) {
      conditions.push({
        OR: [
          { priority: { lt: cursor.priority } },
          { priority: cursor.priority, id: { lt: cursor.id } },
        ],
      });
    }
    const rows = await this.prisma.promo.findMany({
      where: { AND: conditions },
      include: { couponTemplate: true },
      orderBy: [{ priority: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit, (last) => ({ priority: last.priority, id: last.id }));
    return {
      items: await this.presenter.promoDtos(page.items, now),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * A published promo (any window) with the caller's claim state; drafts and archives are 404.
   * Without `userId` (guest) the claim is refused with PC_AUTH_REQUIRED.
   */
  async getPublishedForMember(promoId: string, userId?: string): Promise<PromoDetailDto> {
    const now = this.clock.now();
    const promo = await this.prisma.promo.findUnique({
      where: { id: promoId },
      include: { couponTemplate: true },
    });
    if (!promo || promo.status !== 'published') {
      throw new DomainError(PromosErrors.PC_PROMO_NOT_FOUND, `Promo ${promoId} not found`);
    }
    const [dto, claim] = await Promise.all([
      this.presenter.promoDto(promo, now),
      userId ? this.claimState(promo, userId, now) : Promise.resolve(guestClaimState()),
    ]);
    return { ...dto, claim };
  }

  /**
   * Issues a coupon voucher for the member. The coupon template row is locked for the duration
   * of the transaction, so pool and per-member limits are checked against committed claims.
   */
  async claim(promoId: string, userId: string): Promise<ClaimResultDto> {
    const now = this.clock.now();
    const preview = await this.prisma.promo.findUnique({
      where: { id: promoId },
      include: { couponTemplate: true },
    });
    const preliminary = decideClaim(preview, preview?.couponTemplate ?? null, {
      now,
      userClaimCount: 0,
    });
    if (!preliminary.allowed) {
      throw claimRejection(preliminary);
    }
    const templateId = preview?.couponTemplateId;
    if (!templateId) {
      throw new DomainError(PromosErrors.PC_PROMO_NOT_COUPON, 'Promo has no coupon template');
    }

    return this.prisma.withTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM coupon_templates WHERE id = ${templateId}::uuid FOR UPDATE`;
      const promo = await tx.promo.findUnique({
        where: { id: promoId },
        include: { couponTemplate: true },
      });
      const template = promo?.couponTemplate ?? null;
      const userClaimCount = await this.countActiveClaims(tx, promoId, userId);
      const decision = decideClaim(promo, template, { now, userClaimCount });
      if (!decision.allowed) {
        throw claimRejection(decision);
      }
      if (!promo || !template) {
        throw new DomainError(PromosErrors.PC_PROMO_NOT_COUPON, 'Promo has no coupon template');
      }

      const claimId = uuidv7();
      const draft = buildCouponDraft(promo, template, {
        claimId,
        expiresAt: couponExpiresAt(promo, template, now),
      });
      const voucher = await this.vouchers.issue(
        {
          userId,
          kind: 'coupon',
          title: draft.title,
          subtitle: draft.subtitle,
          ...(promo.tenantId ? { tenantId: promo.tenantId } : {}),
          expiresAt: draft.expiresAt,
          sourceType: 'promo',
          sourceId: claimId,
          meta: draft.meta,
        },
        tx,
      );
      await tx.couponClaim.create({
        data: {
          id: claimId,
          promoId: promo.id,
          couponTemplateId: template.id,
          userId,
          voucherId: voucher.id,
          status: 'active',
          createdAt: now,
        },
      });
      const updatedTemplate = await tx.couponTemplate.update({
        where: { id: template.id },
        data: { claimedCount: { increment: 1 } },
      });
      await this.outbox.publish(
        tx,
        buildOutboxEvent(PROMO_EVENTS.couponClaimed, OUTBOX_AGGREGATES.promo, promo.id, {
          promoId: promo.id,
          couponTemplateId: template.id,
          userId,
          voucherId: voucher.id,
        }),
      );
      const claimedByMe = userClaimCount + 1;
      return {
        promoId: promo.id,
        couponTemplateId: template.id,
        voucher: toVoucherDto(voucher),
        claimedByMe,
        remainingForMe: Math.max(template.perUserLimit - claimedByMe, 0),
        remainingInPool: remainingCoupons(updatedTemplate),
      };
    });
  }

  /** PromosPort.validateClaim: the same rules as `claim`, without the lock and without effects. */
  async validateClaim(check: ClaimCheck): Promise<ClaimValidation> {
    const now = check.now ?? this.clock.now();
    const promo = await this.prisma.promo.findUnique({
      where: { id: check.promoId },
      include: { couponTemplate: true },
    });
    const template = promo?.couponTemplate ?? null;
    const context = await this.claimContext(promo, check.userId, now);
    const decision = decideClaim(promo, template, context);
    if (!decision.allowed) {
      return { allowed: false, code: decision.code, detail: decision.detail };
    }
    if (!promo || !template) {
      return {
        allowed: false,
        code: 'PC_PROMO_NOT_COUPON',
        detail: 'Promo has no coupon template',
      };
    }
    return {
      allowed: true,
      promo: toPromoSummary(promo),
      template: toCouponTemplateSummary(template),
    };
  }

  /** PromosPort.getPromo. */
  async getPromoSummary(promoId: string): Promise<PromoSummary | null> {
    const promo = await this.prisma.promo.findUnique({ where: { id: promoId } });
    return promo ? toPromoSummary(promo) : null;
  }

  /**
   * Outbox consumer of voucher.cancelled for a coupon (`claimId` = the voucher's sourceId): the
   * claim becomes `cancelled` and the coupon goes back to the pool (claimedCount - 1, never below
   * 0). Idempotent: only the transition from `active` releases a coupon.
   */
  async cancelCouponClaim(claimId: string): Promise<CouponClaimCancelOutcome> {
    const now = this.clock.now();
    return this.prisma.withTx(async (tx) => {
      const claim = await tx.couponClaim.findUnique({ where: { id: claimId } });
      if (!claim) {
        return 'not_found';
      }
      const cancelled = await tx.couponClaim.updateMany({
        where: { id: claimId, status: 'active' },
        data: { status: 'cancelled', cancelledAt: now },
      });
      if (cancelled.count === 0) {
        return 'already_cancelled';
      }
      await tx.couponTemplate.updateMany({
        where: { id: claim.couponTemplateId, claimedCount: { gt: 0 } },
        data: { claimedCount: { decrement: 1 } },
      });
      return 'coupon_released';
    });
  }

  private async claimState(
    promo: PromoWithTemplate,
    userId: string,
    now: Date,
  ): Promise<ClaimStateDto> {
    const context = await this.claimContext(promo, userId, now);
    const decision = decideClaim(promo, promo.couponTemplate, context);
    return {
      allowed: decision.allowed,
      code: decision.allowed ? null : decision.code,
      detail: decision.allowed ? null : decision.detail,
      claimedByMe: context.userClaimCount,
    };
  }

  /** Claim counts only matter when the promo can possibly be claimed. */
  private async claimContext(
    promo: PromoWithTemplate | null,
    userId: string,
    now: Date,
  ): Promise<ClaimContext> {
    if (!promo || !promo.couponTemplate || promo.kind !== 'coupon') {
      return { now, userClaimCount: 0 };
    }
    return { now, userClaimCount: await this.countActiveClaims(this.prisma, promo.id, userId) };
  }

  /** Coupons the member holds for the promo; cancelled claims do not count against the limit. */
  private countActiveClaims(db: DbClient, promoId: string, userId: string): Promise<number> {
    return db.couponClaim.count({ where: { promoId, userId, status: 'active' } });
  }
}

/** Claim state of an anonymous caller: sign in first. */
export function guestClaimState(): ClaimStateDto {
  return {
    allowed: false,
    code: GUEST_CLAIM_CODE,
    detail: 'Sign in to claim this coupon',
    claimedByMe: 0,
  };
}
