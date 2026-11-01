import type { EffectiveTenantRule, TenantStatus } from '../../../common/contracts/content';
import { isTenantExcludedFromProgram } from './tenant-state';

/**
 * Where the effective rate of a tenant comes from:
 *   rule      an active TenantLoyaltyRule
 *   override  Tenant.ratePercentOverride
 *   base      baseRatePercent of the active loyalty rule set (club)
 *   none      the tenant does not take part in the program (excluded, not participating, closed)
 */
export const TENANT_RATE_SOURCES = ['rule', 'override', 'base', 'none'] as const;
export type TenantRateSource = (typeof TENANT_RATE_SOURCES)[number];

/** What the app shows on a tenant card: the "нараховує бали" badge and the rate. */
export interface TenantEarning {
  /** Receipts from this tenant earn points right now. */
  earnsPoints: boolean;
  /** Percent of the receipt total credited as points (points per 100 UAH); 0 when not earning. */
  effectiveRatePercent: number;
  rateSource: TenantRateSource;
  /** Receipts below this total earn nothing (0 = no minimum). */
  minTotalKopecks: number;
  /** Max points per member per Kyiv day from this tenant; null = no tenant-specific cap. */
  dailyCapPoints: number | null;
}

export interface TenantProgramFlags {
  excludedFromProgram: boolean;
  participates: boolean;
  status: TenantStatus;
}

export type EffectiveRuleView = Pick<
  EffectiveTenantRule,
  'ratePercent' | 'minTotalKopecks' | 'dailyCapPoints' | 'source'
>;

const NOT_EARNING: Readonly<TenantEarning> = Object.freeze({
  earnsPoints: false,
  effectiveRatePercent: 0,
  rateSource: 'none',
  minTotalKopecks: 0,
  dailyCapPoints: null,
});

/**
 * Combines the program flags of the tenant, its effective rule (ContentPort.getTenantRule
 * semantics) and the base rate of the active rule set. A tenant whose effective rate is 0
 * (for example a 0 % promotional rule) does not earn points, but keeps the source so the
 * back office can see why.
 */
export function describeTenantEarning(
  tenant: TenantProgramFlags,
  rule: EffectiveRuleView,
  baseRatePercent: number,
): TenantEarning {
  if (isTenantExcludedFromProgram(tenant)) {
    return { ...NOT_EARNING };
  }
  const rateSource: TenantRateSource = rule.source === 'none' ? 'base' : rule.source;
  const rate = rule.ratePercent ?? baseRatePercent;
  const effectiveRatePercent = Number.isFinite(rate) && rate > 0 ? rate : 0;
  return {
    earnsPoints: effectiveRatePercent > 0,
    effectiveRatePercent,
    rateSource,
    minTotalKopecks: rule.minTotalKopecks,
    dailyCapPoints: rule.dailyCapPoints,
  };
}

/** True when the base rate of the rule set is needed to describe the tenant. */
export function needsBaseRate(tenant: TenantProgramFlags, rule: EffectiveRuleView): boolean {
  return !isTenantExcludedFromProgram(tenant) && rule.ratePercent === null;
}
