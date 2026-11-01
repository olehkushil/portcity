import type { DeletionRunSummary, PurgeSummary } from '../services/account-deletion.service';

/** Job names on the `account-deletion` queue (brief section 9). */
export const ACCOUNT_DELETION_JOBS = {
  /** Daily: execute deletion requests past `executeAfter`, then purge old OTP challenges and tokens. */
  run: 'run',
  /** One request, e.g. re-run by an operator from the queue UI. */
  executeOne: 'execute-one',
} as const;

export type AccountDeletionJobName =
  (typeof ACCOUNT_DELETION_JOBS)[keyof typeof ACCOUNT_DELETION_JOBS];

export const ACCOUNT_DELETION_SCHEDULE_ID = 'account-deletion-daily';

export interface AccountDeletionRunDeps {
  batchSize: number;
  otpRetentionDays: number;
  refreshRetentionDays: number;
  executeDue: (limit: number) => Promise<DeletionRunSummary>;
  purge: (retention: { otpDays: number; refreshDays: number }) => Promise<PurgeSummary>;
  log: (message: string) => void;
}

export interface AccountDeletionRunResult {
  deletion: DeletionRunSummary;
  purge: PurgeSummary | null;
  purgeError: string | null;
}

/**
 * Handler of the daily run. Deletions go first (each request in its own transaction, failures
 * are collected, not thrown, so one bad row does not block the rest); housekeeping follows and
 * its failure is reported without failing the job. The job fails only when every due request
 * failed, so BullMQ retries a systemic problem (database down) but not a single poisoned row.
 */
export async function runAccountDeletion(
  deps: AccountDeletionRunDeps,
): Promise<AccountDeletionRunResult> {
  const deletion = await deps.executeDue(deps.batchSize);
  deps.log(
    `account-deletion: due=${deletion.due} executed=${deletion.executed} skipped=${deletion.skipped} failed=${deletion.failed}`,
  );

  let purge: PurgeSummary | null = null;
  let purgeError: string | null = null;
  try {
    purge = await deps.purge({
      otpDays: deps.otpRetentionDays,
      refreshDays: deps.refreshRetentionDays,
    });
    deps.log(
      `account-deletion: purged otpChallenges=${purge.otpChallenges} refreshTokens=${purge.refreshTokens}`,
    );
  } catch (error) {
    purgeError = error instanceof Error ? error.message : String(error);
    deps.log(`account-deletion: purge failed: ${purgeError}`);
  }

  if (deletion.due > 0 && deletion.failed === deletion.due) {
    throw new Error(
      `account-deletion: all ${deletion.due} due requests failed; first error: ${deletion.failures[0]?.error ?? 'unknown'}`,
    );
  }
  return { deletion, purge, purgeError };
}

export interface ExecuteOneJobData {
  requestId: string;
}

export function isExecuteOneJobData(data: unknown): data is ExecuteOneJobData {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as Record<string, unknown>)['requestId'] === 'string'
  );
}
