/**
 * Outbox events consumed on the `admin-events` queue (job name = event type):
 * - `user.deleted` (identity anonymised the account after the cooling-off period): the photos of
 *   the member's support requests are deleted from object storage, the photo keys are cleared and
 *   the request texts are replaced with a neutral placeholder. Number, topic, related object,
 *   status and the staff note stay: they are the history of how the request was handled and do
 *   not identify the person once the owner row is anonymised.
 *
 * Idempotent: a replay finds no photo keys and no original text left to erase.
 */
import { IDENTITY_EVENTS } from '../../../common/contracts/events';
import { DomainError } from '../../../common/errors/domain-error';
import { QUEUES } from '../../../common/queue/queue.constants';

export const ADMIN_HANDLED_EVENTS = [IDENTITY_EVENTS.deleted] as const;

export const ADMIN_OUTBOX_ROUTES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(ADMIN_HANDLED_EVENTS.map((type) => [type, QUEUES.adminEvents])),
);

/** Replaces the text of a support request after account erasure (1-2000 characters, CHECK). */
export const ERASED_SUPPORT_MESSAGE_UK = 'Текст звернення видалено разом з акаунтом учасника.';

export interface AdminEventsDeps {
  /** Distinct photo keys of the member's support requests. */
  listSupportPhotoKeys(userId: string): Promise<string[]>;
  /** Deletes one stored object; a missing object may throw PC_STORAGE_OBJECT_NOT_FOUND. */
  deletePhoto(key: string): Promise<void>;
  /** Replaces message and clears photo_key of the member's support requests; returns the count. */
  eraseSupportRequests(userId: string, placeholder: string): Promise<number>;
  log?: (message: string) => void;
}

export interface AdminEventOutcome {
  type: string;
  action: 'erased' | 'ignored';
  photosDeleted: number;
  requestsUpdated: number;
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

const IGNORED = (type: string): AdminEventOutcome => ({
  type,
  action: 'ignored',
  photosDeleted: 0,
  requestsUpdated: 0,
});

/** Handler logic of the admin-events processor; plain function, unit tested. */
export async function handleAdminEventJob(
  name: string,
  data: unknown,
  deps: AdminEventsDeps,
): Promise<AdminEventOutcome> {
  if (name !== IDENTITY_EVENTS.deleted) {
    deps.log?.(`admin-events: ignoring unexpected job "${name}"`);
    return IGNORED(name);
  }
  const userId = payloadOf(data)['userId'];
  if (typeof userId !== 'string' || userId.length === 0) {
    deps.log?.('admin-events: user.deleted without userId ignored');
    return IGNORED(name);
  }

  // Objects first: if a deletion fails the job is retried and the keys are still in the table.
  let photosDeleted = 0;
  for (const key of await deps.listSupportPhotoKeys(userId)) {
    try {
      await deps.deletePhoto(key);
      photosDeleted += 1;
    } catch (error) {
      if (!isMissingObject(error)) {
        throw error;
      }
    }
  }
  const requestsUpdated = await deps.eraseSupportRequests(userId, ERASED_SUPPORT_MESSAGE_UK);
  deps.log?.(
    `admin-events: erased support requests of ${userId} (${photosDeleted} photos, ${requestsUpdated} requests)`,
  );
  return { type: name, action: 'erased', photosDeleted, requestsUpdated };
}
