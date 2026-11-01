import { uuidv7 } from 'uuidv7';
import { FAKE_TX, RewardsWorld, tenantSummary } from '../../../../test/rewards/support/fakes';
import type { RewardInput } from './rewards-catalogue.service';

const USER = 'user-1';
const ADMIN = { actor: { type: 'admin' as const, id: 'admin-1' }, ip: '10.0.0.1' };
const day = (offset: number): Date =>
  new Date(Date.parse('2026-11-01T10:00:00.000Z') + offset * 86_400_000);

describe('RewardsCatalogueService (members)', () => {
  let world: RewardsWorld;

  beforeEach(() => {
    world = new RewardsWorld();
    world.ledger.setBalance(USER, 100);
  });

  it('lists active rewards inside their period ordered by sortOrder', async () => {
    const parking = world.seedReward({ title: 'Година паркінгу', costPoints: 40, sortOrder: 1 });
    const coffee = world.seedReward({ title: 'Кава з собою', costPoints: 60, sortOrder: 2 });
    const cinema = world.seedReward({ title: 'Квиток у кіно', costPoints: 450, sortOrder: 3 });
    world.seedReward({ title: 'inactive', active: false });
    world.seedReward({ title: 'future', validFrom: day(1) });
    world.seedReward({ title: 'past', validTo: day(-1) });

    const page = await world.catalogue.listForMember(USER, { limit: 20 });
    expect(page.items.map((item) => item.id)).toEqual([parking.id, coffee.id, cinema.id]);
    expect(page.items.map((item) => item.affordable)).toEqual([true, true, false]);
    expect(page.items.every((item) => item.available)).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  it('affordable=true keeps only what the balance covers', async () => {
    world.seedReward({ costPoints: 40, sortOrder: 1 });
    world.seedReward({ costPoints: 100, sortOrder: 2 });
    world.seedReward({ costPoints: 101, sortOrder: 3 });
    const page = await world.catalogue.listForMember(USER, { limit: 20, affordable: true });
    expect(page.items.map((item) => item.costPoints)).toEqual([40, 100]);
  });

  it('ignores affordable=true when the balance is unknown and reports affordable null', async () => {
    world.ledger.failGetBalance = true;
    world.seedReward({ costPoints: 40 });
    world.seedReward({ costPoints: 4000 });
    const page = await world.catalogue.listForMember(USER, { limit: 20, affordable: true });
    expect(page.items).toHaveLength(2);
    expect(page.items.every((item) => item.affordable === null)).toBe(true);
  });

  it('treats a member without a loyalty account as unknown balance', async () => {
    world.seedReward({ costPoints: 40 });
    const page = await world.catalogue.listForMember('newcomer', { limit: 20, affordable: true });
    expect(page.items[0]?.affordable).toBeNull();
  });

  it('filters by kind', async () => {
    world.seedReward({ kind: 'parking_hour' });
    world.seedReward({ kind: 'cinema' });
    const page = await world.catalogue.listForMember(USER, { limit: 20, kind: 'cinema' });
    expect(page.items.map((item) => item.kind)).toEqual(['cinema']);
  });

  it('reports per-member limits and stock', async () => {
    const limited = world.seedReward({ perUserLimit: 1, costPoints: 10, sortOrder: 1 });
    world.seedReward({ stock: 0, sortOrder: 2 });
    await world.redemptions.redeem(USER, limited.id);

    const page = await world.catalogue.listForMember(USER, { limit: 20 });
    expect(page.items[0]).toMatchObject({
      remainingForUser: 0,
      available: false,
      unavailableReason: 'limit_reached',
    });
    expect(page.items[1]).toMatchObject({
      remainingForUser: null,
      available: false,
      unavailableReason: 'out_of_stock',
    });
    const other = await world.catalogue.listForMember('user-2', { limit: 20 });
    expect(other.items[0]).toMatchObject({ remainingForUser: 1, available: true });
  });

  it('serves guests: the same catalogue with per-user fields null', async () => {
    world = new RewardsWorld({ publicBaseUrl: 'https://cdn.portcity.ua' });
    const balance = jest.spyOn(world.ledger, 'getBalance');
    const counts = jest.spyOn(world.repo, 'countUserRedemptionsForRewards');
    world.seedReward({ title: 'Кава з собою', costPoints: 60, perUserLimit: 2, sortOrder: 1 });
    world.seedReward({
      title: 'Квиток у кіно',
      costPoints: 450,
      sortOrder: 2,
      imageKey: 'rewards/cinema.webp',
    });

    const page = await world.catalogue.listForMember(undefined, { limit: 20, affordable: true });
    expect(page.items.map((item) => item.title)).toEqual(['Кава з собою', 'Квиток у кіно']);
    expect(page.items.map((item) => [item.affordable, item.remainingForUser])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(page.items[1]?.imageUrl).toBe('https://cdn.portcity.ua/rewards/cinema.webp');
    expect(page.items[0]?.imageUrl).toBeNull();

    const detail = await world.catalogue.getForMember(undefined, page.items[0]?.id ?? '');
    expect(detail).toMatchObject({ affordable: null, remainingForUser: null, available: true });
    expect(balance).not.toHaveBeenCalled();
    expect(counts).not.toHaveBeenCalled();
  });

  it('attaches tenant cards and survives a failing content port', async () => {
    const tenant = world.content.add(
      tenantSummary({ slug: 'aroma-kava', name: 'Aroma Kava', floor: 1 }),
    );
    world.seedReward({ tenantId: tenant.id });
    const page = await world.catalogue.listForMember(USER, { limit: 20 });
    expect(page.items[0]?.tenant).toEqual({
      id: tenant.id,
      slug: 'aroma-kava',
      name: 'Aroma Kava',
      floor: 1,
      logoKey: null,
      logoUrl: null,
    });
    world.content.fail = true;
    const degraded = await world.catalogue.listForMember(USER, { limit: 20 });
    expect(degraded.items[0]?.tenant).toBeNull();
    expect(degraded.items[0]?.tenantId).toBe(tenant.id);
  });

  it('pages with an opaque cursor', async () => {
    for (let index = 0; index < 5; index += 1) {
      world.seedReward({ sortOrder: index, title: `r${index}` });
    }
    const first = await world.catalogue.listForMember(USER, { limit: 2 });
    const second = await world.catalogue.listForMember(USER, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    const third = await world.catalogue.listForMember(USER, {
      limit: 2,
      cursor: second.nextCursor ?? undefined,
    });
    expect([...first.items, ...second.items, ...third.items].map((item) => item.title)).toEqual([
      'r0',
      'r1',
      'r2',
      'r3',
      'r4',
    ]);
    expect(third.nextCursor).toBeNull();
  });

  it('getForMember returns listed rewards and hides the rest', async () => {
    const listed = world.seedReward({ costPoints: 60 });
    const hidden = world.seedReward({ active: false });
    expect(await world.catalogue.getForMember(USER, listed.id)).toMatchObject({
      id: listed.id,
      affordable: true,
    });
    await expect(world.catalogue.getForMember(USER, hidden.id)).rejects.toMatchObject({
      code: 'PC_REWARD_NOT_FOUND',
    });
    await expect(world.catalogue.getForMember(USER, uuidv7())).rejects.toMatchObject({
      code: 'PC_REWARD_NOT_FOUND',
    });
  });
});

describe('RewardsCatalogueService (back office)', () => {
  let world: RewardsWorld;

  const input: RewardInput = {
    title: '  Попкорн у Premier City  ',
    costPoints: 80,
    kind: 'partner',
  };

  beforeEach(() => {
    world = new RewardsWorld();
  });

  it('creates a reward with defaults and audits it in the same transaction', async () => {
    const dto = await world.catalogue.create(input, ADMIN);
    expect(dto).toMatchObject({
      title: 'Попкорн у Premier City',
      costPoints: 80,
      kind: 'partner',
      description: null,
      tenantId: null,
      stock: null,
      perUserLimit: null,
      active: true,
      validFrom: null,
      validTo: null,
      sortOrder: 0,
      affordable: null,
      remainingForUser: null,
    });
    expect(world.audit.actions()).toEqual(['reward.create']);
    expect(world.audit.entries[0]?.tx).toBe(FAKE_TX);
    expect(world.audit.entries[0]?.entry).toMatchObject({
      actor: ADMIN.actor,
      entityType: 'reward',
      entityId: dto.id,
      ip: '10.0.0.1',
    });
  });

  it('rejects an empty period', async () => {
    await expect(
      world.catalogue.create({ ...input, validFrom: day(2), validTo: day(1) }, ADMIN),
    ).rejects.toMatchObject({ code: 'PC_COMMON_VALIDATION' });
    expect(world.repo.rewards).toEqual([]);
  });

  it('rejects an unknown tenant but tolerates an unavailable content module', async () => {
    await expect(
      world.catalogue.create({ ...input, tenantId: uuidv7() }, ADMIN),
    ).rejects.toMatchObject({
      code: 'PC_COMMON_VALIDATION',
    });
    world.content.fail = true;
    await expect(
      world.catalogue.create({ ...input, tenantId: uuidv7() }, ADMIN),
    ).resolves.toMatchObject({
      costPoints: 80,
    });
  });

  it('accepts a known tenant and shows its card', async () => {
    const tenant = world.content.add(tenantSummary());
    const dto = await world.catalogue.create({ ...input, tenantId: tenant.id }, ADMIN);
    expect(dto.tenant?.id).toBe(tenant.id);
  });

  it('updates only the fields sent and audits before/after', async () => {
    const created = await world.catalogue.create({ ...input, stock: 5 }, ADMIN);
    const updated = await world.catalogue.update(
      created.id,
      { costPoints: 90, stock: null },
      ADMIN,
    );
    expect(updated).toMatchObject({ costPoints: 90, stock: null, title: 'Попкорн у Premier City' });
    const audit = world.audit.entries[1]?.entry;
    expect(audit?.action).toBe('reward.update');
    expect(audit?.before).toMatchObject({ costPoints: 80, stock: 5 });
    expect(audit?.after).toMatchObject({ costPoints: 90, stock: null });
  });

  it('validates the period against stored values on update', async () => {
    const created = await world.catalogue.create({ ...input, validTo: day(5) }, ADMIN);
    await expect(
      world.catalogue.update(created.id, { validFrom: day(6) }, ADMIN),
    ).rejects.toMatchObject({
      code: 'PC_COMMON_VALIDATION',
    });
  });

  it('deactivates instead of deleting', async () => {
    const created = await world.catalogue.create(input, ADMIN);
    const dto = await world.catalogue.deactivate(created.id, { ...ADMIN, reason: 'season over' });
    expect(dto.active).toBe(false);
    expect(dto.available).toBe(false);
    expect(world.repo.rewards).toHaveLength(1);
    expect(world.audit.entries[1]?.entry).toMatchObject({
      action: 'reward.deactivate',
      before: { active: true },
      after: { active: false },
      reason: 'season over',
    });
    await world.catalogue.deactivate(created.id, ADMIN);
    expect(world.audit.actions()).toEqual([
      'reward.create',
      'reward.deactivate',
      'reward.deactivate',
    ]);
  });

  it('lists every reward with admin filters', async () => {
    world.seedReward({ active: false, kind: 'gift', sortOrder: 1 });
    world.seedReward({ active: true, kind: 'cinema', tenantId: 't-1', sortOrder: 2 });
    world.seedReward({ validTo: day(-10), sortOrder: 3 });
    expect((await world.catalogue.listForAdmin({ limit: 10 })).items).toHaveLength(3);
    expect((await world.catalogue.listForAdmin({ limit: 10, active: false })).items).toHaveLength(
      1,
    );
    expect((await world.catalogue.listForAdmin({ limit: 10, kind: 'cinema' })).items).toHaveLength(
      1,
    );
    expect((await world.catalogue.listForAdmin({ limit: 10, tenantId: 't-1' })).items).toHaveLength(
      1,
    );
  });

  it('getForAdmin and update throw PC_REWARD_NOT_FOUND for unknown ids', async () => {
    await expect(world.catalogue.getForAdmin(uuidv7())).rejects.toMatchObject({
      code: 'PC_REWARD_NOT_FOUND',
    });
    await expect(world.catalogue.update(uuidv7(), { costPoints: 1 }, ADMIN)).rejects.toMatchObject({
      code: 'PC_REWARD_NOT_FOUND',
    });
    await expect(world.catalogue.deactivate(uuidv7(), ADMIN)).rejects.toMatchObject({
      code: 'PC_REWARD_NOT_FOUND',
    });
  });
});
