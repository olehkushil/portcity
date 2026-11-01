import 'reflect-metadata';
import type { TransformFnParams } from 'class-transformer';
import { createValidationPipe } from '../../../common/validation/validation.pipe';
import { AdminRewardListQueryDto, CreateRewardDto, UpdateRewardDto } from './admin-reward.dto';
import { CreateValidatorDeviceDto, SetValidatorPinDto } from './admin-validator-device.dto';
import { AdminIssueVoucherDto, AdminVoucherListQueryDto } from './admin-voucher.dto';
import { RewardListQueryDto } from './reward.dto';
import { toCommaList, toDateOrNull, toOptionalBoolean, trimmed } from './transforms';
import { OpenShiftDto, ValidatorRedeemDto } from './validator.dto';
import { VoucherListQueryDto } from './voucher.dto';

const params = (value: unknown): TransformFnParams => ({ value }) as TransformFnParams;

describe('transforms', () => {
  it.each([
    [undefined, undefined],
    [null, undefined],
    ['', undefined],
    ['true', true],
    ['1', true],
    [true, true],
    ['false', false],
    ['0', false],
    [false, false],
    ['yes', 'yes'],
  ])('toOptionalBoolean(%p) = %p', (value, expected) => {
    expect(toOptionalBoolean(params(value))).toBe(expected);
  });

  it.each([
    ['  a  ', 'a'],
    [5, 5],
    [null, null],
  ])('trimmed(%p) = %p', (value, expected) => {
    expect(trimmed(params(value))).toBe(expected);
  });

  it('toDateOrNull parses ISO strings and keeps the rest', () => {
    expect(toDateOrNull(params('2026-11-01T10:00:00.000Z'))).toEqual(
      new Date('2026-11-01T10:00:00.000Z'),
    );
    expect(toDateOrNull(params(''))).toBeNull();
    expect(toDateOrNull(params(null))).toBeNull();
    expect(toDateOrNull(params(undefined))).toBeUndefined();
    expect(toDateOrNull(params('not a date'))).toBe('not a date');
    const date = new Date();
    expect(toDateOrNull(params(date))).toBe(date);
    expect(toDateOrNull(params(42))).toBe(42);
  });

  it.each([
    [undefined, undefined],
    ['', undefined],
    [' , ', undefined],
    ['issued', ['issued']],
    ['issued, active,,issued', ['issued', 'active']],
    [
      ['issued', 'active,expired'],
      ['issued', 'active', 'expired'],
    ],
  ])('toCommaList(%p) = %p', (value, expected) => {
    expect(toCommaList(params(value))).toEqual(expected);
  });
});

