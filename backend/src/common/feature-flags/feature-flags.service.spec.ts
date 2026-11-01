import type { PrismaService } from '../prisma/prisma.service';
import { FakeClock } from '../time/clock';
import { FEATURE_FLAG_CACHE_TTL_MS, FeatureFlagsService } from './feature-flags.service';

function fakePrisma(rows: Record<string, { enabled: boolean; payload: unknown } | undefined>) {
  const findUnique = jest.fn(({ where }: { where: { key: string } }) => {
    const row = rows[where.key];
    return Promise.resolve(
      row
        ? { key: where.key, enabled: row.enabled, payload: row.payload, updatedAt: new Date(0) }
        : null,
    );
  });
  return { prisma: { featureFlag: { findUnique } } as unknown as PrismaService, findUnique };
}

describe('FeatureFlagsService', () => {
  it('reads flags and applies the fallback for missing rows', async () => {
    const { prisma } = fakePrisma({
      'parking.info_mode': { enabled: true, payload: { note: 'timer' } },
      'receipts.manual_submission': { enabled: false, payload: [1, 2] },
    });
    const service = new FeatureFlagsService(prisma, new FakeClock());

    await expect(service.isEnabled('parking.info_mode')).resolves.toBe(true);
    await expect(service.isEnabled('receipts.manual_submission', true)).resolves.toBe(false);
    await expect(service.isEnabled('missing.flag')).resolves.toBe(false);
    await expect(service.isEnabled('missing.flag', true)).resolves.toBe(true);
    await expect(service.get('parking.info_mode')).resolves.toMatchObject({
      key: 'parking.info_mode',
      enabled: true,
      payload: { note: 'timer' },
    });
    // non-object payloads are normalised to null
    await expect(service.get('receipts.manual_submission')).resolves.toMatchObject({
      payload: null,
    });
  });

  it('caches values for the TTL and honours invalidate()', async () => {
    const clock = new FakeClock();
    const { prisma, findUnique } = fakePrisma({
      'events.registration': { enabled: true, payload: null },
    });
    const service = new FeatureFlagsService(prisma, clock);

    await service.isEnabled('events.registration');
    await service.isEnabled('events.registration');
    expect(findUnique).toHaveBeenCalledTimes(1);

    clock.advance(FEATURE_FLAG_CACHE_TTL_MS + 1);
    await service.isEnabled('events.registration');
    expect(findUnique).toHaveBeenCalledTimes(2);

    service.invalidate('events.registration');
    await service.isEnabled('events.registration');
    expect(findUnique).toHaveBeenCalledTimes(3);

    service.invalidate();
    await service.isEnabled('events.registration');
    expect(findUnique).toHaveBeenCalledTimes(4);
  });
});
