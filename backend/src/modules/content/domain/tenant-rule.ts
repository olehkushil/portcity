import type { EffectiveTenantRule } from '../../../common/contracts/content';
import { DomainError } from '../../../common/errors/domain-error';
import { ContentErrors } from './errors';

/** Half-open validity interval `[validFrom, validTo)`; `validTo === null` means open-ended. */
export interface RulePeriod {
  validFrom: Date;
  validTo: Date | null;
}

export interface TenantRuleCandidate extends RulePeriod {
  id?: string;
  ratePercent: number;
  minTotalKopecks: number;
  dailyCapPoints: number | null;
}

export function isRuleActiveAt(rule: RulePeriod, at: Date): boolean {
  const t = at.getTime();
  return rule.validFrom.getTime() <= t && (rule.validTo === null || t < rule.validTo.getTime());
}

/**
 * The rule that applies at `at`: among active rules the one that started last wins
 * (overlaps are rejected on write, so this is only a tie-breaker for data imported by hand).
 */
export function pickActiveRule<T extends TenantRuleCandidate>(
  rules: readonly T[],
  at: Date,
): T | null {
  let winner: T | null = null;
  for (const rule of rules) {
    if (!isRuleActiveAt(rule, at)) {
      continue;
    }
    if (winner === null || rule.validFrom.getTime() > winner.validFrom.getTime()) {
      winner = rule;
    }
  }
  return winner;
}

export interface ResolveEffectiveRuleInput {
  tenantId: string;
  ratePercentOverride: number | null;
  rules: readonly TenantRuleCandidate[];
  at: Date;
}

/**
 * Contract semantics (ContentPort.getTenantRule): an active TenantLoyaltyRule wins over
 * `Tenant.ratePercentOverride`; with neither, `ratePercent` is null and the consumer falls
 * back to `baseRatePercent` of the active loyalty rule set.
 */
export function resolveEffectiveRule(input: ResolveEffectiveRuleInput): EffectiveTenantRule {
  const rule = pickActiveRule(input.rules, input.at);
  if (rule) {
    return {
      tenantId: input.tenantId,
      ratePercent: rule.ratePercent,
      minTotalKopecks: rule.minTotalKopecks,
      dailyCapPoints: rule.dailyCapPoints,
      source: 'rule',
    };
  }
  if (input.ratePercentOverride !== null) {
    return {
      tenantId: input.tenantId,
      ratePercent: input.ratePercentOverride,
      minTotalKopecks: 0,
      dailyCapPoints: null,
      source: 'override',
    };
  }
  return {
    tenantId: input.tenantId,
    ratePercent: null,
    minTotalKopecks: 0,
    dailyCapPoints: null,
    source: 'none',
  };
}

/** True when two half-open periods share at least one instant. */
export function periodsOverlap(a: RulePeriod, b: RulePeriod): boolean {
  const aEnd = a.validTo === null ? Number.POSITIVE_INFINITY : a.validTo.getTime();
  const bEnd = b.validTo === null ? Number.POSITIVE_INFINITY : b.validTo.getTime();
  return a.validFrom.getTime() < bEnd && b.validFrom.getTime() < aEnd;
}

export function isValidRulePeriod(period: RulePeriod): boolean {
  if (Number.isNaN(period.validFrom.getTime())) {
    return false;
  }
  if (period.validTo === null) {
    return true;
  }
  return (
    !Number.isNaN(period.validTo.getTime()) && period.validTo.getTime() > period.validFrom.getTime()
  );
}

/** ISO string, or null for a missing or invalid date (safe inside error details). */
export function safeIso(date: Date | null | undefined): string | null {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

export function assertValidRulePeriod(period: RulePeriod): void {
  if (!isValidRulePeriod(period)) {
    throw new DomainError(
      ContentErrors.PC_TENANT_RULE_INVALID_PERIOD,
      'validTo must be later than validFrom',
      {
        details: { validFrom: safeIso(period.validFrom), validTo: safeIso(period.validTo) },
      },
    );
  }
}

/** First existing rule (other than `excludeId`) overlapping the candidate, or null. */
export function findOverlappingRule<T extends RulePeriod & { id?: string }>(
  existing: readonly T[],
  candidate: RulePeriod,
  excludeId?: string,
): T | null {
  for (const rule of existing) {
    if (excludeId !== undefined && rule.id === excludeId) {
      continue;
    }
    if (periodsOverlap(rule, candidate)) {
      return rule;
    }
  }
  return null;
}

export function assertNoRuleOverlap<T extends RulePeriod & { id?: string }>(
  existing: readonly T[],
  candidate: RulePeriod,
  excludeId?: string,
): void {
  const overlap = findOverlappingRule(existing, candidate, excludeId);
  if (overlap) {
    throw new DomainError(
      ContentErrors.PC_TENANT_RULE_OVERLAP,
      'The period overlaps an existing loyalty rule of this tenant',
      {
        details: {
          overlappingRuleId: overlap.id ?? null,
          validFrom: safeIso(overlap.validFrom),
          validTo: safeIso(overlap.validTo),
        },
      },
    );
  }
}
