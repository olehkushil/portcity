import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import type { ActiveRuleSet, LoyaltyRules } from '../../../common/contracts/club';
import { DomainError } from '../../../common/errors/domain-error';
import { CommonErrors } from '../../../common/errors/error-codes';
import { isUniqueViolation } from '../../../common/prisma/prisma.errors';
import type { Tx } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { ClubErrors } from '../domain/errors';
import {
  type LoyaltyRulesPatch,
  defaultActiveRuleSet,
  normalizeLoyaltyRules,
  validateLoyaltyRules,
} from '../domain/rules';
import { ClubRepository, type RuleSetRecord } from './club.repository';

export interface RuleSetView {
  id: string;
  version: number;
  activeFrom: Date;
  config: LoyaltyRules;
  note: string | null;
  createdById: string | null;
  createdAt: Date;
  /** True for the single version in force right now. */
  active: boolean;
}

export interface AdminActor {
  adminId: string;
  ip?: string | null;
}

export interface CreateRuleSetInput {
  /** Defaults to the highest existing version + 1. */
  version?: number;
  /** Defaults to now. A future moment schedules the version. */
  activeFrom?: Date;
  /** Partial overrides merged over the rules in force at `activeFrom`. */
  config?: LoyaltyRulesPatch;
  note?: string;
}

export interface UpdateRuleSetInput {
  activeFrom?: Date;
  config?: LoyaltyRulesPatch;
  note?: string | null;
}

const AUDIT_ENTITY = 'loyalty_rule_set';

/**
 * Versioned program configuration (LoyaltyRuleSet). The active version is the newest one whose
 * `activeFrom` has passed; it is cached for a few seconds because every credit reads it.
 * Versions are immutable once active: admins create a new version instead.
 */
@Injectable()
export class RuleSetsService {
  static readonly CACHE_TTL_MS = 30_000;
  /** Clock skew tolerated for `activeFrom` (an admin form sending "now"). */
  static readonly MAX_BACKDATE_MS = 60_000;

  private cache: { set: ActiveRuleSet; validUntilMs: number } | null = null;

