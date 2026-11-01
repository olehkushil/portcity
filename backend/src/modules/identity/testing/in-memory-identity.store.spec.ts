import { buildOutboxEvent } from '../../../common/contracts/events';
import { StoreConflictError } from '../services/identity.store';
import { captureAsyncError } from './errors';
import { InMemoryIdentityStore } from './in-memory-identity.store';

const now = new Date('2026-03-10T10:00:00Z');

describe('InMemoryIdentityStore', () => {
  it('rolls back state and events when a unit of work throws', async () => {
    const store = new InMemoryIdentityStore(() => now);
    await expect(
      store.run(async (uow) => {
        await uow.createUser({
          id: 'u-1',
          phone: '+380501234567',
          memberCode: '734211800',
          createdAt: now,
        });
        await uow.publish(
          buildOutboxEvent('user.blocked', 'user', 'u-1', { userId: 'u-1', reason: null }),
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(store.state.users.size).toBe(0);
    expect(store.events).toEqual([]);
  });

  it('enforces unique phone, member code, e-mail and admin e-mail', async () => {
    const store = new InMemoryIdentityStore(() => now);
    store.seedUser({ id: 'u-1', phone: '+380501234567', memberCode: '734211800', email: 'a@x.ua' });
    store.seedUser({ id: 'u-2', phone: '+380671112233', memberCode: '100000009' });
    store.seedAdmin({ id: 'a-1', email: 'admin@portcity.local', passwordHash: 'x' });

    const conflicts = [
      await captureAsyncError(
        store.run((uow) =>
          uow.createUser({ id: 'u-3', phone: '+380501234567', memberCode: '1', createdAt: now }),
        ),
      ),
      await captureAsyncError(
        store.run((uow) =>
          uow.createUser({
            id: 'u-3',
            phone: '+380931234567',
            memberCode: '734211800',
            createdAt: now,
          }),
        ),
      ),
      await captureAsyncError(store.run((uow) => uow.updateUser('u-2', { email: 'a@x.ua' }))),
      await captureAsyncError(
        store.run((uow) =>
          uow.createAdmin({
            id: 'a-2',
            email: 'admin@portcity.local',
            passwordHash: 'x',
            role: 'support',
            name: null,
            active: true,
            createdAt: now,
          }),
        ),
      ),
    ];
    expect(conflicts.map((error) => StoreConflictError.is(error))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect((conflicts[1] as StoreConflictError).has('memberCode')).toBe(true);
    expect((conflicts[2] as StoreConflictError).has('email')).toBe(true);
  });

  it('refuses to publish outside a unit of work and returns copies', async () => {
    const store = new InMemoryIdentityStore(() => now);
    const seeded = store.seedUser({ id: 'u-1', phone: '+380501234567', memberCode: '734211800' });
    seeded.firstName = 'Mutated';
    await expect(store.findUserById('u-1')).resolves.toMatchObject({ firstName: null });
    await expect(
      (store.bind() as unknown as { publish: (event: unknown) => Promise<void> }).publish({}),
    ).rejects.toThrow(/inside run/);
  });
});
