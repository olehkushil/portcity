import type { DeviceSummary, UserStatus } from '../../../common/contracts/identity';
import type {
  NotificationChannel,
  NotificationKind,
} from '../../../common/contracts/notifications';
import { defaultChannelFor, isMarketingKind } from './kinds';

export type DeliverySkipReason =
  'user_missing' | 'user_inactive' | 'preference_disabled' | 'consent_missing';

export interface DeliveryDecisionInput {
  kind: NotificationKind;
  /** Null when the identity port does not know the user. */
  userStatus: UserStatus | null;
  /** Stored preference; null when the member never changed it (enabled). */
  preferenceEnabled: boolean | null;
  /** Result of the marketing consent lookup; ignored for service kinds. */
  hasMarketingConsent: boolean | null;
  requestedChannel?: NotificationChannel | null;
}

export type DeliveryDecision =
  { deliver: true; channel: NotificationChannel } | { deliver: false; reason: DeliverySkipReason };

/**
 * Decides whether a notification is stored at all and through which channel
 * (brief section 4 and the NotificationsPort contract: disabled preference or a missing
 * marketing consent yield null). Pure, table-tested.
 */
export function decideDelivery(input: DeliveryDecisionInput): DeliveryDecision {
  if (input.userStatus === null) {
    return { deliver: false, reason: 'user_missing' };
  }
  if (input.userStatus !== 'active') {
    return { deliver: false, reason: 'user_inactive' };
  }
  if (isMarketingKind(input.kind) && input.hasMarketingConsent !== true) {
    return { deliver: false, reason: 'consent_missing' };
  }
  if (input.preferenceEnabled === false) {
    return { deliver: false, reason: 'preference_disabled' };
  }
  return { deliver: true, channel: input.requestedChannel ?? defaultChannelFor(input.kind) };
}

/** In-app only notifications are "sent" the moment they are stored; push ones after the job. */
export function initialSentAt(channel: NotificationChannel, now: Date): Date | null {
  return channel === 'inapp' ? now : null;
}

export function needsPush(channel: NotificationChannel): boolean {
  return channel === 'push' || channel === 'both';
}

/**
 * Devices that should receive the push: push enabled, token present, one delivery per token
 * (a reinstalled app may leave two device rows with the same token).
 */
export function selectPushTargets(devices: readonly DeviceSummary[]): DeviceSummary[] {
  const seen = new Set<string>();
  const targets: DeviceSummary[] = [];
  for (const device of devices) {
    const token = device.pushToken?.trim() ?? '';
    if (!device.pushEnabled || token === '' || seen.has(token)) {
      continue;
    }
    seen.add(token);
    targets.push(device);
  }
  return targets;
}
