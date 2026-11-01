import type { User } from '@prisma/client';
import {
  IDENTITY_EVENTS,
  OUTBOX_AGGREGATES,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import {
  allProfileFieldsAnnounced,
  filledProfileFields,
  newlyCompletedFields,
} from '../domain/profile';
import type { IdentityUow } from './identity.store';

/**
 * Publishes `user.profile_field_completed` for every profile field that is filled now and was
 * never announced for this member, and records the announcement on the user row. The caller must
 * hold the user row lock (`uow.lockUser`) and pass the row read under it, so two parallel
 * updates cannot announce the same field twice. Returns the updated row.
 */
export async function announceCompletedProfileFields(
  uow: IdentityUow,
  user: User,
  now: Date,
): Promise<User> {
  const children = await uow.listChildren(user.id);
  const filled = filledProfileFields({ ...user, childrenCount: children.length });
  const added = newlyCompletedFields(filled, user.completedProfileFields);
  if (added.length === 0) {
    return user;
  }
  const announced = [...user.completedProfileFields, ...added];
  const updated = await uow.updateUser(user.id, { completedProfileFields: announced });
  const complete = allProfileFieldsAnnounced(announced);
  for (const [index, field] of added.entries()) {
    await uow.publish(
      buildOutboxEvent(IDENTITY_EVENTS.profileFieldCompleted, OUTBOX_AGGREGATES.user, user.id, {
        userId: user.id,
        field,
        completedAt: now.toISOString(),
        // Only the event that completes the set carries true (trigger for the completion bonus).
        allFieldsCompleted: complete && index === added.length - 1,
      }),
    );
  }
  return updated;
}
