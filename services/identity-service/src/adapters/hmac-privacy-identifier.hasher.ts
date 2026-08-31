import { createHmac } from 'node:crypto';

import { assertVersionedKmsReference } from '../domain/kms-reference.js';
import type {
  PrivacyIdentifierDomain,
  PrivacyIdentifierHasher,
  PrivacyIdentifierSecretProvider,
} from '../ports/privacy-identifier.js';

export class HmacPrivacyIdentifierHasher implements PrivacyIdentifierHasher {
  constructor(
    private readonly secretProvider: PrivacyIdentifierSecretProvider,
    private readonly kmsKeyReference: string,
  ) {
    assertVersionedKmsReference(kmsKeyReference);
  }

  async hash(domain: PrivacyIdentifierDomain, rawIdentifier: string): Promise<string> {
    const secret = await this.secretProvider.getPrivacyIdentifierSecret(this.kmsKeyReference);
    if (secret.byteLength < 32) throw new Error('PRIVACY_IDENTIFIER_SECRET_TOO_SHORT');
    return createHmac('sha256', secret)
      .update('sms-privacy-v1\0')
      .update(domain)
      .update('\0')
      .update(rawIdentifier)
      .digest('hex');
  }
}
