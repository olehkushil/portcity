import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, TenantLoyaltyRule } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import type { EffectiveTenantRule } from '../../../common/contracts/content';
import {
  CONTENT_EVENTS,
  OUTBOX_AGGREGATES,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import { DomainError } from '../../../common/errors/domain-error';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { type DbClient, PrismaService, type Tx } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { ContentErrors } from '../domain/errors';
import {
  type RulePeriod,
  assertNoRuleOverlap,
  assertValidRulePeriod,
  resolveEffectiveRule,
} from '../domain/tenant-rule';
import type { CreateTenantRuleDto, UpdateTenantRuleDto } from '../dto/tenant-rule.dto';
import { type AdminActor, isIdCursor, pick } from './types';

const RULE_FIELDS = [
  'ratePercent',
  'minTotalKopecks',
  'dailyCapPoints',
  'validFrom',
  'validTo',
] as const;
type RuleField = (typeof RULE_FIELDS)[number];

export interface TenantRuleListFilter {
  tenantId?: string;
  /** Only rules whose period contains this instant. */
  activeAt?: Date;
  cursor?: string;
  limit: number;
}

/** Exclusion constraint added by the module_requests migration (content-1). */
export const RULE_OVERLAP_CONSTRAINT = 'tenant_loyalty_rules_no_overlap';

/**
 * True for a violation of `tenant_loyalty_rules_no_overlap` (SQLSTATE 23P01). Prisma has no
 * dedicated code for exclusion violations: it surfaces them as an unknown request error or a
 * P2004 known error whose message or meta names the constraint or the SQLSTATE.
 */
export function isRuleOverlapViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { message?: unknown; meta?: unknown };
  let text = typeof candidate.message === 'string' ? candidate.message : '';
  if (candidate.meta !== undefined) {
    try {
      text += ` ${JSON.stringify(candidate.meta)}`;
    } catch {
      // meta is diagnostic only
    }
  }
  return text.includes(RULE_OVERLAP_CONSTRAINT) || text.includes('23P01');
}

/**
 * Time-bound per-tenant overrides of the loyalty rules. Writes serialise on the tenant row
 * (`SELECT ... FOR UPDATE`) so two concurrent creates cannot both pass the overlap check; the
 * database exclusion constraint backs the check for writes that bypass this service.
 */
