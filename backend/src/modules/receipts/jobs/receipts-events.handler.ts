/**
 * Outbox events consumed on the `receipts-events` queue (job name = event type):
 * - `user.deleted` (identity anonymised the account after the cooling-off period): receipt and
 *   appeal photos are deleted from object storage, photo keys are cleared and appeal texts are
 *   replaced with a neutral placeholder. Fiscal data (fn, fiscalId, totals, rawQr) stays: it is
 *   needed for duplicate detection and accounting and does not identify the person once the
 *   owner row is anonymised.
 *
 * Idempotent: a replay finds no photo keys and no appeal text left to erase.
 */
import { IDENTITY_EVENTS } from '../../../common/contracts/events';
import { DomainError } from '../../../common/errors/domain-error';
import { QUEUES } from '../../../common/queue/queue.constants';

export const RECEIPTS_HANDLED_EVENTS = [IDENTITY_EVENTS.deleted] as const;

export const RECEIPTS_OUTBOX_ROUTES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(RECEIPTS_HANDLED_EVENTS.map((type) => [type, QUEUES.receiptsEvents])),
);

/** Replaces the member's appeal texts after account erasure. */
export const ERASED_APPEAL_MESSAGE_UK = 'Текст звернення видалено разом з акаунтом учасника.';

export interface ReceiptsEventsDeps {
  /** Distinct photo keys of the member's receipts and appeals. */
  listPhotoKeys(userId: string): Promise<string[]>;
  /** Deletes one stored object; a missing object may throw PC_STORAGE_OBJECT_NOT_FOUND. */
  deletePhoto(key: string): Promise<void>;
  /** Clears photo keys and appeal texts in the receipts tables. */
  erase(userId: string, appealPlaceholder: string): Promise<{ receipts: number; appeals: number }>;
  log?: (message: string) => void;
}

export interface ReceiptsEventOutcome {
  type: string;
  action: 'erased' | 'ignored';
  photosDeleted: number;
  receiptsUpdated: number;
  appealsUpdated: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accepts the outbox job data (`{ eventId, type, payload, ... }`) or a bare payload. */
function payloadOf(data: unknown): Record<string, unknown> {
  if (isRecord(data) && isRecord(data['payload'])) {
    return data['payload'];
  }
  return isRecord(data) ? data : {};
}

function isMissingObject(error: unknown): boolean {
  return DomainError.is(error) && error.code === 'PC_STORAGE_OBJECT_NOT_FOUND';
}

const IGNORED = (type: string): ReceiptsEventOutcome => ({
  type,
  action: 'ignored',
  photosDeleted: 0,
  receiptsUpdated: 0,
  appealsUpdated: 0,
});

/** Handler logic of the receipts-events processor; plain function, unit tested. */
export async function handleReceiptsEventJob(
  name: string,
  data: unknown,
  deps: ReceiptsEventsDeps,
): Promise<ReceiptsEventOutcome> {
  if (name !== IDENTITY_EVENTS.deleted) {
    deps.log?.(`receipts-events: ignoring unexpected job "${name}"`);
    return IGNORED(name);
  }
  const userId = payloadOf(data)['userId'];
  if (typeof userId !== 'string' || userId.length === 0) {
    deps.log?.('receipts-events: user.deleted without userId ignored');
    return IGNORED(name);
  }

  // Objects first: if a deletion fails the job is retried and the keys are still in the table.
  let photosDeleted = 0;
  for (const key of await deps.listPhotoKeys(userId)) {
    try {
      await deps.deletePhoto(key);
      photosDeleted += 1;
    } catch (error) {
      if (!isMissingObject(error)) {
        throw error;
      }
    }
  }
  const erased = await deps.erase(userId, ERASED_APPEAL_MESSAGE_UK);
  deps.log?.(
    `receipts-events: erased personal data of ${userId} (${photosDeleted} photos, ${erased.receipts} receipts, ${erased.appeals} appeals)`,
  );
  return {
    type: name,
    action: 'erased',
    photosDeleted,
    receiptsUpdated: erased.receipts,
    appealsUpdated: erased.appeals,
  };
}
