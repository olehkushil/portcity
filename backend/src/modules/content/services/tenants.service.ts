import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type Tenant } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import type { TenantStatus } from '../../../common/contracts/content';
import {
  CONTENT_EVENTS,
  OUTBOX_AGGREGATES,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import { DomainError } from '../../../common/errors/domain-error';
import { CommonErrors } from '../../../common/errors/error-codes';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { isUniqueViolation } from '../../../common/prisma/prisma.errors';
import { type DbClient, PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { ContentErrors } from '../domain/errors';
import { isValidSlug, slugify } from '../domain/slug';
import { parseTenantHours } from '../domain/tenant-hours';
import { assertTenantTransition, isTenantPublic } from '../domain/tenant-state';
import type { CreateTenantDto, UpdateTenantDto } from '../dto/tenant.dto';
import type { TenantWithCounts } from './mappers';
import { type AdminActor, isNameIdCursor, pick } from './types';

/** Columns an admin may change; also the audit snapshot. */
export const TENANT_FIELDS = [
  'slug',
  'name',
  'category',
  'floor',
  'logoKey',
  'website',
  'phone',
  'description',
  'participates',
  'ratePercentOverride',
  'excludedFromProgram',
  'status',
  'hours',
  'locationText',
  'mapImageUrl',
] as const;
export type TenantField = (typeof TENANT_FIELDS)[number];

/**
 * Validates and normalises the hours object of a create/update request; null clears it.
 * Throws PC_COMMON_VALIDATION (400) with `details.field = hours` and the problem.
 */
export function normalizeTenantHoursInput(
  value: Record<string, unknown> | null,
): Prisma.InputJsonObject | null {
  if (value === null) {
    return null;
  }
  const parsed = parseTenantHours(value);
  if (!parsed.ok) {
    throw new DomainError(CommonErrors.PC_COMMON_VALIDATION, `Invalid hours: ${parsed.problem}`, {
      details: { field: 'hours', problem: parsed.problem },
    });
  }
  return parsed.hours as Prisma.InputJsonObject;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

const COUNT_INCLUDE = {
  _count: { select: { fiscalNumbers: true, loyaltyRules: true } },
} satisfies Prisma.TenantInclude;

export interface TenantListFilter {
  status?: TenantStatus;
  participates?: boolean;
  category?: string;
  floor?: number;
  q?: string;
  cursor?: string;
  limit: number;
}

export interface CategoryCount {
  category: string;
  count: number;
}

/**
 * Tenant directory: public reads (active tenants only) and audited back-office writes.
 * Sorting is `(name, id)` with an opaque `{ name, id }` cursor.
 */
@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  /** GET /tenants: only active tenants, optional participation/category/floor/text filters. */
  listPublic(filter: Omit<TenantListFilter, 'status'>): Promise<Page<TenantWithCounts>> {
    return this.list({ ...filter, status: 'active' });
  }

  async list(filter: TenantListFilter): Promise<Page<TenantWithCounts>> {
    const cursor = decodeCursor(filter.cursor, isNameIdCursor);
    const conditions: Prisma.TenantWhereInput[] = [];
    if (filter.status !== undefined) {
      conditions.push({ status: filter.status });
    }
    if (filter.participates !== undefined) {
      conditions.push({ participates: filter.participates });
    }
    if (filter.category !== undefined) {
      conditions.push({ category: filter.category });
    }
    if (filter.floor !== undefined) {
      conditions.push({ floor: filter.floor });
    }
    const q = filter.q?.trim();
    if (q) {
      const bySlug = slugify(q);
      conditions.push({
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          ...(bySlug ? [{ slug: { contains: bySlug } }] : []),
        ],
      });
    }
    if (cursor) {
      conditions.push({
        OR: [{ name: { gt: cursor.name } }, { name: cursor.name, id: { gt: cursor.id } }],
      });
    }
    const rows = await this.prisma.tenant.findMany({
      where: { AND: conditions },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: filter.limit + 1,
      include: COUNT_INCLUDE,
    });
    return toPage(rows, filter.limit, (last) => ({ name: last.name, id: last.id }));
  }

  /** Active tenants grouped by category (filter chips in the app). */
  async categoriesSummary(): Promise<CategoryCount[]> {
    const groups = await this.prisma.tenant.groupBy({
      by: ['category'],
      where: { status: 'active' },
      _count: { _all: true },
      orderBy: { category: 'asc' },
    });
    return groups.map((group) => ({ category: group.category, count: group._count._all }));
  }

  /** GET /tenants/:slug: hidden and closed tenants answer 404. */
  async getPublicBySlug(slug: string): Promise<TenantWithCounts> {
    const row = await this.prisma.tenant.findUnique({ where: { slug }, include: COUNT_INCLUDE });
    if (!row || !isTenantPublic(row.status)) {
      throw this.notFound({ slug });
    }
    return row;
  }

  /** GET /tenants/by-id/:id (links from vouchers, promos, receipts): same visibility as by slug. */
  async getPublicById(id: string): Promise<TenantWithCounts> {
    const row = await this.findById(id);
    if (!row || !isTenantPublic(row.status)) {
      throw this.notFound({ id });
    }
    return row;
  }

  findById(id: string, db: DbClient = this.prisma): Promise<TenantWithCounts | null> {
    return db.tenant.findUnique({ where: { id }, include: COUNT_INCLUDE });
  }

  async getById(id: string, db: DbClient = this.prisma): Promise<TenantWithCounts> {
    const row = await this.findById(id, db);
    if (!row) {
      throw this.notFound({ id });
    }
    return row;
  }

  findByIds(ids: readonly string[]): Promise<Tenant[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.tenant.findMany({ where: { id: { in: [...new Set(ids)] } } });
  }

  async create(input: CreateTenantDto, actor: AdminActor): Promise<TenantWithCounts> {
    const slug = input.slug ?? slugify(input.name);
    if (!isValidSlug(slug)) {
      throw new DomainError(
        CommonErrors.PC_COMMON_VALIDATION,
        'Cannot derive a slug from the name; provide "slug" explicitly',
        { details: { name: input.name } },
      );
    }
    const now = this.clock.now();
    const hours = normalizeTenantHoursInput(input.hours ?? null);
    return this.prisma.withTx(async (tx) => {
      await this.assertSlugFree(tx, slug);
      let row: Tenant;
      try {
        row = await tx.tenant.create({
          data: {
            id: uuidv7(),
            slug,
            name: input.name,
            category: input.category,
            floor: input.floor ?? null,
            logoKey: input.logoKey ?? null,
            website: input.website ?? null,
            phone: input.phone ?? null,
            description: input.description ?? null,
            participates: input.participates ?? true,
            ratePercentOverride: input.ratePercentOverride ?? null,
            excludedFromProgram: input.excludedFromProgram ?? false,
            status: input.status ?? 'active',
            hours: hours ?? Prisma.DbNull,
            locationText: input.locationText ?? null,
            mapImageUrl: input.mapImageUrl ?? null,
            createdAt: now,
            updatedAt: now,
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw this.slugTaken(slug, error);
        }
        throw error;
      }
      await this.audit.audit(
        {
          actor: { type: 'admin', id: actor.id },
          action: 'tenant.create',
          entityType: 'tenant',
          entityId: row.id,
          after: pick(row, TENANT_FIELDS),
          ip: actor.ip ?? null,
        },
        tx,
      );
      return { ...row, _count: { fiscalNumbers: 0, loyaltyRules: 0 } };
    });
  }

  /**
   * Partial update. Only fields that actually change are written, audited and reported in
   * the `tenant.updated` event; a status change must follow the tenant state machine.
   * A slug change is allowed (old deep links stop working; the app re-reads the list).
   */
  update(id: string, patch: UpdateTenantDto, actor: AdminActor): Promise<TenantWithCounts> {
    return this.applyPatch(id, patch, actor, 'tenant.update');
  }

  /**
   * DELETE /admin/tenants/:id is a soft delete: the tenant becomes `closed` (receipts,
   * rewards, vouchers and validator devices keep referencing it). Closed tenants disappear
   * from public endpoints and stop earning points (isTenantExcludedFromProgram). Idempotent.
   */
  close(id: string, actor: AdminActor): Promise<TenantWithCounts> {
    return this.applyPatch(id, { status: 'closed' }, actor, 'tenant.close');
  }

  private async applyPatch(
    id: string,
    patch: UpdateTenantDto,
    actor: AdminActor,
    action: 'tenant.update' | 'tenant.close',
  ): Promise<TenantWithCounts> {
    const now = this.clock.now();
    const normalized: Partial<Record<TenantField, unknown>> = { ...patch };
    if (patch.hours !== undefined) {
      normalized.hours = normalizeTenantHoursInput(patch.hours);
    }
    return this.prisma.withTx(async (tx) => {
      const current = await tx.tenant.findUnique({ where: { id }, include: COUNT_INCLUDE });
      if (!current) {
        throw this.notFound({ id });
      }
      const data: Record<string, unknown> = {};
      const changed: TenantField[] = [];
      for (const field of TENANT_FIELDS) {
        const next = normalized[field];
        if (next === undefined || sameValue(next, current[field])) {
          continue;
        }
        // A JSON column is cleared with DbNull, not with a plain null.
        data[field] = field === 'hours' && next === null ? Prisma.DbNull : next;
        changed.push(field);
      }
      if (changed.length === 0) {
        return current;
      }
      if (patch.status !== undefined && changed.includes('status')) {
        assertTenantTransition(current.status, patch.status);
      }
      if (patch.slug !== undefined && changed.includes('slug')) {
        await this.assertSlugFree(tx, patch.slug, id);
      }
      let row: TenantWithCounts;
      try {
        row = await tx.tenant.update({
          where: { id },
          data: { ...(data as Prisma.TenantUncheckedUpdateInput), updatedAt: now },
          include: COUNT_INCLUDE,
        });
      } catch (error) {
        if (isUniqueViolation(error) && patch.slug !== undefined && changed.includes('slug')) {
          throw this.slugTaken(patch.slug, error);
        }
        throw error;
      }
      await this.audit.audit(
        {
          actor: { type: 'admin', id: actor.id },
          action,
          entityType: 'tenant',
          entityId: id,
          before: pick(current, changed),
          after: pick(row, changed),
          ip: actor.ip ?? null,
        },
        tx,
      );
      await this.outbox.publish(
        tx,
        buildOutboxEvent(CONTENT_EVENTS.tenantUpdated, OUTBOX_AGGREGATES.tenant, id, {
          tenantId: id,
          slug: row.slug,
          changedFields: [...changed],
        }),
      );
      return row;
    });
  }

  private async assertSlugFree(db: DbClient, slug: string, exceptId?: string): Promise<void> {
    const existing = await db.tenant.findUnique({ where: { slug }, select: { id: true } });
    if (existing && existing.id !== exceptId) {
      throw this.slugTaken(slug);
    }
  }

  private slugTaken(slug: string, cause?: unknown): DomainError {
    return new DomainError(ContentErrors.PC_TENANT_SLUG_TAKEN, `Slug "${slug}" is already used`, {
      details: { slug },
      cause,
    });
  }

  private notFound(details: Record<string, string>): DomainError {
    return new DomainError(ContentErrors.PC_TENANT_NOT_FOUND, 'Tenant not found', { details });
  }
}
