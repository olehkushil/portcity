import type { PushSendResult } from '../../domain/push-delivery.machine';
import type { PushMessage } from '../../domain/push-message';

export type { PushMessage } from '../../domain/push-message';
export type { PushFailureCode, PushSendResult } from '../../domain/push-delivery.machine';

/**
 * Port to the push provider (brief section 2: "push port + FCM stub").
 * Implementations: StubPushAdapter (development, tests) and FcmPushAdapter (FCM HTTP v1).
 * The abstract class doubles as the Nest injection token, like StoragePort.
 */
export abstract class PushPort {
  /** Stored in PushDelivery.provider. */
  abstract readonly provider: string;

  /**
   * Sends one message to one device token. Never throws for per-message problems (they come
   * back as `{ ok: false }`); a thrown error means the provider itself is unreachable and the
   * job may be retried.
   */
  abstract send(message: PushMessage): Promise<PushSendResult>;
}
