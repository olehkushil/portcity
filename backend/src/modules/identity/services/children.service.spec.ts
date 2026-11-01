import { captureAsyncError, createIdentityHarness, loginMember } from '../testing/fixtures';

async function member() {
  const h = createIdentityHarness();
  const login = await loginMember(h);
  return { h, userId: login.user.id };
}

describe('ChildrenService', () => {
  it('adds, lists (oldest first), updates and removes children', async () => {
    const { h, userId } = await member();
    const younger = await h.children.create(userId, { birthMonth: 2, birthYear: 2022 });
    const older = await h.children.create(userId, {
      birthMonth: 9,
      birthYear: 2016,
      gender: 'female',
    });
    expect(younger).toMatchObject({ birthMonth: 2, birthYear: 2022, gender: 'unspecified' });

    const list = await h.children.list(userId);
    expect(list).toEqual({ items: [older, younger], max: 6 });

    const updated = await h.children.update(userId, younger.id, { gender: 'male', birthMonth: 3 });
    expect(updated).toMatchObject({
      id: younger.id,
      gender: 'male',
      birthMonth: 3,
      birthYear: 2022,
    });
    await expect(h.children.update(userId, younger.id, {})).resolves.toEqual(updated);

    await h.children.remove(userId, older.id);
    await expect(h.children.list(userId)).resolves.toMatchObject({ items: [updated] });
  });

  it('allows at most six children, also under parallel requests', async () => {
    const { h, userId } = await member();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        h.children.create(userId, { birthMonth: (index % 12) + 1, birthYear: 2020 }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(6);
    const refused = results.find((result) => result.status === 'rejected');
    expect(refused?.status === 'rejected' ? refused.reason : null).toMatchObject({
      code: 'PC_USER_CHILD_LIMIT',
      status: 422,
    });
    expect(h.store.state.children.size).toBe(6);
  });

  it('validates the birth month on create and on update', async () => {
    const { h, userId } = await member();
    expect(
      await captureAsyncError(h.children.create(userId, { birthMonth: 4, birthYear: 2026 })),
    ).toMatchObject({ code: 'PC_USER_CHILD_BIRTH_INVALID', details: { reason: 'future' } });
    const child = await h.children.create(userId, { birthMonth: 1, birthYear: 2010 });
    expect(
      await captureAsyncError(h.children.update(userId, child.id, { birthYear: 2006 })),
    ).toMatchObject({ code: 'PC_USER_CHILD_BIRTH_INVALID', details: { reason: 'too_old' } });
  });

  it("hides other members' children and refuses blocked members", async () => {
    const { h, userId } = await member();
    const child = await h.children.create(userId, { birthMonth: 1, birthYear: 2020 });
    h.store.seedUser({ id: 'u-other', phone: '+380671112233', memberCode: '100000009' });
    for (const call of [
      h.children.update('u-other', child.id, { gender: 'male' }),
      h.children.remove('u-other', child.id),
      h.children.remove(userId, '0190a000-0000-7000-8000-00000000dead'),
    ]) {
      expect(await captureAsyncError(call)).toMatchObject({
        code: 'PC_USER_CHILD_NOT_FOUND',
        status: 404,
      });
    }
    h.store.seedUser({
      id: 'u-blocked',
      phone: '+380671112234',
      memberCode: '100000017',
      status: 'blocked',
    });
    await expect(h.children.list('u-blocked')).rejects.toMatchObject({ code: 'PC_USER_BLOCKED' });
  });

  it('exports the children with the personal data', async () => {
    const { h, userId } = await member();
    await h.children.create(userId, { birthMonth: 6, birthYear: 2018, gender: 'female' });
    const exported = await h.profiles.exportPersonalData(userId);
    expect(exported.children).toEqual([
      expect.objectContaining({ birthMonth: 6, birthYear: 2018, gender: 'female' }),
    ]);
  });
});
