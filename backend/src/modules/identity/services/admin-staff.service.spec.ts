import { AdminAccessGate } from '../../../common/auth/admin-access';
import { verifyPassword } from '../../../common/auth/crypto';
import { createIdentityHarness } from '../testing/fixtures';
import { AdminStaffService } from './admin-staff.service';

const OWNER = { id: 'owner-1', ip: '10.0.0.1' };
// A valid PHC string is not needed for these tests: logins are not exercised here.
const HASH = '$scrypt$ln=15,r=8,p=1$c2FsdA==$aGFzaA==';

function withOwner() {
  const h = createIdentityHarness();
  h.store.seedAdmin({
    id: OWNER.id,
    email: 'owner@portcity.local',
    passwordHash: HASH,
    role: 'owner',
  });
  return h;
}

describe('AdminStaffService', () => {
  it('creates an account with a lower-cased e-mail and a scrypt hash, audited without secrets', async () => {
    const h = withOwner();
    const created = await h.adminStaff.create(
      {
        email: ' Moderator@PortCity.local ',
        password: 'Moderator-Pass-2026',
        role: 'moderator',
        name: ' Ірина ',
      },
      OWNER,
    );
    expect(created).toMatchObject({
      email: 'moderator@portcity.local',
      role: 'moderator',
      name: 'Ірина',
      active: true,
      totpEnabled: false,
    });
    const stored = h.store.state.admins.get(created.id);
    await expect(verifyPassword('Moderator-Pass-2026', stored?.passwordHash ?? '')).resolves.toBe(
      true,
    );
    const audit = h.store.audits.at(-1);
    expect(audit).toMatchObject({
      action: 'admin_user.create',
      entityId: created.id,
      ip: OWNER.ip,
    });
    expect(JSON.stringify(audit)).not.toContain(stored?.passwordHash ?? 'unreachable');

    await expect(
      h.adminStaff.create(
        { email: 'moderator@portcity.local', password: 'Another-Pass-2026', role: 'support' },
        OWNER,
      ),
    ).rejects.toMatchObject({ code: 'PC_ADMIN_EMAIL_TAKEN', status: 409 });
  });

  it('updates role, name, activity and password', async () => {
    const h = withOwner();
    h.store.seedAdmin({
      id: 'mod-1',
      email: 'mod@portcity.local',
      passwordHash: HASH,
      role: 'moderator',
    });

    const updated = await h.adminStaff.update(
      'mod-1',
      { role: 'manager', name: 'Менеджер', active: false, password: 'Brand-New-Pass-2026' },
      OWNER,
    );
    expect(updated).toMatchObject({ role: 'manager', name: 'Менеджер', active: false });
    await expect(
      verifyPassword('Brand-New-Pass-2026', h.store.state.admins.get('mod-1')?.passwordHash ?? ''),
    ).resolves.toBe(true);
    const audit = h.store.audits.at(-1);
    expect(audit).toMatchObject({
      action: 'admin_user.update',
      before: { role: 'moderator', active: true },
      after: { role: 'manager', active: false, passwordChanged: true },
    });
    expect(JSON.stringify(audit)).not.toContain('$scrypt$');
  });

  it('protects the last active owner and forbids self-demotion', async () => {
    const h = withOwner();
    await expect(h.adminStaff.update(OWNER.id, { active: false }, OWNER)).rejects.toMatchObject({
      code: 'PC_ADMIN_SELF_ACTION',
      status: 422,
    });
    await expect(
      h.adminStaff.update(OWNER.id, { role: 'manager' }, { id: 'someone-else' }),
    ).rejects.toMatchObject({ code: 'PC_ADMIN_LAST_OWNER', status: 422 });

    h.store.seedAdmin({
      id: 'owner-2',
      email: 'owner2@portcity.local',
      passwordHash: HASH,
      role: 'owner',
    });
    await expect(h.adminStaff.update('owner-2', { role: 'manager' }, OWNER)).resolves.toMatchObject(
      {
        role: 'manager',
      },
    );
  });

  it('allows renaming yourself and returns unchanged accounts without an audit row', async () => {
    const h = withOwner();
    await expect(h.adminStaff.update(OWNER.id, { name: 'Власник' }, OWNER)).resolves.toMatchObject({
      name: 'Власник',
    });
    const audits = h.store.audits.length;
    await expect(
      h.adminStaff.update(OWNER.id, { role: 'owner', active: true }, OWNER),
    ).resolves.toMatchObject({
      role: 'owner',
    });
    expect(h.store.audits.length).toBe(audits);
    await expect(h.adminStaff.update('missing', { name: 'x' }, OWNER)).rejects.toMatchObject({
      code: 'PC_ADMIN_NOT_FOUND',
    });
  });

  it('lists accounts oldest first', async () => {
    const h = withOwner();
    h.clock.advanceMinutes(1);
    h.store.seedAdmin({
      id: 'mod-1',
      email: 'mod@portcity.local',
      passwordHash: HASH,
      role: 'moderator',
    });
    const { items } = await h.adminStaff.list();
    expect(items.map((item) => item.id)).toEqual([OWNER.id, 'mod-1']);
  });

  it('hashes new passwords with the configured admin cost and unlocks the account on reset', async () => {
    const h = withOwner();
    h.store.seedAdmin({
      id: 'mod-1',
      email: 'mod@portcity.local',
      passwordHash: HASH,
      role: 'moderator',
      failedLoginCount: 7,
      lockedUntil: new Date('2026-03-10T11:00:00.000Z'),
      loginChallengeId: '0190a000-0000-7000-8000-00000000c0de',
    });
    await h.adminStaff.update('mod-1', { password: 'Brand-New-Pass-2026' }, OWNER);
    const stored = h.store.state.admins.get('mod-1');
    // Unit tests run with ADMIN_PASSWORD_SCRYPT_LOG_N=10; production default is 17.
    expect(stored?.passwordHash.startsWith('$scrypt$ln=10,')).toBe(true);
    expect(stored).toMatchObject({
      failedLoginCount: 0,
      lockedUntil: null,
      loginChallengeId: null,
    });
    const created = await h.adminStaff.create(
      { email: 'new@portcity.local', password: 'Another-Pass-2026', role: 'support' },
      OWNER,
    );
    expect(h.store.state.admins.get(created.id)?.passwordHash.startsWith('$scrypt$ln=10,')).toBe(
      true,
    );
    expect(
      createIdentityHarness({ identity: { ADMIN_PASSWORD_SCRYPT_LOG_N: '17' } }).config,
    ).toMatchObject({ ADMIN_PASSWORD_SCRYPT_LOG_N: 17 });
  });

  it('drops the AdminGuard cache entry after a role, activity or password change', async () => {
    const h = withOwner();
    h.store.seedAdmin({
      id: 'mod-1',
      email: 'mod@portcity.local',
      passwordHash: HASH,
      role: 'moderator',
    });
    const gate = new AdminAccessGate(h.appConfig, h.clock);
    gate.useResolver((id) => h.port.getAdminAccess(id));
    const staff = new AdminStaffService(h.store, h.clock, h.config, gate);
    const modToken = {
      id: 'mod-1',
      type: 'admin' as const,
      roles: ['moderator'],
      tokenId: 't',
      tokenExpiresAt: new Date(),
    };
    await expect(gate.assertActive(modToken)).resolves.toBeUndefined();

    await staff.update('mod-1', { active: false }, OWNER);
    await expect(gate.assertActive(modToken)).rejects.toMatchObject({
      code: 'PC_ADMIN_INACTIVE',
      status: 403,
    });

    await staff.update('mod-1', { active: true, role: 'support' }, OWNER);
    await expect(gate.assertActive(modToken)).rejects.toMatchObject({
      code: 'PC_AUTH_TOKEN_INVALID',
    });

    const invalidate = jest.spyOn(gate, 'invalidate');
    await staff.update('mod-1', { name: 'Ірина' }, OWNER);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
