import {
  assertNoRuleOverlap,
  assertValidRulePeriod,
  findOverlappingRule,
  isRuleActiveAt,
  isValidRulePeriod,
  periodsOverlap,
  pickActiveRule,
  resolveEffectiveRule,
  type TenantRuleCandidate,
} from './tenant-rule';

const d = (iso: string): Date => new Date(iso);
const tenantId = '0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11';

const rule = (
  id: string,
  from: string,
  to: string | null,
  extra: Partial<TenantRuleCandidate> = {},
): TenantRuleCandidate => ({
  id,
  validFrom: d(from),
  validTo: to === null ? null : d(to),
  ratePercent: 5,
  minTotalKopecks: 0,
  dailyCapPoints: null,
  ...extra,
});

describe('isRuleActiveAt', () => {
  const r = rule('r1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');
  it.each([
    ['2025-12-31T23:59:59Z', false],
    ['2026-01-01T00:00:00Z', true],
    ['2026-01-15T12:00:00Z', true],
    ['2026-01-31T23:59:59.999Z', true],
    ['2026-02-01T00:00:00Z', false],
  ])('at %s -> %s (half-open end)', (at, expected) => {
    expect(isRuleActiveAt(r, d(at))).toBe(expected);
  });

  it('open-ended rules stay active forever', () => {
    expect(isRuleActiveAt(rule('r', '2026-01-01T00:00:00Z', null), d('2099-01-01T00:00:00Z'))).toBe(
      true,
    );
  });
});

describe('pickActiveRule', () => {
  it('returns null when nothing is active', () => {
    expect(
      pickActiveRule([rule('r1', '2026-03-01T00:00:00Z', null)], d('2026-02-01T00:00:00Z')),
    ).toBe(null);
  });

  it('prefers the rule that started last when two overlap', () => {
    const older = rule('old', '2026-01-01T00:00:00Z', null, { ratePercent: 3 });
    const newer = rule('new', '2026-01-10T00:00:00Z', null, { ratePercent: 7 });
    expect(pickActiveRule([older, newer], d('2026-01-20T00:00:00Z'))?.id).toBe('new');
    expect(pickActiveRule([newer, older], d('2026-01-20T00:00:00Z'))?.id).toBe('new');
    expect(pickActiveRule([older, newer], d('2026-01-05T00:00:00Z'))?.id).toBe('old');
  });
});

describe('resolveEffectiveRule', () => {
  const at = d('2026-01-15T10:00:00Z');
  const cases = [
    {
      name: 'rule wins over override',
      input: {
        tenantId,
        ratePercentOverride: 10,
        rules: [
          rule('r1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', {
            ratePercent: 5,
            minTotalKopecks: 10_000,
            dailyCapPoints: 200,
          }),
        ],
        at,
      },
      expected: {
        tenantId,
        ratePercent: 5,
        minTotalKopecks: 10_000,
        dailyCapPoints: 200,
        source: 'rule',
      },
    },
    {
      name: 'expired rule falls back to override',
      input: {
        tenantId,
        ratePercentOverride: 10,
        rules: [rule('r1', '2025-01-01T00:00:00Z', '2025-02-01T00:00:00Z')],
        at,
      },
      expected: {
        tenantId,
        ratePercent: 10,
        minTotalKopecks: 0,
        dailyCapPoints: null,
        source: 'override',
      },
    },
    {
      name: 'override of zero percent is still an override',
      input: { tenantId, ratePercentOverride: 0, rules: [], at },
      expected: {
        tenantId,
        ratePercent: 0,
        minTotalKopecks: 0,
        dailyCapPoints: null,
        source: 'override',
      },
    },
    {
      name: 'nothing configured means base rate',
      input: { tenantId, ratePercentOverride: null, rules: [], at },
      expected: {
        tenantId,
        ratePercent: null,
        minTotalKopecks: 0,
        dailyCapPoints: null,
        source: 'none',
      },
    },
    {
      name: 'future rule is ignored',
      input: {
        tenantId,
        ratePercentOverride: null,
        rules: [rule('r1', '2026-02-01T00:00:00Z', null)],
        at,
      },
      expected: {
        tenantId,
        ratePercent: null,
        minTotalKopecks: 0,
        dailyCapPoints: null,
        source: 'none',
      },
    },
  ] as const;

  it.each(cases)('$name', ({ input, expected }) => {
    expect(resolveEffectiveRule(input)).toEqual(expected);
  });
});

