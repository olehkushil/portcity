import { IDENTITY_EVENTS, RECEIPT_EVENTS } from '../../../common/contracts/events';
import type { OutboxJobData } from '../../../common/outbox/outbox.types';
import type { WelcomeKind } from '../domain/welcome';

export interface ProfileFieldBonusResult {
  status: 'handled' | 'ignored';
  granted: Array<{ kind: 'field' | 'complete'; amount: number; txId: string }>;
  skipped: Array<{ kind: 'field' | 'complete'; reason: 'already_granted' }>;
}

export interface ClubEventsDeps {
  ensureAccount(userId: string, registeredAt: Date): Promise<{ created: boolean }>;
  grantWelcome(
    userId: string,
    kind: WelcomeKind,
    options: { sourceId?: string; registeredAt?: Date },
  ): Promise<{ granted: boolean; amount: number; txId: string | null }>;
  grantProfileFieldBonus(
    userId: string,
    field: string,
    completedAll: boolean,
  ): Promise<ProfileFieldBonusResult>;
  log(message: string): void;
}

export type ClubEventOutcome =
  | {
      status: 'handled';
      event: string;
      userId: string;
      accountCreated: boolean;
      welcome: { kind: WelcomeKind; granted: boolean; amount: number; txId: string | null } | null;
      profileBonus?: ProfileFieldBonusResult;
    }
  | { status: 'ignored'; event: string; reason: string };

function stringField(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function dateField(payload: Record<string, unknown>, field: string, fallback: string): Date {
  const raw = stringField(payload, field) ?? fallback;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? new Date(fallback) : date;
}

/**
 * Consumer of `club-events` (brief section 3): the account is created when the user registers
 * and the welcome bonuses are granted on registration, a completed profile and the first
 * credited receipt. Idempotent by construction: account creation is `ON CONFLICT DO NOTHING`,
 * each welcome bonus has a fixed ledger key and a flag on the account.
 */
export async function handleClubEvent(
  name: string,
  data: OutboxJobData,
  deps: ClubEventsDeps,
): Promise<ClubEventOutcome> {
  const payload = data.payload ?? {};
  const userId = stringField(payload, 'userId');
  if (!userId) {
    return { status: 'ignored', event: name, reason: 'payload has no userId' };
  }

  switch (name) {
    case IDENTITY_EVENTS.registered: {
      const registeredAt = dateField(payload, 'registeredAt', data.occurredAt);
      const { created } = await deps.ensureAccount(userId, registeredAt);
      const welcome = await deps.grantWelcome(userId, 'register', { registeredAt });
      deps.log(
        `user.registered ${userId}: account ${created ? 'created' : 'exists'}, welcome ${welcome.granted ? welcome.amount : 0}`,
      );
      return {
        status: 'handled',
        event: name,
        userId,
        accountCreated: created,
        welcome: { kind: 'register', ...welcome },
      };
    }
    case IDENTITY_EVENTS.profileCompleted: {
      const welcome = await deps.grantWelcome(userId, 'profile', {});
      return {
        status: 'handled',
        event: name,
        userId,
        accountCreated: false,
        welcome: { kind: 'profile', ...welcome },
      };
    }
    case IDENTITY_EVENTS.profileFieldCompleted: {
      const field = stringField(payload, 'field');
      if (!field) {
        return { status: 'ignored', event: name, reason: 'payload has no field' };
      }
      // `allFieldsCompleted` is the contract name; `completedAll` is accepted as an alias.
      const completedAll = payload.allFieldsCompleted === true || payload.completedAll === true;
      const profileBonus = await deps.grantProfileFieldBonus(userId, field, completedAll);
      if (profileBonus.status === 'ignored') {
        return { status: 'ignored', event: name, reason: `unknown profile field "${field}"` };
      }
      deps.log(
        `user.profile_field_completed ${userId}/${field}: granted ${profileBonus.granted
          .map((grant) => `${grant.kind}+${grant.amount}`)
          .join(', ')}`,
      );
      return {
        status: 'handled',
        event: name,
        userId,
        accountCreated: false,
        welcome: null,
        profileBonus,
      };
    }
    case RECEIPT_EVENTS.credited: {
      if (payload.firstReceipt !== true) {
        return { status: 'ignored', event: name, reason: 'not the first receipt' };
      }
      const receiptId = stringField(payload, 'receiptId');
      const welcome = await deps.grantWelcome(
        userId,
        'firstReceipt',
        receiptId ? { sourceId: receiptId } : {},
      );
      return {
        status: 'handled',
        event: name,
        userId,
        accountCreated: false,
        welcome: { kind: 'firstReceipt', ...welcome },
      };
    }
    default:
      return { status: 'ignored', event: name, reason: 'event is not consumed by club' };
  }
}
