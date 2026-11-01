import { DomainError } from '../../../common/errors/domain-error';
import { normaliseAuditFilter, parseAuditAction } from './audit-filter';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return DomainError.is(error) ? error.code : `not-a-domain-error: ${String(error)}`;
  }
}

describe('parseAuditAction', () => {
  it.each<[string, { kind: string; value: string }]>([
    ['tenant.update', { kind: 'exact', value: 'tenant.update' }],
    ['manual_adjustment.approve', { kind: 'exact', value: 'manual_adjustment.approve' }],
    ['parking.session.close', { kind: 'exact', value: 'parking.session.close' }],
    ['  tenant.update  ', { kind: 'exact', value: 'tenant.update' }],
    ['tenant.*', { kind: 'prefix', value: 'tenant.' }],
    ['manual_adjustment.*', { kind: 'prefix', value: 'manual_adjustment.' }],
    ['parking.session.*', { kind: 'prefix', value: 'parking.session.' }],
  ])('%p -> %p', (input, expected) => {
    expect(parseAuditAction(input)).toEqual(expected);
  });

  it.each([
    'Tenant.Update',
    'tenant',
    'tenant.*.x',
    '*',
    'tenant.up date',
    '.update',
    'tenant..update',
    '',
  ])('rejects %p with PC_AUDIT_ACTION_INVALID', (input) => {
    expect(codeOf(() => parseAuditAction(input))).toBe('PC_AUDIT_ACTION_INVALID');
  });
});

describe('normaliseAuditFilter', () => {
  it('drops empty values and trims the rest', () => {
    expect(
      normaliseAuditFilter({
        entityType: '  tenant ',
        entityId: '',
        actorType: ' admin',
        actorId: '  ',
        action: 'tenant.*',
      }),
    ).toEqual({
      entityType: 'tenant',
      actorType: 'admin',
      action: { kind: 'prefix', value: 'tenant.' },
    });
  });

  it('returns an empty filter for empty input', () => {
    expect(normaliseAuditFilter({})).toEqual({});
  });

  it('keeps a valid time window', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-01-31T00:00:00.000Z');
    expect(normaliseAuditFilter({ from, to })).toEqual({ from, to });
  });

  it.each<[string, Parameters<typeof normaliseAuditFilter>[0], string]>([
    ['unknown actor type', { actorType: 'robot' }, 'PC_COMMON_VALIDATION'],
    ['invalid action', { action: 'Tenant' }, 'PC_AUDIT_ACTION_INVALID'],
    [
      'reversed window',
      { from: new Date('2026-02-01T00:00:00Z'), to: new Date('2026-01-01T00:00:00Z') },
      'PC_COMMON_VALIDATION',
    ],
    ['invalid date', { from: new Date('not a date') }, 'PC_COMMON_VALIDATION'],
  ])('rejects %s', (_name, input, code) => {
    expect(codeOf(() => normaliseAuditFilter(input))).toBe(code);
  });
});
