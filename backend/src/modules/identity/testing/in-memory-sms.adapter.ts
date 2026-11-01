import { DomainError } from '../../../common/errors/domain-error';
import { IdentityErrors } from '../domain/errors';
import { type SmsMessage, SmsPort } from '../services/sms.port';

/** Test double: keeps every message; `failNext()` simulates a gateway outage. */
export class InMemorySmsAdapter extends SmsPort {
  readonly sent: SmsMessage[] = [];
  private failures = 0;

  async send(message: SmsMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new DomainError(IdentityErrors.PC_OTP_DELIVERY_FAILED, 'Simulated SMS outage');
    }
    this.sent.push({ ...message });
  }

  failNext(times = 1): void {
    this.failures += times;
  }

  /** The code from the latest message to the phone (the only digit group of 4-8 in the text). */
  lastCode(phone: string): string {
    const message = [...this.sent].reverse().find((item) => item.phone === phone);
    const code = message ? /\b(\d{4,8})\b/.exec(message.text)?.[1] : undefined;
    if (!code) {
      throw new Error(`No OTP SMS was sent to ${phone}`);
    }
    return code;
  }
}
