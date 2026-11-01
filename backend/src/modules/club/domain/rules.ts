import {
  type ActiveRuleSet,
  DEFAULT_LOYALTY_RULES,
  type LoyaltyRules,
  type WelcomeBonuses,
} from '../../../common/contracts/club';

/** Id reported by `getActiveRules()` when no rule set row exists yet (built-in defaults). */
export const DEFAULT_RULE_SET_ID = '00000000-0000-0000-0000-000000000000';

/** Fields of LoyaltyRules that are plain numbers (everything except `welcome` and the array). */
export const NUMERIC_RULE_KEYS = [
  'baseRatePercent',
  'maxPointsPerReceipt',
  'minReceiptTotalKopecks',
  'dailyReceiptLimit',
  'autoApproveThresholdKopecks',
  'holdThresholdKopecks',
  'holdDays',
  'uploadWindowDays',
  'pointsTtlMonths',
  'newcomerLockHours',
  'pointValueKopecks',
] as const;
export type NumericRuleKey = (typeof NUMERIC_RULE_KEYS)[number];

export const WELCOME_KEYS = ['register', 'profile', 'firstReceipt'] as const;

export type LoyaltyRulesPatch = Partial<Omit<LoyaltyRules, 'welcome'>> & {
  welcome?: Partial<WelcomeBonuses>;
};

/** Rules exposed by `GET /club/rules`: everything except the anti-fraud auto-approve threshold. */
export type PublicLoyaltyRules = Omit<LoyaltyRules, 'autoApproveThresholdKopecks'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Merges an untrusted/partial config (a jsonb column or an admin patch) over `base`.
 * Unknown keys are dropped, malformed values fall back to the base value, so a damaged row can
 * never break crediting. Validation of the merged result is `validateLoyaltyRules()`.
 */
export function normalizeLoyaltyRules(
  input: unknown,
  base: LoyaltyRules = DEFAULT_LOYALTY_RULES,
): LoyaltyRules {
  const source = isRecord(input) ? input : {};
  const result: LoyaltyRules = {
    ...base,
    welcome: { ...base.welcome },
    expiryReminderDays: [...base.expiryReminderDays],
  };
  for (const key of NUMERIC_RULE_KEYS) {
    const value = finiteNumber(source[key]);
    if (value !== undefined) {
      result[key] = value;
    }
  }
  if (isRecord(source.welcome)) {
    for (const key of WELCOME_KEYS) {
      const value = finiteNumber(source.welcome[key]);
      if (value !== undefined) {
        result.welcome[key] = value;
      }
    }
  }
  if (Array.isArray(source.expiryReminderDays)) {
    const days = source.expiryReminderDays
      .map(finiteNumber)
      .filter((day): day is number => day !== undefined && Number.isInteger(day) && day >= 0);
    result.expiryReminderDays = [...new Set(days)].sort((a, b) => b - a);
  }
  return result;
}

function checkInt(
  problems: string[],
  name: string,
  value: number,
  min: number,
  max?: number,
): void {
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    problems.push(
      `${name} must be an integer${max === undefined ? ` >= ${min}` : ` between ${min} and ${max}`}`,
    );
  }
}

/** Business validation of a full rule set; returns human-readable problems (empty when valid). */
export function validateLoyaltyRules(rules: LoyaltyRules): string[] {
  const problems: string[] = [];
  if (
    !Number.isFinite(rules.baseRatePercent) ||
    rules.baseRatePercent < 0 ||
    rules.baseRatePercent > 100
  ) {
    problems.push('baseRatePercent must be between 0 and 100');
  }
  checkInt(problems, 'maxPointsPerReceipt', rules.maxPointsPerReceipt, 1);
  checkInt(problems, 'minReceiptTotalKopecks', rules.minReceiptTotalKopecks, 0);
  checkInt(problems, 'dailyReceiptLimit', rules.dailyReceiptLimit, 1);
  checkInt(problems, 'autoApproveThresholdKopecks', rules.autoApproveThresholdKopecks, 0);
  checkInt(problems, 'holdThresholdKopecks', rules.holdThresholdKopecks, 0);
  checkInt(problems, 'holdDays', rules.holdDays, 0, 365);
  checkInt(problems, 'uploadWindowDays', rules.uploadWindowDays, 1, 365);
  checkInt(problems, 'pointsTtlMonths', rules.pointsTtlMonths, 1, 120);
  checkInt(problems, 'newcomerLockHours', rules.newcomerLockHours, 0, 24 * 365);
  checkInt(problems, 'pointValueKopecks', rules.pointValueKopecks, 1);
  for (const key of WELCOME_KEYS) {
    checkInt(problems, `welcome.${key}`, rules.welcome[key], 0);
  }
  if (!Array.isArray(rules.expiryReminderDays) || rules.expiryReminderDays.length > 10) {
    problems.push('expiryReminderDays must be an array of at most 10 days');
  } else {
    const maxDays = rules.pointsTtlMonths * 28;
    for (const day of rules.expiryReminderDays) {
      if (!Number.isInteger(day) || day < 0 || day >= maxDays) {
        problems.push(`expiryReminderDays entries must be integers between 0 and ${maxDays - 1}`);
        break;
      }
    }
  }
  return problems;
}

export function publicRulesView(rules: LoyaltyRules): PublicLoyaltyRules {
  const { autoApproveThresholdKopecks: _hidden, ...rest } = rules;
  return {
    ...rest,
    welcome: { ...rules.welcome },
    expiryReminderDays: [...rules.expiryReminderDays],
  };
}

export function defaultActiveRuleSet(): ActiveRuleSet {
  return {
    id: DEFAULT_RULE_SET_ID,
    version: 0,
    activeFrom: new Date(0),
    rules: normalizeLoyaltyRules({}),
  };
}

/** Moment until which a new member cannot spend; null when the lock is disabled. */
export function newcomerLockUntil(
  registeredAt: Date,
  rules: Pick<LoyaltyRules, 'newcomerLockHours'>,
): Date | null {
  if (!Number.isFinite(rules.newcomerLockHours) || rules.newcomerLockHours <= 0) {
    return null;
  }
  return new Date(registeredAt.getTime() + rules.newcomerLockHours * 3_600_000);
}
