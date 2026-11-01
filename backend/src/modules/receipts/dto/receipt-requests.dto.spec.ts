import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ApproveReceiptDto, ListReceiptsQueryDto, SubmitManualDto } from './receipt-requests.dto';

const PHOTO_KEY = 'receipts/0192f3a0-1111-7000-8000-000000000001/2026/01/0192f3a1-1111.jpg';
const TENANT_ID = '0192f3a0-0000-7000-8000-000000000001';

function errorsOf<T extends object>(cls: new () => T, body: Record<string, unknown>): string[] {
  return validateSync(plainToInstance(cls, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((error) => error.property);
}

const manual = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  fiscalId: '1180000001',
  issuedAt: '2026-01-15T11:30:00',
  totalKopecks: 42_000,
  photoKey: PHOTO_KEY,
  ...overrides,
});

describe('SubmitManualDto (manual receipt form)', () => {
  it.each<[string, Record<string, unknown>]>([
    ['fn without a shop', { fn: '4000100011' }],
    ['shop without fn', { tenantId: TENANT_ID }],
    ['"Не знаю" (null shop) with fn', { tenantId: null, fn: '4000100011' }],
    ['fn with spaces, dashes and leading zeros', { fn: ' 0004000-100-011 ' }],
    [
      'receipt number with spaces, dashes and lower case',
      { fn: '4000100011', fiscalId: 'ab 12-34' },
    ],
  ])('accepts %s', (_name, overrides) => {
    expect(errorsOf(SubmitManualDto, manual(overrides))).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a malformed shop id', { tenantId: 'shop-1' }, 'tenantId'],
    ['letters in fn', { fn: '40001000AB' }, 'fn'],
    ['a too short fn', { fn: '12345' }, 'fn'],
    ['a receipt number with dots', { fn: '4000100011', fiscalId: '12.34' }, 'fiscalId'],
    ['a missing receipt number', { fn: '4000100011', fiscalId: undefined }, 'fiscalId'],
  ])('refuses %s', (_name, overrides, property) => {
    expect(errorsOf(SubmitManualDto, manual(overrides))).toContain(property);
  });
});

describe('ListReceiptsQueryDto', () => {
  it('accepts ISO from/to and refuses anything else', () => {
    expect(
      errorsOf(ListReceiptsQueryDto, {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
      }),
    ).toEqual([]);
    expect(errorsOf(ListReceiptsQueryDto, { from: 'yesterday' })).toContain('from');
    expect(errorsOf(ListReceiptsQueryDto, { to: '2026-13-01' })).toContain('to');
  });
});

describe('ApproveReceiptDto', () => {
  it('takes an optional fn for receipts submitted without one', () => {
    expect(errorsOf(ApproveReceiptDto, {})).toEqual([]);
    expect(errorsOf(ApproveReceiptDto, { fn: '4000100011', reason: 'ок' })).toEqual([]);
    expect(errorsOf(ApproveReceiptDto, { fn: 'abc' })).toContain('fn');
  });
});
