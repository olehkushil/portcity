import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../common/config';
import { DomainError } from '../../../common/errors/domain-error';
import { maskPhone } from '../../../common/phone/phone';
import { IdentityErrors } from '../domain/errors';

export interface SmsMessage {
  /** E.164 */
  phone: string;
  text: string;
}

/**
 * Outbound SMS gateway (OTP codes). The abstract class is the injection token; adapters:
 * LogSmsAdapter (development), InMemorySmsAdapter (tests, ../testing/in-memory-sms.adapter.ts),
 * TurboSmsAdapter (turbosms.adapter.ts, SMS_PROVIDER=turbosms). Chosen by createSmsAdapter().
 */
export abstract class SmsPort {
  abstract send(message: SmsMessage): Promise<void>;
}

/**
 * Development adapter: writes the message to the log. In production it refuses to pretend
 * (PC_OTP_DELIVERY_FAILED) so a missing gateway is visible instead of silently losing codes.
 */
@Injectable()
export class LogSmsAdapter extends SmsPort {
  private readonly logger = new Logger('SmsPort');

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  async send(message: SmsMessage): Promise<void> {
    if (this.config.isProduction) {
      this.logger.error(
        `SMS_PROVIDER=log cannot deliver to ${maskPhone(message.phone)} in production; configure a gateway`,
      );
      throw new DomainError(
        IdentityErrors.PC_OTP_DELIVERY_FAILED,
        'SMS delivery is not configured on this server',
      );
    }
    this.logger.log(`SMS to ${message.phone}: ${message.text}`);
  }
}
