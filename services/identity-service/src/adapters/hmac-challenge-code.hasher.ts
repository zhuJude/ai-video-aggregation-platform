import { createHmac } from 'node:crypto';

import { assertVersionedKmsReference } from '../domain/kms-reference.js';
import type { ChallengeCodeHasher, ChallengeSecretProvider } from '../ports/challenge-secret.js';

export class HmacChallengeCodeHasher implements ChallengeCodeHasher {
  constructor(
    private readonly secretProvider: ChallengeSecretProvider,
    private readonly kmsKeyReference: string,
  ) {
    assertVersionedKmsReference(kmsKeyReference, 'SMS_CHALLENGE_VERSIONED_KMS_REFERENCE_REQUIRED');
  }

  async hash(phoneHash: string, code: string): Promise<string> {
    const secret = await this.secretProvider.getSecret(this.kmsKeyReference);
    if (secret.byteLength < 32) {
      throw new Error('SMS_CHALLENGE_SECRET_TOO_SHORT');
    }

    return createHmac('sha256', secret).update(phoneHash).update(':').update(code).digest('hex');
  }
}
