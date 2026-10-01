import { SmsSender } from '../../application/ports';
import { Logger, maskPhone } from '../../shared/logging/logger';

/** "Sends" an SMS by logging it. The number is masked: logs are not a place for full phone numbers. */
export class LoggingSmsSender implements SmsSender {
  readonly sent: Array<{ to: string; text: string; idempotencyKey: string }> = [];

  constructor(private readonly logger: Logger) {}

  async send(sms: { to: string; text: string; idempotencyKey: string }): Promise<void> {
    this.sent.push(sms);
    this.logger.info('sms.sent', {
      to: maskPhone(sms.to),
      idempotencyKey: sms.idempotencyKey,
      textLength: sms.text.length,
    });
  }
}
