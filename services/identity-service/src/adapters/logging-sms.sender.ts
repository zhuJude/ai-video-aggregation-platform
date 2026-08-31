import type { PrivacyIdentifierHasher } from '../ports/privacy-identifier.js';
import type { SmsSender } from '../ports/sms-sender.js';

export interface SmsLogger {
  info(message: string, fields: { phoneHash: string; templateKey: string }): void;
}

export class LoggingSmsSender implements SmsSender {
  constructor(
    appEnv: string | undefined,
    private readonly templateKey: string,
    private readonly logger: SmsLogger,
    private readonly privacyIdentifierHasher: PrivacyIdentifierHasher,
  ) {
    if (appEnv !== 'local') throw new Error('LOGGING_SMS_SENDER_LOCAL_ONLY');
    if (templateKey.trim().length === 0) throw new Error('SMS_TEMPLATE_KEY_REQUIRED');
  }

  async sendCode(phoneE164: string, code: string): Promise<void> {
    if (!/^\+861[3-9]\d{9}$/.test(phoneE164)) throw stableError('INVALID_PHONE');
    if (!/^\d{6}$/.test(code)) throw stableError('INVALID_SMS_CODE');

    this.logger.info('Local SMS challenge requested', {
      phoneHash: await this.privacyIdentifierHasher.hash('log-phone', phoneE164),
      templateKey: this.templateKey,
    });
  }
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
