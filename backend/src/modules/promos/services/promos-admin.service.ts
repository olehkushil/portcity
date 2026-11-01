import { Inject, Injectable } from '@nestjs/common';
import type { CouponTemplate, Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import { CONTENT_PORT, type ContentPort } from '../../../common/contracts/content';
import {
  OUTBOX_AGGREGATES,
  PROMO_EVENTS,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import type { PromoKind } from '../../../common/contracts/promos';
import { DomainError } from '../../../common/errors/domain-error';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { isForeignKeyViolation, isUniqueViolation } from '../../../common/prisma/prisma.errors';
import { PrismaService, type Tx } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { PromosErrors } from '../domain/errors';
import { isValidCouponLimits, isValidPromoWindow } from '../domain/promo-rules';
import { assertPromoTransition } from '../domain/promo-state';
import type {
  CreateCouponTemplateDto,
  CreatePromoDto,
  UpdateCouponTemplateDto,
  UpdatePromoDto,
} from '../dto/admin-promo.dto';
import type {
  AdminListCouponTemplatesQueryDto,
  AdminListPromosQueryDto,
} from '../dto/promo-query.dto';
import type { CouponTemplateDto, PromoDto } from '../dto/promo.dto';
import { isIdCursor } from './cursors';
import { type PromoWithTemplate, toCouponTemplateDto } from './mappers';
import { PromosPresenter } from './promos-presenter.service';

/** Back-office principal, taken from the admin access token and the request. */
export interface AdminActor {
  id: string;
  ip?: string | null;
}

const PROMO_INCLUDE = { couponTemplate: true } as const;

/**
 * Back-office CRUD for promos and coupon templates (brief section 8, admin). Every mutation is
 * audited through ADMIN_AUDIT_PORT inside the same transaction.
 */
@Injectable()
export class PromosAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    @Inject(CONTENT_PORT) private readonly content: ContentPort,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
    private readonly presenter: PromosPresenter,
  ) {}

  // ---------------------------------------------------------------------------------------
  // Coupon templates
  // ---------------------------------------------------------------------------------------

  async listTemplates(query: AdminListCouponTemplatesQueryDto): Promise<Page<CouponTemplateDto>> {
    const cursor = decodeCursor(query.cursor, isIdCursor);
    const conditions: Prisma.CouponTemplateWhereInput[] = [];
    if (query.q) {
      conditions.push({ discountText: { contains: query.q, mode: 'insensitive' } });
    }
    if (cursor) {
      conditions.push({ id: { lt: cursor.id } });
    }
    const rows = await this.prisma.couponTemplate.findMany({
      where: { AND: conditions },
      orderBy: [{ id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit, (last) => ({ id: last.id }));
    return { items: page.items.map(toCouponTemplateDto), nextCursor: page.nextCursor };
  }

  async getTemplate(templateId: string): Promise<CouponTemplateDto> {
    return toCouponTemplateDto(await this.requireTemplate(this.prisma, templateId));
  }

  async createTemplate(
    input: CreateCouponTemplateDto,
    actor: AdminActor,
  ): Promise<CouponTemplateDto> {
    const now = this.clock.now();
    const data = this.templateCreateData(input, now);
    return this.prisma.withTx(async (tx) => {
      const row = await tx.couponTemplate.create({ data });
      await this.auditAs(tx, actor, 'coupon_template.create', 'coupon_template', row.id, {
        after: row,
      });
      return toCouponTemplateDto(row);
    });
  }

  async updateTemplate(
    templateId: string,
    input: UpdateCouponTemplateDto,
    actor: AdminActor,
  ): Promise<CouponTemplateDto> {
    const now = this.clock.now();
    return this.prisma.withTx(async (tx) => {
      const before = await this.requireTemplate(tx, templateId);
      const merged = {
        perUserLimit: input.perUserLimit ?? before.perUserLimit,
        totalLimit: input.totalLimit === undefined ? before.totalLimit : input.totalLimit,
        validityHoursAfterClaim:
          input.validityHoursAfterClaim === undefined
            ? before.validityHoursAfterClaim
            : input.validityHoursAfterClaim,
      };
      this.assertTemplateLimits(merged);
      const row = await tx.couponTemplate.update({
        where: { id: templateId },
        data: {
          ...(input.discountText !== undefined ? { discountText: input.discountText } : {}),
          ...(input.requiresActivation !== undefined
            ? { requiresActivation: input.requiresActivation }
            : {}),
          ...(input.terms !== undefined ? { terms: input.terms } : {}),
          perUserLimit: merged.perUserLimit,
          totalLimit: merged.totalLimit,
          validityHoursAfterClaim: merged.validityHoursAfterClaim,
          updatedAt: now,
        },
      });
      await this.auditAs(tx, actor, 'coupon_template.update', 'coupon_template', row.id, {
        before,
        after: row,
      });
      return toCouponTemplateDto(row);
    });
  }

  async deleteTemplate(templateId: string, actor: AdminActor, reason?: string): Promise<void> {
    await this.prisma.withTx(async (tx) => {
      const before = await this.requireTemplate(tx, templateId);
      const linked = await tx.promo.findUnique({ where: { couponTemplateId: templateId } });
      if (linked) {
        throw new DomainError(
          PromosErrors.PC_COUPON_TEMPLATE_IN_USE,
          `Coupon template is linked to promo ${linked.id}`,
          { details: { promoId: linked.id } },
        );
      }
      try {
        await tx.couponTemplate.delete({ where: { id: templateId } });
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw new DomainError(
            PromosErrors.PC_COUPON_TEMPLATE_IN_USE,
            'Coupon template is linked to a promo',
          );
        }
        throw error;
      }
      await this.auditAs(tx, actor, 'coupon_template.delete', 'coupon_template', templateId, {
        before,
        after: null,
        reason,
      });
    });
  }

  // ---------------------------------------------------------------------------------------
  // Promos
  // ---------------------------------------------------------------------------------------

  async listPromos(query: AdminListPromosQueryDto): Promise<Page<PromoDto>> {
    const now = this.clock.now();
    const cursor = decodeCursor(query.cursor, isIdCursor);
    const conditions: Prisma.PromoWhereInput[] = [];
    if (query.status) {
      conditions.push({ status: query.status });
    }
    if (query.tenantId) {
      conditions.push({ tenantId: query.tenantId });
    }
    if (query.kind) {
      conditions.push({ kind: query.kind });
    }
    if (query.category) {
      conditions.push({ category: query.category });
    }
    if (query.q) {
      conditions.push({ title: { contains: query.q, mode: 'insensitive' } });
    }
    if (cursor) {
      conditions.push({ id: { lt: cursor.id } });
    }
    const rows = await this.prisma.promo.findMany({
      where: { AND: conditions },
      include: PROMO_INCLUDE,
      orderBy: [{ id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit, (last) => ({ id: last.id }));
    return {
      items: await this.presenter.promoDtos(page.items, now),
      nextCursor: page.nextCursor,
    };
  }

  async getPromo(promoId: string): Promise<PromoDto> {
    const row = await this.requirePromo(this.prisma, promoId);
    return this.toDto(row);
  }

  async createPromo(input: CreatePromoDto, actor: AdminActor): Promise<PromoDto> {
    const now = this.clock.now();
    const kind: PromoKind = input.kind ?? 'info';
    this.assertWindow(input.validFrom, input.validTo);
    if (input.couponTemplateId && input.couponTemplate) {
      throw new DomainError(
        PromosErrors.PC_PROMO_TEMPLATE_REQUIRED,
        'Pass either couponTemplateId or an inline couponTemplate, not both',
      );
    }
    if (kind === 'coupon' && !input.couponTemplateId && !input.couponTemplate) {
      throw new DomainError(
        PromosErrors.PC_PROMO_TEMPLATE_REQUIRED,
        'A coupon promo needs couponTemplateId or an inline couponTemplate',
      );
    }
    if (kind === 'info' && (input.couponTemplateId || input.couponTemplate)) {
      throw new DomainError(
        PromosErrors.PC_PROMO_NOT_COUPON,
        'An info promo cannot carry a coupon template; set kind = coupon',
      );
    }
    await this.assertTenant(input.tenantId ?? null);

    return this.prisma.withTx(async (tx) => {
      let couponTemplateId: string | null = input.couponTemplateId ?? null;
      if (input.couponTemplate) {
        const template = await tx.couponTemplate.create({
          data: this.templateCreateData(input.couponTemplate, now),
        });
        couponTemplateId = template.id;
        await this.auditAs(tx, actor, 'coupon_template.create', 'coupon_template', template.id, {
          after: template,
        });
      } else if (couponTemplateId) {
        await this.assertTemplateFree(tx, couponTemplateId, null);
      }
      const id = uuidv7();
      const row = await this.createPromoRow(tx, {
        id,
        tenantId: input.tenantId ?? null,
        title: input.title,
        body: input.body,
        kind,
        category: input.category ?? 'other',
        validFrom: input.validFrom,
        validTo: input.validTo,
        imageKey: input.imageKey ?? null,
        status: 'draft',
        couponTemplateId,
        priority: input.priority ?? 0,
        createdAt: now,
        updatedAt: now,
      });
      await this.auditAs(tx, actor, 'promo.create', 'promo', row.id, { after: row });
      return this.toDto(row);
    });
  }

  async updatePromo(promoId: string, input: UpdatePromoDto, actor: AdminActor): Promise<PromoDto> {
    const now = this.clock.now();
    if (input.tenantId !== undefined) {
      await this.assertTenant(input.tenantId);
    }
    return this.prisma.withTx(async (tx) => {
      const before = await this.requirePromo(tx, promoId);
      const kind: PromoKind = input.kind ?? before.kind;
      const validFrom = input.validFrom ?? before.validFrom;
      const validTo = input.validTo ?? before.validTo;
      const couponTemplateId =
        input.couponTemplateId === undefined ? before.couponTemplateId : input.couponTemplateId;
      this.assertWindow(validFrom, validTo);
      if (kind === 'coupon' && !couponTemplateId) {
        throw new DomainError(
          PromosErrors.PC_PROMO_TEMPLATE_REQUIRED,
          'A coupon promo needs a coupon template',
        );
      }
      if (kind === 'info' && couponTemplateId) {
        throw new DomainError(
          PromosErrors.PC_PROMO_NOT_COUPON,
          'An info promo cannot carry a coupon template; unset couponTemplateId or set kind = coupon',
        );
      }
      if (couponTemplateId && couponTemplateId !== before.couponTemplateId) {
        await this.assertTemplateFree(tx, couponTemplateId, promoId);
      }
      let row: PromoWithTemplate;
      try {
        row = await tx.promo.update({
          where: { id: promoId },
          data: {
            ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.imageKey !== undefined ? { imageKey: input.imageKey } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(input.category !== undefined ? { category: input.category } : {}),
            kind,
            validFrom,
            validTo,
            couponTemplateId,
            updatedAt: now,
          },
          include: PROMO_INCLUDE,
        });
      } catch (error) {
        throw this.translatePromoWriteError(error);
      }
      await this.auditAs(tx, actor, 'promo.update', 'promo', row.id, { before, after: row });
      return this.toDto(row);
    });
  }

  /** draft -> published; emits `promo.published` for notifications. */
  async publishPromo(promoId: string, actor: AdminActor, reason?: string): Promise<PromoDto> {
    const now = this.clock.now();
    return this.prisma.withTx(async (tx) => {
      const before = await this.requirePromo(tx, promoId);
      assertPromoTransition(before.status, 'published');
      if (before.validTo.getTime() <= now.getTime()) {
        throw new DomainError(
          PromosErrors.PC_PROMO_DATES_INVALID,
          'validTo is already in the past; extend the window before publishing',
        );
      }
      if (before.kind === 'coupon' && !before.couponTemplate) {
        throw new DomainError(
          PromosErrors.PC_PROMO_TEMPLATE_REQUIRED,
          'A coupon promo needs a coupon template before it can be published',
        );
      }
      const row = await tx.promo.update({
        where: { id: promoId },
        data: { status: 'published', updatedAt: now },
        include: PROMO_INCLUDE,
      });
      await this.outbox.publish(
        tx,
        buildOutboxEvent(PROMO_EVENTS.published, OUTBOX_AGGREGATES.promo, row.id, {
          promoId: row.id,
          tenantId: row.tenantId,
          title: row.title,
          kind: row.kind,
          validTo: row.validTo.toISOString(),
        }),
      );
      await this.auditAs(tx, actor, 'promo.publish', 'promo', row.id, {
        before: { status: before.status },
        after: { status: row.status },
        reason,
      });
      return this.toDto(row);
    });
  }

  /** draft|published -> archived (final). */
  async archivePromo(promoId: string, actor: AdminActor, reason?: string): Promise<PromoDto> {
    const now = this.clock.now();
    return this.prisma.withTx(async (tx) => {
      const before = await this.requirePromo(tx, promoId);
      assertPromoTransition(before.status, 'archived');
      const row = await tx.promo.update({
        where: { id: promoId },
        data: { status: 'archived', updatedAt: now },
        include: PROMO_INCLUDE,
      });
      await this.auditAs(tx, actor, 'promo.archive', 'promo', row.id, {
        before: { status: before.status },
        after: { status: row.status },
        reason,
      });
      return this.toDto(row);
    });
  }

  /** Only drafts can be deleted; everything else is archived to keep claim history coherent. */
  async deletePromo(promoId: string, actor: AdminActor, reason?: string): Promise<void> {
    await this.prisma.withTx(async (tx) => {
      const before = await this.requirePromo(tx, promoId);
      if (before.status !== 'draft') {
        throw new DomainError(
          PromosErrors.PC_PROMO_NOT_DRAFT,
          `Promo is ${before.status}; archive it instead of deleting`,
        );
      }
      await tx.promo.delete({ where: { id: promoId } });
      await this.auditAs(tx, actor, 'promo.delete', 'promo', promoId, {
        before,
        after: null,
        reason,
      });
    });
  }

  // ---------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------

  private toDto(row: PromoWithTemplate): Promise<PromoDto> {
    return this.presenter.promoDto(row, this.clock.now());
  }

  private async requirePromo(db: Tx | PrismaService, promoId: string): Promise<PromoWithTemplate> {
    const row = await db.promo.findUnique({ where: { id: promoId }, include: PROMO_INCLUDE });
    if (!row) {
      throw new DomainError(PromosErrors.PC_PROMO_NOT_FOUND, `Promo ${promoId} not found`);
    }
    return row;
  }

  private async requireTemplate(
    db: Tx | PrismaService,
    templateId: string,
  ): Promise<CouponTemplate> {
    const row = await db.couponTemplate.findUnique({ where: { id: templateId } });
    if (!row) {
      throw new DomainError(
        PromosErrors.PC_COUPON_TEMPLATE_NOT_FOUND,
        `Coupon template ${templateId} not found`,
      );
    }
    return row;
  }

  private async assertTemplateFree(
    tx: Tx,
    templateId: string,
    promoId: string | null,
  ): Promise<void> {
    await this.requireTemplate(tx, templateId);
    const linked = await tx.promo.findUnique({ where: { couponTemplateId: templateId } });
    if (linked && linked.id !== promoId) {
      throw new DomainError(
        PromosErrors.PC_COUPON_TEMPLATE_IN_USE,
        `Coupon template is already linked to promo ${linked.id}`,
        { details: { promoId: linked.id } },
      );
    }
  }

  private async assertTenant(tenantId: string | null): Promise<void> {
    if (!tenantId) {
      return;
    }
    const tenant = await this.content.getTenant(tenantId);
    if (!tenant) {
      throw new DomainError(
        PromosErrors.PC_PROMO_TENANT_NOT_FOUND,
        `Tenant ${tenantId} does not exist`,
      );
    }
  }

  private assertWindow(validFrom: Date, validTo: Date): void {
    if (!isValidPromoWindow(validFrom, validTo)) {
      throw new DomainError(
        PromosErrors.PC_PROMO_DATES_INVALID,
        'validFrom must be before validTo',
      );
    }
  }

  private assertTemplateLimits(input: {
    perUserLimit: number;
    totalLimit: number | null;
    validityHoursAfterClaim: number | null;
  }): void {
    if (!isValidCouponLimits(input)) {
      throw new DomainError(
        PromosErrors.PC_COUPON_TEMPLATE_LIMITS_INVALID,
        'perUserLimit, totalLimit and validityHoursAfterClaim must be positive integers (or null)',
      );
    }
  }

  private templateCreateData(
    input: CreateCouponTemplateDto,
    now: Date,
  ): Prisma.CouponTemplateUncheckedCreateInput {
    const data = {
      id: uuidv7(),
      discountText: input.discountText,
      perUserLimit: input.perUserLimit ?? 1,
      totalLimit: input.totalLimit ?? null,
      claimedCount: 0,
      requiresActivation: input.requiresActivation ?? true,
      validityHoursAfterClaim: input.validityHoursAfterClaim ?? null,
      terms: input.terms ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.assertTemplateLimits(data);
    return data;
  }

  private async createPromoRow(
    tx: Tx,
    data: Prisma.PromoUncheckedCreateInput,
  ): Promise<PromoWithTemplate> {
    try {
      return await tx.promo.create({ data, include: PROMO_INCLUDE });
    } catch (error) {
      throw this.translatePromoWriteError(error);
    }
  }

  private translatePromoWriteError(error: unknown): unknown {
    if (isUniqueViolation(error)) {
      return new DomainError(
        PromosErrors.PC_COUPON_TEMPLATE_IN_USE,
        'Coupon template is already linked to another promo',
      );
    }
    if (isForeignKeyViolation(error)) {
      return new DomainError(
        PromosErrors.PC_PROMO_TENANT_NOT_FOUND,
        'Referenced tenant or coupon template does not exist',
      );
    }
    return error;
  }

  /** Audit row in the caller's transaction, so it commits or rolls back with the change. */
  private async auditAs(
    tx: Tx,
    actor: AdminActor,
    action: string,
    entityType: string,
    entityId: string,
    snapshot: { before?: unknown; after?: unknown; reason?: string },
  ): Promise<void> {
    await this.audit.audit(
      {
        actor: { type: 'admin', id: actor.id },
        action,
        entityType,
        entityId,
        before: snapshot.before,
        after: snapshot.after,
        reason: snapshot.reason ?? null,
        ip: actor.ip ?? null,
      },
      tx,
    );
  }
}
