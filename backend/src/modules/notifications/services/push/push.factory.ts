import { Logger } from '@nestjs/common';
import type { Clock } from '../../../../common/time/clock';
import type { NotificationsConfig } from '../notifications.config';
import {
  type AccessTokenProvider,
  ServiceAccountTokenProvider,
  StaticAccessTokenProvider,
  parseServiceAccount,
} from './fcm-access-token';
import { FcmPushAdapter } from './fcm-push.adapter';
import type { PushPort } from './push.port';
import { StubPushAdapter } from './stub-push.adapter';

/** Chooses the PushPort implementation from the validated environment slice. */
export function createPushAdapter(config: NotificationsConfig, clock: Clock): PushPort {
  const logger = new Logger('NotificationsModule');
  if (config.PUSH_PROVIDER === 'fcm') {
    const tokens = createTokenProvider(config, clock);
    const projectId = config.FCM_PROJECT_ID ?? null;
    const adapter = new FcmPushAdapter({
      projectId,
      tokens,
      endpoint: config.FCM_ENDPOINT,
      timeoutMs: config.FCM_TIMEOUT_MS,
    });
    if (!adapter.configured) {
      logger.warn(
        'PUSH_PROVIDER=fcm without FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_JSON/FCM_ACCESS_TOKEN: pushes will be skipped',
      );
    }
    return adapter;
  }
  return new StubPushAdapter((message) => logger.debug(message));
}

function createTokenProvider(config: NotificationsConfig, clock: Clock): AccessTokenProvider {
  if (config.FCM_SERVICE_ACCOUNT_JSON) {
    return new ServiceAccountTokenProvider(parseServiceAccount(config.FCM_SERVICE_ACCOUNT_JSON), {
      now: () => clock.now(),
      timeoutMs: config.FCM_TIMEOUT_MS,
    });
  }
  return new StaticAccessTokenProvider(config.FCM_ACCESS_TOKEN ?? null);
}
