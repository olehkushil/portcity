import { type ClubLedgerPort, DEFAULT_LOYALTY_RULES } from '../../../common/contracts/club';
import { DomainError } from '../../../common/errors/domain-error';
import { FakeClock } from '../../../common/time/clock';
import { BASE_RATE_CACHE_MS, BaseRateService } from './base-rate.service';

function activeRules(baseRatePercent: number) {
  return {
    id: 'rs-1',
    version: 1,
    activeFrom: new Date('2026-01-01T00:00:00.000Z'),
    rules: { ...DEFAULT_LOYALTY_RULES, baseRatePercent },
  };
}

function setup(ledger: { getActiveRules: jest.Mock }) {
  const clock = new FakeClock('2026-11-01T10:00:00.000Z');
  const service = new BaseRateService(ledger as unknown as ClubLedgerPort, clock);
  return { service, clock };
}

describe('BaseRateService', () => {
  it('reads baseRatePercent of the active rule set from the club port', async () => {
    const ledger = { getActiveRules: jest.fn().mockResolvedValue(activeRules(4)) };
    const { service } = setup(ledger);
    await expect(service.getBaseRatePercent()).resolves.toBe(4);
    expect(ledger.getActiveRules).toHaveBeenCalledWith(new Date('2026-11-01T10:00:00.000Z'));
  });

  it('caches the value and refreshes it after the TTL', async () => {
    const ledger = {
      getActiveRules: jest
        .fn()
        .mockResolvedValueOnce(activeRules(4))
        .mockResolvedValueOnce(activeRules(6)),
    };
    const { service, clock } = setup(ledger);
    await service.getBaseRatePercent();
    clock.advance(BASE_RATE_CACHE_MS - 1);
    await expect(service.getBaseRatePercent()).resolves.toBe(4);
    expect(ledger.getActiveRules).toHaveBeenCalledTimes(1);
    clock.advance(1);
    await expect(service.getBaseRatePercent()).resolves.toBe(6);
    service.invalidate();
    ledger.getActiveRules.mockResolvedValueOnce(activeRules(7));
    await expect(service.getBaseRatePercent()).resolves.toBe(7);
  });

  it('falls back to the contract default when the ledger fails', async () => {
    const ledger = {
      getActiveRules: jest
        .fn()
        .mockRejectedValue(
          new DomainError('PC_COMMON_SERVICE_UNAVAILABLE', 'database down', { status: 503 }),
        ),
    };
    const { service } = setup(ledger);
    await expect(service.getBaseRatePercent()).resolves.toBe(DEFAULT_LOYALTY_RULES.baseRatePercent);
  });

  it('ignores a negative or non-numeric rate', async () => {
    const ledger = { getActiveRules: jest.fn().mockResolvedValue(activeRules(-1)) };
    const { service } = setup(ledger);
    await expect(service.getBaseRatePercent()).resolves.toBe(3);
  });
});