@Injectable()
export class TenantRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  async listForTenant(tenantId: string): Promise<TenantLoyaltyRule[]> {
    await this.assertTenantExists(this.prisma, tenantId);
    return this.prisma.tenantLoyaltyRule.findMany({
      where: { tenantId },
      orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
    });
  }

  /** ContentPort.getTenantRule: active rule > ratePercentOverride > none. */
  async getEffectiveRule(tenantId: string, at: Date): Promise<EffectiveTenantRule> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, ratePercentOverride: true },
    });
    if (!tenant) {
      throw this.tenantNotFound(tenantId);
    }
    const rules = await this.prisma.tenantLoyaltyRule.findMany({
      where: { tenantId, ...activeAtWhere(at) },
    });
    return resolveEffectiveRule({
      tenantId,
      ratePercentOverride: tenant.ratePercentOverride,
      rules,
      at,
    });
  }

  /**
   * Effective rules of several already loaded tenants at `at` with one query (tenant
   * directory pages). Every tenant gets an entry.
   */
  async getEffectiveRules(
    tenants: ReadonlyArray<{ id: string; ratePercentOverride: number | null }>,
    at: Date,
  ): Promise<Map<string, EffectiveTenantRule>> {
    const result = new Map<string, EffectiveTenantRule>();
    if (tenants.length === 0) {
      return result;
    }
    const ids = [...new Set(tenants.map((tenant) => tenant.id))];
    const rules = await this.prisma.tenantLoyaltyRule.findMany({
      where: { tenantId: { in: ids }, ...activeAtWhere(at) },
    });
    const byTenant = new Map<string, TenantLoyaltyRule[]>();
    for (const rule of rules) {
      const list = byTenant.get(rule.tenantId) ?? [];
      list.push(rule);
      byTenant.set(rule.tenantId, list);
    }
    for (const tenant of tenants) {
      result.set(
        tenant.id,
        resolveEffectiveRule({
          tenantId: tenant.id,
          ratePercentOverride: tenant.ratePercentOverride,
          rules: byTenant.get(tenant.id) ?? [],
          at,
        }),
      );
    }
    return result;
  }

  /** Admin list across tenants, newest first (`id desc`), cursor `{ id }`. */
  async list(filter: TenantRuleListFilter): Promise<Page<TenantLoyaltyRule>> {
    const cursor = decodeCursor(filter.cursor, isIdCursor);
    const where: Prisma.TenantLoyaltyRuleWhereInput = {
      ...(filter.tenantId !== undefined ? { tenantId: filter.tenantId } : {}),
      ...(filter.activeAt !== undefined ? activeAtWhere(filter.activeAt) : {}),
      ...(cursor ? { id: { lt: cursor.id } } : {}),
    };
    const rows = await this.prisma.tenantLoyaltyRule.findMany({
      where,
      orderBy: { id: 'desc' },
      take: filter.limit + 1,
    });
    return toPage(rows, filter.limit, (last) => ({ id: last.id }));
  }

  async getById(ruleId: string): Promise<TenantLoyaltyRule> {
    const rule = await this.prisma.tenantLoyaltyRule.findUnique({ where: { id: ruleId } });
    if (!rule) {
      throw this.ruleNotFound({ ruleId });
    }
    return rule;
  }

  /** PATCH /admin/tenant-rules/:id (the tenant of a rule never changes). */
  async updateById(
    ruleId: string,
    patch: UpdateTenantRuleDto,
    actor: AdminActor,
  ): Promise<TenantLoyaltyRule> {
    const rule = await this.getById(ruleId);
    return this.update(rule.tenantId, ruleId, patch, actor);
  }

  /** DELETE /admin/tenant-rules/:id. */
  async removeById(ruleId: string, actor: AdminActor): Promise<void> {
    const rule = await this.getById(ruleId);
    await this.remove(rule.tenantId, ruleId, actor);
  }

  async create(
    tenantId: string,
    input: CreateTenantRuleDto,
    actor: AdminActor,
  ): Promise<TenantLoyaltyRule> {
    const period: RulePeriod = {
      validFrom: new Date(input.validFrom),
      validTo: input.validTo ? new Date(input.validTo) : null,
    };
    assertValidRulePeriod(period);
    const now = this.clock.now();
    return this.withOverlapGuard(async (tx) => {
      const slug = await this.lockTenant(tx, tenantId);
      const existing = await tx.tenantLoyaltyRule.findMany({ where: { tenantId } });
      assertNoRuleOverlap(existing, period);
      const row = await tx.tenantLoyaltyRule.create({
        data: {
          id: uuidv7(),
          tenantId,
          ratePercent: input.ratePercent,
          minTotalKopecks: input.minTotalKopecks ?? 0,
          dailyCapPoints: input.dailyCapPoints ?? null,
          validFrom: period.validFrom,
          validTo: period.validTo,
          createdAt: now,
        },
      });
      await this.audit.audit(
        {
          actor: { type: 'admin', id: actor.id },
          action: 'tenant_rule.create',
          entityType: 'tenant_loyalty_rule',
          entityId: row.id,
          after: { tenantId, ...pick(row, RULE_FIELDS) },
          ip: actor.ip ?? null,
        },
        tx,
      );
      await this.publishRulesChanged(tx, tenantId, slug);
      return row;
    });
  }

  async update(
    tenantId: string,
    ruleId: string,
    patch: UpdateTenantRuleDto,
    actor: AdminActor,
  ): Promise<TenantLoyaltyRule> {
    return this.withOverlapGuard(async (tx) => {
      const slug = await this.lockTenant(tx, tenantId);
      const current = await this.getRule(tx, tenantId, ruleId);
      const period: RulePeriod = {
        validFrom: patch.validFrom !== undefined ? new Date(patch.validFrom) : current.validFrom,
        validTo:
          patch.validTo === undefined
            ? current.validTo
            : patch.validTo === null
              ? null
              : new Date(patch.validTo),
      };
      assertValidRulePeriod(period);
      const next: Pick<TenantLoyaltyRule, RuleField> = {
        ratePercent: patch.ratePercent ?? current.ratePercent,
        minTotalKopecks: patch.minTotalKopecks ?? current.minTotalKopecks,
        dailyCapPoints:
          patch.dailyCapPoints === undefined ? current.dailyCapPoints : patch.dailyCapPoints,
        validFrom: period.validFrom,
        validTo: period.validTo,
      };
      const changed = RULE_FIELDS.filter((field) => !sameValue(next[field], current[field]));
      if (changed.length === 0) {
        return current;
      }
      const existing = await tx.tenantLoyaltyRule.findMany({ where: { tenantId } });
      assertNoRuleOverlap(existing, period, ruleId);
      const row = await tx.tenantLoyaltyRule.update({ where: { id: ruleId }, data: next });
      await this.audit.audit(
        {
          actor: { type: 'admin', id: actor.id },
          action: 'tenant_rule.update',
          entityType: 'tenant_loyalty_rule',
          entityId: ruleId,
          before: pick(current, changed),
          after: pick(row, changed),
          ip: actor.ip ?? null,
        },
        tx,
      );
      await this.publishRulesChanged(tx, tenantId, slug);
      return row;
    });
  }

  /** Runs a rule write in a transaction and maps the exclusion violation to PC_TENANT_RULE_OVERLAP. */
  private async withOverlapGuard<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.withTx(fn);
    } catch (error) {
      if (!DomainError.is(error) && isRuleOverlapViolation(error)) {
        throw new DomainError(
          ContentErrors.PC_TENANT_RULE_OVERLAP,
          'The rule period overlaps another rule of the tenant',
          { details: { constraint: RULE_OVERLAP_CONSTRAINT }, cause: error },
        );
      }
      throw error;
    }
  }

  async remove(tenantId: string, ruleId: string, actor: AdminActor): Promise<void> {
    await this.prisma.withTx(async (tx) => {
      const slug = await this.lockTenant(tx, tenantId);
      const current = await this.getRule(tx, tenantId, ruleId);
      await tx.tenantLoyaltyRule.delete({ where: { id: ruleId } });
      await this.audit.audit(
        {
          actor: { type: 'admin', id: actor.id },
          action: 'tenant_rule.delete',
          entityType: 'tenant_loyalty_rule',
          entityId: ruleId,
          before: { tenantId, ...pick(current, RULE_FIELDS) },
          ip: actor.ip ?? null,
        },
        tx,
      );
      await this.publishRulesChanged(tx, tenantId, slug);
    });
  }

  private async getRule(
    db: DbClient,
    tenantId: string,
    ruleId: string,
  ): Promise<TenantLoyaltyRule> {
    const rule = await db.tenantLoyaltyRule.findFirst({ where: { id: ruleId, tenantId } });
    if (!rule) {
      throw this.ruleNotFound({ tenantId, ruleId });
    }
    return rule;
  }

  /** Row lock on the tenant; doubles as the existence check. Returns the tenant slug. */
  private async lockTenant(tx: Tx, tenantId: string): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ id: string; slug: string }>>`
      SELECT id, slug FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) {
      throw this.tenantNotFound(tenantId);
    }
    return row.slug;
  }

  private async assertTenantExists(db: DbClient, tenantId: string): Promise<void> {
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) {
      throw this.tenantNotFound(tenantId);
    }
  }

  private publishRulesChanged(tx: Tx, tenantId: string, slug: string): Promise<string> {
    return this.outbox.publish(
      tx,
      buildOutboxEvent(CONTENT_EVENTS.tenantUpdated, OUTBOX_AGGREGATES.tenant, tenantId, {
        tenantId,
        slug,
        changedFields: ['loyaltyRules'],
      }),
    );
  }

  private tenantNotFound(tenantId: string): DomainError {
    return new DomainError(ContentErrors.PC_TENANT_NOT_FOUND, 'Tenant not found', {
      details: { id: tenantId },
    });
  }

  private ruleNotFound(details: Record<string, string>): DomainError {
    return new DomainError(
      ContentErrors.PC_TENANT_RULE_NOT_FOUND,
      'Tenant loyalty rule not found',
      {
        details,
      },
    );
  }
}

/** Half-open validity `[validFrom, validTo)` containing `at`. */
function activeAtWhere(at: Date): Prisma.TenantLoyaltyRuleWhereInput {
  return { validFrom: { lte: at }, OR: [{ validTo: null }, { validTo: { gt: at } }] };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return a === b;
}
