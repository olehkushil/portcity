import { Logger } from '@nestjs/common';
import { DomainError } from '../../../common/errors/domain-error';
import { maskPhone } from '../../../common/phone/phone';
import { IdentityErrors } from '../domain/errors';
import { type SmsMessage, SmsPort } from './sms.port';

export interface TurboSmsOptions {
  apiUrl: string;
  token: string;
  sender: string;
  timeoutMs: number;
  /** Injected for tests; defaults to the global fetch of Node 24. */
  fetchFn?: typeof fetch;
}

/**
 * Codes TurboSMS documents as success: 0 (OK) and the 8xx family
 * (SUCCESS_MESSAGE_ACCEPTED, SUCCESS_MESSAGE_SENT, ...). Everything else is a failure.
 */
export function isTurboSmsSuccess(code: unknown): boolean {
  return typeof code === 'number' && (code === 0 || (code >= 800 && code < 900));
}

interface TurboSmsResultItem {
  phone?: string;
  response_code?: number;
  response_status?: string;
  message_id?: string | null;
}

interface TurboSmsResponse {
  response_code?: number;
  response_status?: string;
  response_result?: TurboSmsResultItem[] | null;
}

/**
 * TurboSMS (turbosms.ua) HTTP API adapter: `POST message/send.json` with a Bearer token and
 * `{ recipients: ["380..."], sms: { sender, text } }`. Written from the public API description;
 * it has not been exercised against a live account yet (README, open questions), so it fails
 * loudly with PC_OTP_DELIVERY_FAILED on anything it does not recognise as success.
 */
export class TurboSmsAdapter extends SmsPort {
  private readonly logger = new Logger('TurboSmsAdapter');
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: TurboSmsOptions) {
    super();
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async send(message: SmsMessage): Promise<void> {
    const recipient = message.phone.replace(/^\+/, '');
    let response: Response;
    try {
      response = await this.fetchFn(this.options.apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          recipients: [recipient],
          sms: { sender: this.options.sender, text: message.text },
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      this.logger.error(
        `TurboSMS request for ${maskPhone(message.phone)} failed: ${(error as Error).message}`,
      );
      throw this.failure('gateway_unreachable', error);
    }

    let body: TurboSmsResponse | null = null;
    try {
      body = (await response.json()) as TurboSmsResponse;
    } catch {
      body = null;
    }
    const item = body?.response_result?.[0];
    const ok =
      response.ok &&
      isTurboSmsSuccess(body?.response_code) &&
      (item === undefined || isTurboSmsSuccess(item.response_code));
    if (!ok) {
      const status = item?.response_status ?? body?.response_status ?? `HTTP ${response.status}`;
      this.logger.error(`TurboSMS rejected the message for ${maskPhone(message.phone)}: ${status}`);
      throw this.failure(status);
    }
  }

  private failure(reason: string, cause?: unknown): DomainError {
    return new DomainError(IdentityErrors.PC_OTP_DELIVERY_FAILED, 'SMS could not be delivered', {
      details: { provider: 'turbosms', reason },
      cause,
    });
  }
}