  constructor(
    private readonly repo: ClubRepository,
    private readonly clock: Clock,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  /**
   * Rule set active at `at` (default: now, cached); built-in defaults when none is stored.
   * Callers inside a transaction pass `tx`, so a cache miss reads on the same connection
   * instead of borrowing a second one from the pool while holding row locks.
   */
  async getActiveRules(at?: Date, tx?: Tx): Promise<ActiveRuleSet> {
    if (at !== undefined) {
      return this.load(at, tx);
    }
    const nowMs = this.clock.now().getTime();
    if (this.cache && this.cache.validUntilMs > nowMs) {
      return this.cache.set;
    }
    const set = await this.load(new Date(nowMs), tx);
    this.cache = { set, validUntilMs: nowMs + RuleSetsService.CACHE_TTL_MS };
    return set;
  }

  invalidateCache(): void {
    this.cache = null;
  }

  async list(): Promise<RuleSetView[]> {
    const [rows, active] = await Promise.all([this.repo.listRuleSets(), this.getActiveRules()]);
    return rows.map((row) => this.toView(row, active.id));
  }

  async getById(id: string): Promise<RuleSetView> {
    const row = await this.repo.findRuleSetById(id);
    if (!row) {
      throw new DomainError(ClubErrors.PC_RULESET_NOT_FOUND, `Rule set ${id} does not exist`);
    }
    const active = await this.getActiveRules();
    return this.toView(row, active.id);
  }

  async create(input: CreateRuleSetInput, actor: AdminActor): Promise<RuleSetView> {
    const now = this.clock.now();
    try {
      return await this.repo.inTx(undefined, async (tx) => {
        const version = input.version ?? (await this.repo.maxRuleSetVersion(tx)) + 1;
        if (await this.repo.findRuleSetByVersion(version, tx)) {
          throw new DomainError(
            ClubErrors.PC_RULESET_VERSION_TAKEN,
            `Rule set version ${version} already exists`,
            { details: { version } },
          );
        }
        const activeFrom = input.activeFrom ?? now;
        this.assertNotBackdated(activeFrom, now);
        const base = (await this.load(activeFrom, tx)).rules;
        const config = this.resolveConfig(input.config, base);
        const row = await this.repo.insertRuleSet(tx, {
          id: uuidv7(),
          version,
          activeFrom,
          config,
          note: input.note ?? null,
          createdById: actor.adminId,
          createdAt: now,
        });
        const view = this.toView(row, activeFrom.getTime() <= now.getTime() ? row.id : null);
        await this.audit.audit(
          {
            actor: { type: 'admin', id: actor.adminId },
            action: `${AUDIT_ENTITY}.create`,
            entityType: AUDIT_ENTITY,
            entityId: row.id,
            after: view,
            reason: input.note ?? null,
            ip: actor.ip ?? null,
          },
          tx,
        );
        this.invalidateCache();
        return view;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainError(
          ClubErrors.PC_RULESET_VERSION_TAKEN,
          'Rule set version was taken concurrently; retry',
          { cause: error },
        );
      }
      throw error;
    }
  }

  async update(id: string, input: UpdateRuleSetInput, actor: AdminActor): Promise<RuleSetView> {
    const now = this.clock.now();
    return this.repo.inTx(undefined, async (tx) => {
      const row = await this.requireEditable(id, now, tx);
      if (input.activeFrom !== undefined) {
        this.assertNotBackdated(input.activeFrom, now);
      }
      const before = this.toView(row, null);
      const config =
        input.config === undefined
          ? undefined
          : this.resolveConfig(input.config, normalizeLoyaltyRules(row.config));
      const updated = await this.repo.updateRuleSet(tx, id, {
        ...(input.activeFrom !== undefined ? { activeFrom: input.activeFrom } : {}),
        ...(config !== undefined ? { config } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
      const after = this.toView(updated, updated.activeFrom.getTime() <= now.getTime() ? id : null);
      await this.audit.audit(
        {
          actor: { type: 'admin', id: actor.adminId },
          action: `${AUDIT_ENTITY}.update`,
          entityType: AUDIT_ENTITY,
          entityId: id,
          before,
          after,
          reason: input.note ?? null,
          ip: actor.ip ?? null,
        },
        tx,
      );
      this.invalidateCache();
      return after;
    });
  }

  async remove(id: string, actor: AdminActor, reason?: string): Promise<void> {
    const now = this.clock.now();
    await this.repo.inTx(undefined, async (tx) => {
      const row = await this.requireEditable(id, now, tx);
      await this.repo.deleteRuleSet(tx, id);
      await this.audit.audit(
        {
          actor: { type: 'admin', id: actor.adminId },
          action: `${AUDIT_ENTITY}.delete`,
          entityType: AUDIT_ENTITY,
          entityId: id,
          before: this.toView(row, null),
          reason: reason ?? null,
          ip: actor.ip ?? null,
        },
        tx,
      );
      this.invalidateCache();
    });
  }

  private async load(at: Date, tx?: Tx): Promise<ActiveRuleSet> {
    const row = await this.repo.findActiveRuleSet(at, tx);
    if (!row) {
      return defaultActiveRuleSet();
    }
    return {
      id: row.id,
      version: row.version,
      activeFrom: row.activeFrom,
      rules: normalizeLoyaltyRules(row.config),
    };
  }

  private resolveConfig(patch: LoyaltyRulesPatch | undefined, base: LoyaltyRules): LoyaltyRules {
    const config = normalizeLoyaltyRules(patch ?? {}, base);
    const problems = validateLoyaltyRules(config);
    if (problems.length > 0) {
      throw new DomainError(
        CommonErrors.PC_COMMON_VALIDATION,
        'Rule set configuration is invalid',
        {
          details: { problems },
        },
      );
    }
    return config;
  }

  /**
   * A version may start now or later, never in the past: a backdated version would silently
   * rewrite which rules applied to credits that were already made.
   */
  private assertNotBackdated(activeFrom: Date, now: Date): void {
    if (activeFrom.getTime() < now.getTime() - RuleSetsService.MAX_BACKDATE_MS) {
      throw new DomainError(
        CommonErrors.PC_COMMON_VALIDATION,
        'activeFrom must not be in the past',
        {
          details: { activeFrom: activeFrom.toISOString(), now: now.toISOString() },
        },
      );
    }
  }

  /** A version can be edited or deleted only while it is scheduled for the future. */
  private async requireEditable(
    id: string,
    now: Date,
    tx: Parameters<ClubRepository['findRuleSetById']>[1],
  ): Promise<RuleSetRecord> {
    const row = await this.repo.findRuleSetById(id, tx);
    if (!row) {
      throw new DomainError(ClubErrors.PC_RULESET_NOT_FOUND, `Rule set ${id} does not exist`);
    }
    if (row.activeFrom.getTime() <= now.getTime()) {
      throw new DomainError(
        CommonErrors.PC_COMMON_CONFLICT,
        `Rule set version ${row.version} is already in force; create a new version instead`,
        { details: { id, version: row.version, activeFrom: row.activeFrom.toISOString() } },
      );
    }
    return row;
  }

  private toView(row: RuleSetRecord, activeId: string | null): RuleSetView {
    return {
      id: row.id,
      version: row.version,
      activeFrom: row.activeFrom,
      config: normalizeLoyaltyRules(row.config),
      note: row.note,
      createdById: row.createdById,
      createdAt: row.createdAt,
      active: activeId === row.id,
    };
  }
}
