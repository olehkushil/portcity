import {
  SUPPORT_REQUESTS_PER_DAY,
  type SupportRequestStatus,
} from '../../../common/contracts/admin';
import { DomainError } from '../../../common/errors/domain-error';
import { AdminErrors } from './errors';

/**
 * Support request rules ("Звернення", prototype screen support):
 *
 *   new -> in_progress | resolved | closed
 *   in_progress -> resolved | closed
 *   resolved -> in_progress (reopened) | closed
 *   closed: final
 *
 * A PATCH with the current status only updates the note. A member may send
 * SUPPORT_REQUESTS_PER_DAY requests per Kyiv calendar day.
 */

function statuses(...list: SupportRequestStatus[]): readonly SupportRequestStatus[] {
  return Object.freeze(list);
}

export const SUPPORT_TRANSITIONS: Readonly<
  Record<SupportRequestStatus, readonly SupportRequestStatus[]>
> = Object.freeze({
  new: statuses('in_progress', 'resolved', 'closed'),
  in_progress: statuses('resolved', 'closed'),
  resolved: statuses('in_progress', 'closed'),
  closed: statuses(),
});

export function canChangeSupportStatus(
  from: SupportRequestStatus,
  to: SupportRequestStatus,
): boolean {
  return from === to ? from !== 'closed' : SUPPORT_TRANSITIONS[from].includes(to);
}

export function assertSupportStatusChange(
  requestId: string,
  from: SupportRequestStatus,
  to: SupportRequestStatus,
): void {
  if (!canChangeSupportStatus(from, to)) {
    throw new DomainError(
      AdminErrors.PC_SUPPORT_REQUEST_INVALID_TRANSITION,
      `Support request ${requestId} cannot move from "${from}" to "${to}"`,
      { details: { requestId, from, to, allowed: SUPPORT_TRANSITIONS[from] } },
    );
  }
}

/** resolved and closed requests carry who decided them and when. */
export function isDecidedSupportStatus(status: SupportRequestStatus): boolean {
  return status === 'resolved' || status === 'closed';
}

export function remainingSupportRequests(
  sentToday: number,
  limit = SUPPORT_REQUESTS_PER_DAY,
): number {
  return Math.max(limit - sentToday, 0);
}

/** Photos are uploaded under `support/<userId>/...`, so a member can attach only own uploads. */
export function supportPhotoPrefix(userId: string): string {
  return `support/${userId}`;
}

export function isOwnSupportPhotoKey(userId: string, key: string): boolean {
  return key.startsWith(`${supportPhotoPrefix(userId)}/`) && !key.includes('..');
}

/** Image types accepted for a support photo and the size cap (5 MB, like receipt photos). */
export const SUPPORT_PHOTO_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const;
export type SupportPhotoContentType = (typeof SUPPORT_PHOTO_CONTENT_TYPES)[number];
export const SUPPORT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const SUPPORT_PHOTO_UPLOAD_TTL_SECONDS = 600;
export const SUPPORT_PHOTO_VIEW_TTL_SECONDS = 900;

export function isSupportPhotoContentType(value: string): value is SupportPhotoContentType {
  return (SUPPORT_PHOTO_CONTENT_TYPES as readonly string[]).includes(value.toLowerCase());
}
