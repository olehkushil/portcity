import { encodeCursor } from '../../../common/pagination/cursor';
import { TEST_PHONE, createIdentityHarness, loginMember } from '../testing/fixtures';

const ADMIN = { id: 'admin-1', ip: '10.0.0.1' };

function seedMembers() {
  const h = createIdentityHarness();
  h.store.seedUser({
    id: '0190a000-0000-7000-8000-00000000000a',
    phone: '+380501234567',
    memberCode: '734211800',
    firstName: 'Олег',
    lastName: 'Демо',
    email: 'oleh@example.com',
    createdAt: new Date('2026-01-01T10:00:00Z'),
  });
  h.store.seedUser({
    id: '0190a000-0000-7000-8000-00000000000b',
    phone: '+380671112233',
    memberCode: '100000009',
    firstName: 'Ірина',
    lastName: 'Коваль',
    createdAt: new Date('2026-01-02T10:00:00Z'),
  });
  h.store.seedUser({
    id: '0190a000-0000-7000-8000-00000000000c',
    phone: '+380931234500',
    memberCode: '200000007',
    firstName: 'Олена',
    status: 'blocked',
    createdAt: new Date('2026-01-03T10:00:00Z'),
  });
  return h;
}

describe('AdminUsersService.search', () => {
  it.each([
    ['050 123 45 67', ['734211800']],
    ['+380 (67) 111-22-33', ['100000009']],
    ['734211800', ['734211800']],
    ['1234', ['200000007', '734211800']],
    ['OLEH@example', ['734211800']],
    ['оле', ['200000007', '734211800']],
    ['коваль', ['100000009']],
  ])('q=%s finds %j', async (q, codes) => {
    const h = seedMembers();
    const page = await h.adminUsers.search({ q });
    expect(page.items.map((item) => item.memberCode)).toEqual(codes);
  });

  it('masks phones in the results', async () => {
    const h = seedMembers();
    const page = await h.adminUsers.search({ q: TEST_PHONE });
    expect(page.items[0]?.phone).toBe('+380 50 *** ** 67');
  });

  it('filters by status and paginates newest first', async () => {
    const h = seedMembers();
    const blocked = await h.adminUsers.search({ status: 'blocked' });
    expect(blocked.items.map((item) => item.memberCode)).toEqual(['200000007']);

    const first = await h.adminUsers.search({ limit: 2 });
    expect(first.items.map((item) => item.memberCode)).toEqual(['200000007', '100000009']);
    expect(first.nextCursor).not.toBeNull();
    const second = await h.adminUsers.search({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((item) => item.memberCode)).toEqual(['734211800']);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects cursors of other lists', async () => {
    const h = seedMembers();
    await expect(
      h.adminUsers.search({ cursor: encodeCursor({ receiptId: 'x' }) }),
    ).rejects.toMatchObject({ code: 'PC_COMMON_CURSOR_INVALID' });
  });
});

describe('AdminUsersService member card and actions', () => {
  it('shows the member card with a masked phone and audits the view', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    const card = await h.adminUsers.getDetails(login.user.id, ADMIN);

    expect(card.user.phone).toBe('+380 50 *** ** 67');
    expect(card.devices).toHaveLength(1);
    expect(card.consents).toHaveLength(3);
    expect(card.deletionRequest).toBeNull();
    expect(card.activeSessions).toBe(1);
    expect(h.store.audits.at(-1)).toEqual({
      actor: { type: 'admin', id: ADMIN.id },
      action: 'user.view',
      entityType: 'user',
      entityId: login.user.id,
      ip: ADMIN.ip,
    });
    await expect(h.adminUsers.getDetails('missing', ADMIN)).rejects.toMatchObject({
      code: 'PC_USER_NOT_FOUND',
    });
  });

  it('blocks and unblocks a member with audit and outbox', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);

    const blocked = await h.adminUsers.block(login.user.id, 'fraud receipts', ADMIN);
    expect(blocked.status).toBe('blocked');
    await expect(h.store.listActiveSessions(login.user.id, h.clock.now())).resolves.toEqual([]);
    expect(h.store.events.at(-1)).toMatchObject({
      type: 'user.blocked',
      payload: { userId: login.user.id, reason: 'fraud receipts' },
    });
    expect(h.store.audits.at(-1)).toMatchObject({
      action: 'user.block',
      before: { status: 'active' },
      after: { status: 'blocked' },
      reason: 'fraud receipts',
    });
    await expect(h.adminUsers.block(login.user.id, 'again', ADMIN)).rejects.toMatchObject({
      code: 'PC_USER_INVALID_TRANSITION',
      status: 409,
    });

    const active = await h.adminUsers.unblock(login.user.id, 'checked', ADMIN);
    expect(active.status).toBe('active');
    expect(h.store.audits.at(-1)).toMatchObject({ action: 'user.unblock', reason: 'checked' });
    expect(h.store.events.at(-1)).toMatchObject({
      type: 'user.unblocked',
      aggregateType: 'user',
      aggregateId: login.user.id,
      payload: { userId: login.user.id, reason: 'checked' },
    });
    await expect(h.adminUsers.unblock(login.user.id, 'again', ADMIN)).rejects.toMatchObject({
      code: 'PC_USER_INVALID_TRANSITION',
    });
  });

  it('ends every session of a member', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    await expect(h.adminUsers.revokeSessions(login.user.id, 'lost phone', ADMIN)).resolves.toEqual({
      userId: login.user.id,
      revokedSessions: 1,
    });
    expect(h.store.audits.at(-1)).toMatchObject({
      action: 'user.revoke_sessions',
      after: { revokedSessions: 1 },
    });
  });
});
