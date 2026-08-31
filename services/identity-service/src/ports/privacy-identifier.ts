export type PrivacyIdentifierDomain = 'redis-phone' | 'redis-ip' | 'redis-device' | 'log-phone';

export interface PrivacyIdentifierSecretProvider {
  getPrivacyIdentifierSecret(kmsKeyReference: string): Promise<Uint8Array>;
}

export interface PrivacyIdentifierHasher {
  hash(domain: PrivacyIdentifierDomain, rawIdentifier: string): Promise<string>;
}
