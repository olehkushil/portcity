import { PROFILE_FIELDS } from '../../../common/contracts/identity';
import { isProfileField, planProfileBonuses, profileFieldLabel } from './profile-bonus';

const USER = '0192f3a0-6c3e-7d2a-9c1b-000000000001';
const CONFIG = { perField: 10, complete: 20 };

describe('planProfileBonuses', () => {
  it('grants the per-field bonus with a fixed key per member and field', () => {
    expect(planProfileBonuses(USER, 'email', false, CONFIG)).toEqual({
      ok: true,
      bonuses: [
        {
          kind: 'field',
          idempotencyKey: `profile-field:email:${USER}`,
          amount: 10,
          title: 'Бонус за профіль',
          subtitle: 'E-mail',
        },
      ],
    });
  });

  it('adds the completion bonus on the event that completes the profile', () => {
    const plan = planProfileBonuses(USER, 'children', true, CONFIG);
    expect(plan).toMatchObject({
      ok: true,
      bonuses: [
        { kind: 'field', amount: 10, subtitle: 'Діти' },
        { kind: 'complete', amount: 20, idempotencyKey: `profile-complete:${USER}` },
      ],
    });
  });

  it.each([
    [{ perField: 0, complete: 20 }, false, []],
    [{ perField: 0, complete: 0 }, true, []],
    [{ perField: 0, complete: 20 }, true, ['complete']],
    [{ perField: 10, complete: 0 }, true, ['field']],
  ])('config %j, completedAll %p -> %j', (config, completedAll, kinds) => {
    const plan = planProfileBonuses(USER, 'city', completedAll, config);
    expect(plan.ok && plan.bonuses.map((bonus) => bonus.kind)).toEqual(kinds);
  });

  it('ignores fields identity does not count', () => {
    expect(planProfileBonuses(USER, 'favouriteColour', true, CONFIG)).toEqual({
      ok: false,
      reason: 'invalid_field',
    });
    expect(isProfileField('__proto__')).toBe(false);
  });

  it('has a Ukrainian label for every profile field', () => {
    for (const field of PROFILE_FIELDS) {
      expect(profileFieldLabel(field).length).toBeGreaterThan(0);
    }
  });
});
