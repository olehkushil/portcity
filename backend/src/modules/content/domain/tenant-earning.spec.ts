import {
  type EffectiveRuleView,
  type TenantEarning,
  type TenantProgramFlags,
  describeTenantEarning,
  needsBaseRate,
} from './tenant-earning';

const participating: TenantProgramFlags = {
  excludedFromProgram: false,
  participates: true,
  status: 'active',
};

const noRule: EffectiveRuleView = {
  ratePercent: null,
  minTotalKopecks: 0,
  dailyCapPoints: null,
  source: 'none',
};

const notEarning: TenantEarning = {
  earnsPoints: false,
  effectiveRatePercent: 0,
  rateSource: 'none',
  minTotalKopecks: 0,
  dailyCapPoints: null,
};

describe('describeTenantEarning', () => {
  const cases: Array<[string, TenantProgramFlags, EffectiveRuleView, number, TenantEarning]> = [
    [
      'participating tenant without rule uses the base rate',
      participating,
      noRule,
      3,
      {
        earnsPoints: true,
        effectiveRatePercent: 3,
        rateSource: 'base',
        minTotalKopecks: 0,
        dailyCapPoints: null,
      },
    ],
    [
      'override wins over the base rate',
      participating,
      { ratePercent: 5, minTotalKopecks: 0, dailyCapPoints: null, source: 'override' },
      3,
      {
        earnsPoints: true,
        effectiveRatePercent: 5,
        rateSource: 'override',
        minTotalKopecks: 0,
        dailyCapPoints: null,
      },
    ],
    [
      'active rule carries minimum and daily cap',
      participating,
      { ratePercent: 10, minTotalKopecks: 20_000, dailyCapPoints: 100, source: 'rule' },
      3,
      {
        earnsPoints: true,
        effectiveRatePercent: 10,
        rateSource: 'rule',
        minTotalKopecks: 20_000,
        dailyCapPoints: 100,
      },
    ],
    [
      'zero-rate rule means no points but keeps the source',
      participating,
      { ratePercent: 0, minTotalKopecks: 0, dailyCapPoints: null, source: 'rule' },
      3,
      {
        earnsPoints: false,
        effectiveRatePercent: 0,
        rateSource: 'rule',
        minTotalKopecks: 0,
        dailyCapPoints: null,
      },
    ],
    [
      'zero base rate means no points',
      participating,
      noRule,
      0,
      {
        earnsPoints: false,
        effectiveRatePercent: 0,
        rateSource: 'base',
        minTotalKopecks: 0,
        dailyCapPoints: null,
      },
    ],
    [
      'excluded tenant (hypermarket) never earns, even with a rule',
      { ...participating, excludedFromProgram: true },
      { ratePercent: 10, minTotalKopecks: 0, dailyCapPoints: null, source: 'rule' },
      3,
      notEarning,
    ],
    [
      'non-participating tenant does not earn',
      { ...participating, participates: false },
      noRule,
      3,
      notEarning,
    ],
    ['closed tenant does not earn', { ...participating, status: 'closed' }, noRule, 3, notEarning],
    [
      'hidden tenant still earns',
      { ...participating, status: 'hidden' },
      noRule,
      3,
      {
        earnsPoints: true,
        effectiveRatePercent: 3,
        rateSource: 'base',
        minTotalKopecks: 0,
        dailyCapPoints: null,
      },
    ],
    [
      'non-finite base rate is treated as zero',
      participating,
      noRule,
      Number.NaN,
      {
        earnsPoints: false,
        effectiveRatePercent: 0,
        rateSource: 'base',
        minTotalKopecks: 0,
        dailyCapPoints: null,
      },
    ],
  ];

  it.each(cases)('%s', (_name, tenant, rule, base, expected) => {
    expect(describeTenantEarning(tenant, rule, base)).toEqual(expected);
  });
});

describe('needsBaseRate', () => {
  it.each<[string, TenantProgramFlags, EffectiveRuleView, boolean]>([
    ['participating without rate', participating, noRule, true],
    [
      'participating with override',
      participating,
      { ...noRule, ratePercent: 4, source: 'override' },
      false,
    ],
    ['excluded tenant', { ...participating, excludedFromProgram: true }, noRule, false],
  ])('%s -> %s', (_name, tenant, rule, expected) => {
    expect(needsBaseRate(tenant, rule)).toBe(expected);
  });
});
