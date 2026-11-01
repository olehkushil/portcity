import { type ClubTestKit, createClubTestKit } from '../testing/club-test-kit';

const ADMIN = '0192f3a0-6c3e-7d2a-9c1b-0000000000ad';
const actor = { adminId: ADMIN, ip: '10.0.0.1' };

describe('RuleSetsService', () => {
  let kit: ClubTestKit;

  beforeEach(() => {
    kit = createClubTestKit('2026-11-01T10:00:00.000Z');
  });

  it('serves the built-in defaults when no version is stored', async () => {
    const active = await kit.ruleSets.getActiveRules();
    expect(active).toMatchObject({ version: 0, rules: { baseRatePercent: 3, holdDays: 7 } });
    expect(await kit.ruleSets.list()).toEqual([]);
  });

  it('creates the next version from a patch merged over the rules in force and audits it', async () => {
    const view = await kit.ruleSets.create(
      { config: { baseRatePercent: 5, welcome: { register: 100 } }, note: 'Акція' },
      actor,
    );

    expect(view).toMatchObject({ version: 1, active: true, note: 'Акція', createdById: ADMIN });
    expect(view.config).toMatchObject({
      baseRatePercent: 5,
      maxPointsPerReceipt: 500,
      welcome: { register: 100, profile: 30, firstReceipt: 20 },
    });
    expect((await kit.ruleSets.getActiveRules()).rules.baseRatePercent).toBe(5);
    expect(kit.audit.entries).toHaveLength(1);
    expect(kit.audit.entries[0]).toMatchObject({
      action: 'loyalty_rule_set.create',
      entityType: 'loyalty_rule_set',
      entityId: view.id,
      ip: '10.0.0.1',
    });

    const second = await kit.ruleSets.create({ config: { holdDays: 3 } }, actor);
    expect(second.version).toBe(2);
    expect(second.config).toMatchObject({ baseRatePercent: 5, holdDays: 3 });
  });

  it('rejects an invalid configuration, a taken version and a backdated start', async () => {
    await expect(
      kit.ruleSets.create({ config: { pointsTtlMonths: 0 } }, actor),
    ).rejects.toMatchObject({ code: 'PC_COMMON_VALIDATION' });

    await kit.ruleSets.create({ version: 3 }, actor);
    await expect(kit.ruleSets.create({ version: 3 }, actor)).rejects.toMatchObject({
      code: 'PC_RULESET_VERSION_TAKEN',
      status: 409,
    });

    await expect(
      kit.ruleSets.create({ activeFrom: new Date('2026-10-01T00:00:00.000Z') }, actor),
    ).rejects.toMatchObject({ code: 'PC_COMMON_VALIDATION' });
  });

  it('schedules a future version, lets it be edited or deleted only before it starts', async () => {
    const current = await kit.ruleSets.create({}, actor);
    const scheduled = await kit.ruleSets.create(
      { activeFrom: new Date('2026-12-01T00:00:00.000Z'), config: { baseRatePercent: 6 } },
      actor,
    );
    expect(scheduled.active).toBe(false);
    expect((await kit.ruleSets.getActiveRules()).id).toBe(current.id);

    const edited = await kit.ruleSets.update(scheduled.id, { config: { holdDays: 2 } }, actor);
    expect(edited.config).toMatchObject({ baseRatePercent: 6, holdDays: 2 });

    await expect(kit.ruleSets.update(current.id, { note: 'x' }, actor)).rejects.toMatchObject({
      code: 'PC_COMMON_CONFLICT',
    });

    kit.clock.set('2026-12-01T00:00:01.000Z');
    kit.ruleSets.invalidateCache();
    expect((await kit.ruleSets.getActiveRules()).id).toBe(scheduled.id);
    await expect(kit.ruleSets.remove(scheduled.id, actor)).rejects.toMatchObject({
      code: 'PC_COMMON_CONFLICT',
    });
  });

  it('removes a scheduled version and answers 404 for unknown ids', async () => {
    const scheduled = await kit.ruleSets.create(
      { activeFrom: new Date('2026-12-01T00:00:00.000Z') },
      actor,
    );
    await kit.ruleSets.remove(scheduled.id, actor, 'Передумали');
    expect(await kit.ruleSets.list()).toEqual([]);
    expect(kit.audit.entries.map((entry) => entry.action)).toEqual([
      'loyalty_rule_set.create',
      'loyalty_rule_set.delete',
    ]);
    await expect(kit.ruleSets.getById(scheduled.id)).rejects.toMatchObject({
      code: 'PC_RULESET_NOT_FOUND',
      status: 404,
    });
  });

  it('caches the active rules for a short time', async () => {
    await kit.ruleSets.getActiveRules();
    const spy = jest.spyOn(kit.repo, 'findActiveRuleSet');
    await kit.ruleSets.getActiveRules();
    expect(spy).not.toHaveBeenCalled();
    kit.clock.advance(31_000);
    await kit.ruleSets.getActiveRules();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
