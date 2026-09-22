export type PrivacyIdentifierDomain =
  'redis-phone' | 'redis-ip' | 'redis-device' | 'log-phone' | 'account-operation';

export interface PrivacyIdentifierSecretProvider {
  getPrivacyIdentifierSecret(kmsKeyReference: string): Promise<Uint8Array>;
}

export interface PrivacyIdentifierHasher {
  hash(domain: PrivacyIdentifierDomain, rawIdentifier: string): Promise<string>;
}

export interface VersionedPrivacyIdentifierDigest {
  readonly digest: string;
  readonly keyVersion: string;
}

export interface VersionedPrivacyIdentifierHasher extends PrivacyIdentifierHasher {
  hashCurrent(
    domain: PrivacyIdentifierDomain,
    rawIdentifier: string,
  ): Promise<VersionedPrivacyIdentifierDigest>;
  hashCandidates(
    domain: PrivacyIdentifierDomain,
    rawIdentifier: string,
  ): Promise<readonly VersionedPrivacyIdentifierDigest[]>;
}
