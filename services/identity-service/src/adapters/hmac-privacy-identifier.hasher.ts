import { createHmac } from 'node:crypto';

import { versionedKmsReferenceVersion } from '../domain/kms-reference.js';
import type {
  PrivacyIdentifierDomain,
  PrivacyIdentifierSecretProvider,
  VersionedPrivacyIdentifierDigest,
  VersionedPrivacyIdentifierHasher,
} from '../ports/privacy-identifier.js';

export class HmacPrivacyIdentifierHasher implements VersionedPrivacyIdentifierHasher {
  private readonly references: ReadonlyArray<{ reference: string; keyVersion: string }>;

  constructor(
    private readonly secretProvider: PrivacyIdentifierSecretProvider,
    kmsKeyReference: string,
    previousKmsKeyReferences: readonly string[] = [],
  ) {
    this.references = Object.freeze(
      [kmsKeyReference, ...previousKmsKeyReferences].map((reference) => ({
        reference,
        keyVersion: versionedKmsReferenceVersion(reference),
      })),
    );
    if (
      new Set(this.references.map(({ keyVersion }) => keyVersion)).size !== this.references.length
    ) {
      throw new Error('DUPLICATE_PRIVACY_IDENTIFIER_KEY_VERSION');
    }
  }

  async hash(domain: PrivacyIdentifierDomain, rawIdentifier: string): Promise<string> {
    return (await this.hashCurrent(domain, rawIdentifier)).digest;
  }

  hashCurrent(
    domain: PrivacyIdentifierDomain,
    rawIdentifier: string,
  ): Promise<VersionedPrivacyIdentifierDigest> {
    return this.hashWithReference(
      this.references[0] as { reference: string; keyVersion: string },
      domain,
      rawIdentifier,
    );
  }

  hashCandidates(
    domain: PrivacyIdentifierDomain,
    rawIdentifier: string,
  ): Promise<readonly VersionedPrivacyIdentifierDigest[]> {
    return Promise.all(
      this.references.map((reference) => this.hashWithReference(reference, domain, rawIdentifier)),
    );
  }

  private async hashWithReference(
    versionedReference: { readonly reference: string; readonly keyVersion: string },
    domain: PrivacyIdentifierDomain,
    rawIdentifier: string,
  ): Promise<VersionedPrivacyIdentifierDigest> {
    const secret = await this.secretProvider.getPrivacyIdentifierSecret(
      versionedReference.reference,
    );
    if (secret.byteLength < 32) throw new Error('PRIVACY_IDENTIFIER_SECRET_TOO_SHORT');
    const digest = createHmac('sha256', secret)
      .update('sms-privacy-v1\0')
      .update(domain)
      .update('\0')
      .update(rawIdentifier)
      .digest('hex');
    return Object.freeze({ digest, keyVersion: versionedReference.keyVersion });
  }
}
