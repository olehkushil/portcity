import type { AppConfig } from '../../../common/config';
import type { IdentityConfig } from '../identity.config';
import { LogSmsAdapter, type SmsPort } from './sms.port';
import { TurboSmsAdapter } from './turbosms.adapter';

/** Picks the SMS adapter from SMS_PROVIDER (identity env section). */
export function createSmsAdapter(identity: IdentityConfig, app: AppConfig): SmsPort {
  if (identity.SMS_PROVIDER === 'turbosms') {
    if (!identity.TURBOSMS_TOKEN) {
      throw new Error('TURBOSMS_TOKEN is required when SMS_PROVIDER=turbosms');
    }
    return new TurboSmsAdapter({
      apiUrl: identity.TURBOSMS_API_URL,
      token: identity.TURBOSMS_TOKEN,
      sender: identity.TURBOSMS_SENDER,
      timeoutMs: identity.TURBOSMS_TIMEOUT_MS,
    });
  }
  return new LogSmsAdapter(app);
}
