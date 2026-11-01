import { uuidv7 } from 'uuidv7';
import type { ConsentOp } from '../domain/consents';
import type { IdentityUow } from './identity.store';

/** Applies the operations planned by `planConsentChanges` inside the caller's unit of work. */
export async function applyConsentOps(
  uow: IdentityUow,
  userId: string,
  ops: readonly ConsentOp[],
  now: Date,
): Promise<void> {
  for (const op of ops) {
    if (op.kind === 'grant') {
      await uow.createConsent({
        id: uuidv7(),
        userId,
        purpose: op.purpose,
        version: op.version,
        grantedAt: now,
      });
    } else {
      await uow.revokeConsent(op.consentId, now);
    }
  }
}