describe('DTO validation (global ValidationPipe)', () => {
  const pipe = createValidationPipe();

  async function validate<T>(
    metatype: new () => T,
    value: unknown,
    type: 'body' | 'query' = 'body',
  ): Promise<T> {
    return (await pipe.transform(value, { type, metatype, data: '' })) as T;
  }

  async function rejects(
    metatype: new () => unknown,
    value: unknown,
    type: 'body' | 'query' = 'body',
  ): Promise<void> {
    await expect(validate(metatype, value, type)).rejects.toMatchObject({
      code: 'PC_COMMON_VALIDATION',
    });
  }

  it('RewardListQueryDto converts affordable and limit from the query string', async () => {
    const dto = await validate(
      RewardListQueryDto,
      { affordable: 'true', limit: '5', kind: 'cinema' },
      'query',
    );
    expect(dto).toMatchObject({ affordable: true, limit: 5, kind: 'cinema' });
    await rejects(RewardListQueryDto, { affordable: 'maybe' }, 'query');
    await rejects(RewardListQueryDto, { kind: 'spa' }, 'query');
    await rejects(RewardListQueryDto, { limit: '500' }, 'query');
  });

  it('VoucherListQueryDto accepts statuses only from the contract', async () => {
    expect(await validate(VoucherListQueryDto, { status: 'active' }, 'query')).toMatchObject({
      status: ['active'],
      limit: 20,
    });
    await rejects(VoucherListQueryDto, { status: 'used' }, 'query');
  });

  it('VoucherListQueryDto takes several statuses, comma separated or repeated', async () => {
    expect(
      await validate(VoucherListQueryDto, { status: 'issued, active,issued' }, 'query'),
    ).toMatchObject({ status: ['issued', 'active'] });
    expect(
      await validate(VoucherListQueryDto, { status: ['redeemed', 'expired,cancelled'] }, 'query'),
    ).toMatchObject({ status: ['redeemed', 'expired', 'cancelled'] });
    expect((await validate(VoucherListQueryDto, { status: '' }, 'query')).status).toBeUndefined();
    await rejects(VoucherListQueryDto, { status: 'issued,used' }, 'query');
  });

  it('AdminVoucherListQueryDto shares the multi-status filter', async () => {
    expect(
      await validate(AdminVoucherListQueryDto, { status: 'issued,active' }, 'query'),
    ).toMatchObject({ status: ['issued', 'active'] });
    await rejects(AdminVoucherListQueryDto, { status: 'nope' }, 'query');
  });

  it('CreateRewardDto validates the catalogue fields', async () => {
    const dto = await validate(CreateRewardDto, {
      title: '  Кава з собою ',
      costPoints: 60,
      kind: 'partner',
      tenantId: null,
      validFrom: '2026-11-01T00:00:00.000Z',
      validTo: null,
    });
    expect(dto).toMatchObject({ title: 'Кава з собою', tenantId: null, validTo: null });
    expect(dto.validFrom).toEqual(new Date('2026-11-01T00:00:00.000Z'));
    await rejects(CreateRewardDto, { title: 'x', costPoints: 0, kind: 'partner' });
    await rejects(CreateRewardDto, { title: 'x', costPoints: 1.5, kind: 'partner' });
    await rejects(CreateRewardDto, { title: '', costPoints: 1, kind: 'partner' });
    await rejects(CreateRewardDto, {
      title: 'x',
      costPoints: 1,
      kind: 'partner',
      validFrom: 'soon',
    });
    await rejects(CreateRewardDto, { title: 'x', costPoints: 1, kind: 'partner', stock: -1 });
    await rejects(CreateRewardDto, { title: 'x', costPoints: 1, kind: 'partner', unknown: true });
  });

  it('UpdateRewardDto accepts partial bodies', async () => {
    expect(await validate(UpdateRewardDto, { costPoints: 90 })).toMatchObject({ costPoints: 90 });
    expect(await validate(UpdateRewardDto, {})).toBeInstanceOf(UpdateRewardDto);
    await rejects(UpdateRewardDto, { costPoints: -1 });
  });

  it('AdminRewardListQueryDto converts the active filter', async () => {
    expect(await validate(AdminRewardListQueryDto, { active: 'false' }, 'query')).toMatchObject({
      active: false,
    });
  });

  it('CreateValidatorDeviceDto and SetValidatorPinDto require a 6-12 digit PIN', async () => {
    expect(
      await validate(CreateValidatorDeviceDto, { name: 'Каса 1', pin: ' 482915 ' }),
    ).toMatchObject({ pin: '482915' });
    await rejects(CreateValidatorDeviceDto, { name: 'Каса 1', pin: '1234' });
    await rejects(CreateValidatorDeviceDto, { name: 'Каса 1', pin: '12345' });
    await rejects(CreateValidatorDeviceDto, { name: 'Каса 1', pin: '12ab56' });
    await rejects(CreateValidatorDeviceDto, { name: 'Каса 1', pin: '1234567890123' });
    await rejects(CreateValidatorDeviceDto, {
      name: 'Каса 1',
      pin: '482915',
      tenantId: 'not-a-uuid',
    });
    expect(await validate(SetValidatorPinDto, { pin: '730158' })).toMatchObject({ pin: '730158' });
    await rejects(SetValidatorPinDto, { pin: '4321' });
  });

  it('OpenShiftDto still accepts the 4-digit PIN of an existing device', async () => {
    expect(await validate(OpenShiftDto, { pin: '1234' })).toMatchObject({ pin: '1234' });
    expect(await validate(OpenShiftDto, { pin: '482915' })).toMatchObject({ pin: '482915' });
    await rejects(OpenShiftDto, { pin: '' });
    await rejects(OpenShiftDto, { pin: '123' });
  });

  it('ValidatorRedeemDto needs a code or a token', async () => {
    expect(await validate(ValidatorRedeemDto, { code: ' k7m-2pq ' })).toMatchObject({
      code: 'k7m-2pq',
    });
    expect(await validate(ValidatorRedeemDto, { token: 'a'.repeat(40) })).toMatchObject({
      token: 'a'.repeat(40),
    });
    await rejects(ValidatorRedeemDto, {});
    await rejects(ValidatorRedeemDto, { code: 'abc' });
    await rejects(ValidatorRedeemDto, { token: 'short' });
  });

  it('AdminIssueVoucherDto validates kind, user and expiry', async () => {
    const dto = await validate(AdminIssueVoucherDto, {
      userId: '01927f3a-8c4b-7d2e-9f10-123456789abc',
      kind: 'certificate',
      title: 'Подарункова карта',
      expiresAt: null,
    });
    expect(dto.expiresAt).toBeNull();
    await rejects(AdminIssueVoucherDto, { userId: 'x', kind: 'certificate', title: 'a' });
    await rejects(AdminIssueVoucherDto, {
      userId: '01927f3a-8c4b-7d2e-9f10-123456789abc',
      kind: 'gift',
      title: 'a',
    });
  });
});