describe('periodsOverlap', () => {
  const p = (from: string, to: string | null) => ({
    validFrom: d(from),
    validTo: to === null ? null : d(to),
  });
  it.each([
    [
      'adjacent periods do not overlap',
      p('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
      p('2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z'),
      false,
    ],
    [
      'one instant shared',
      p('2026-01-01T00:00:00Z', '2026-02-01T00:00:00.001Z'),
      p('2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z'),
      true,
    ],
    [
      'containment',
      p('2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'),
      p('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z'),
      true,
    ],
    [
      'open-ended against later period',
      p('2026-01-01T00:00:00Z', null),
      p('2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z'),
      true,
    ],
    [
      'open-ended against earlier period',
      p('2026-06-01T00:00:00Z', null),
      p('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
      false,
    ],
    [
      'two open-ended periods',
      p('2026-01-01T00:00:00Z', null),
      p('2030-01-01T00:00:00Z', null),
      true,
    ],
    [
      'disjoint',
      p('2026-01-01T00:00:00Z', '2026-01-10T00:00:00Z'),
      p('2026-01-20T00:00:00Z', '2026-01-30T00:00:00Z'),
      false,
    ],
  ])('%s', (_name, a, b, expected) => {
    expect(periodsOverlap(a, b)).toBe(expected);
    expect(periodsOverlap(b, a)).toBe(expected);
  });
});

describe('rule period validation', () => {
  it.each([
    [{ validFrom: d('2026-01-01T00:00:00Z'), validTo: null }, true],
    [{ validFrom: d('2026-01-01T00:00:00Z'), validTo: d('2026-01-02T00:00:00Z') }, true],
    [{ validFrom: d('2026-01-01T00:00:00Z'), validTo: d('2026-01-01T00:00:00Z') }, false],
    [{ validFrom: d('2026-01-02T00:00:00Z'), validTo: d('2026-01-01T00:00:00Z') }, false],
    [{ validFrom: d('not a date'), validTo: null }, false],
    [{ validFrom: d('2026-01-01T00:00:00Z'), validTo: d('garbage') }, false],
  ])('%j valid: %s', (period, expected) => {
    expect(isValidRulePeriod(period)).toBe(expected);
    if (expected) {
      expect(() => assertValidRulePeriod(period)).not.toThrow();
    } else {
      expect(() => assertValidRulePeriod(period)).toThrow(
        expect.objectContaining({ code: 'PC_TENANT_RULE_INVALID_PERIOD', status: 422 }) as Error,
      );
    }
  });
});

describe('overlap detection against existing rules', () => {
  const existing = [
    rule('a', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
    rule('b', '2026-03-01T00:00:00Z', null),
  ];

  it('finds the overlapping rule and reports it in the error', () => {
    const candidate = { validFrom: d('2026-02-15T00:00:00Z'), validTo: d('2026-03-15T00:00:00Z') };
    expect(findOverlappingRule(existing, candidate)?.id).toBe('b');
    expect(() => assertNoRuleOverlap(existing, candidate)).toThrow(
      expect.objectContaining({
        code: 'PC_TENANT_RULE_OVERLAP',
        status: 409,
        details: expect.objectContaining({ overlappingRuleId: 'b' }),
      }) as Error,
    );
  });

  it('ignores the rule being edited', () => {
    const candidate = { validFrom: d('2026-03-01T00:00:00Z'), validTo: d('2026-04-01T00:00:00Z') };
    expect(findOverlappingRule(existing, candidate, 'b')).toBe(null);
    expect(() => assertNoRuleOverlap(existing, candidate, 'b')).not.toThrow();
  });

  it('accepts a gap between rules', () => {
    const candidate = { validFrom: d('2026-02-01T00:00:00Z'), validTo: d('2026-03-01T00:00:00Z') };
    expect(findOverlappingRule(existing, candidate)).toBe(null);
  });
});
