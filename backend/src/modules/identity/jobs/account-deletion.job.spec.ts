import type { DeletionRunSummary } from '../services/account-deletion.service';
import {
  type AccountDeletionRunDeps,
  isExecuteOneJobData,
  runAccountDeletion,
} from './account-deletion.job';

function summary(overrides: Partial<DeletionRunSummary> = {}): DeletionRunSummary {
  return { due: 0, executed: 0, skipped: 0, failed: 0, failures: [], ...overrides };
}

function deps(overrides: Partial<AccountDeletionRunDeps> = {}): AccountDeletionRunDeps {
  return {
    batchSize: 50,
    otpRetentionDays: 7,
    refreshRetentionDays: 60,
    executeDue: jest.fn().mockResolvedValue(summary({ due: 2, executed: 2 })),
    purge: jest.fn().mockResolvedValue({ otpChallenges: 5, refreshTokens: 3 }),
    log: jest.fn(),
    ...overrides,
  };
}

describe('runAccountDeletion', () => {
  it('executes due requests in a batch and purges old rows', async () => {
    const d = deps();
    const result = await runAccountDeletion(d);
    expect(d.executeDue).toHaveBeenCalledWith(50);
    expect(d.purge).toHaveBeenCalledWith({ otpDays: 7, refreshDays: 60 });
    expect(result).toEqual({
      deletion: summary({ due: 2, executed: 2 }),
      purge: { otpChallenges: 5, refreshTokens: 3 },
      purgeError: null,
    });
    expect(d.log).toHaveBeenCalledTimes(2);
  });

  it('reports a purge failure without failing the job', async () => {
    const d = deps({ purge: jest.fn().mockRejectedValue(new Error('lock timeout')) });
    const result = await runAccountDeletion(d);
    expect(result.purge).toBeNull();
    expect(result.purgeError).toBe('lock timeout');
  });

  it('tolerates a single failing request but fails when every request failed', async () => {
    const partial = deps({
      executeDue: jest
        .fn()
        .mockResolvedValue(
          summary({ due: 2, executed: 1, failed: 1, failures: [{ requestId: 'r1', error: 'x' }] }),
        ),
    });
    await expect(runAccountDeletion(partial)).resolves.toBeDefined();

    const total = deps({
      executeDue: jest
        .fn()
        .mockResolvedValue(
          summary({ due: 1, failed: 1, failures: [{ requestId: 'r1', error: 'db down' }] }),
        ),
    });
    await expect(runAccountDeletion(total)).rejects.toThrow(
      /all 1 due requests failed; first error: db down/,
    );
  });

  it('succeeds when nothing is due', async () => {
    const d = deps({ executeDue: jest.fn().mockResolvedValue(summary()) });
    await expect(runAccountDeletion(d)).resolves.toMatchObject({ deletion: { due: 0 } });
  });
});

describe('isExecuteOneJobData', () => {
  it.each([
    [{ requestId: 'r-1' }, true],
    [{ requestId: 1 }, false],
    [null, false],
    ['r-1', false],
  ])('%p -> %p', (data, expected) => {
    expect(isExecuteOneJobData(data)).toBe(expected);
  });
});
