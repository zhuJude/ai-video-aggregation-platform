import type { SecretCipher } from '../ports/secret-cipher.js';

export type KmsWorkloadIdentity =
  | { readonly mode: 'ecs_ram_role'; readonly roleName: string }
  | {
      readonly mode: 'oidc_role_arn';
      readonly roleArn: string;
      readonly oidcProviderArn: string;
      readonly clientId: string;
    };
export interface KmsCryptographyClient {
  encrypt(input: {
    readonly keyReference: string;
    readonly plaintext: string;
    readonly aad: string;
    readonly identity: KmsWorkloadIdentity;
  }): Promise<string>;
  decrypt(input: {
    readonly keyReference: string;
    readonly ciphertext: string;
    readonly aad: string;
    readonly identity: KmsWorkloadIdentity;
  }): Promise<string>;
}
export interface KmsSecretCipherOptions {
  readonly keyReference?: string;
  readonly currentKeyReference?: string;
  readonly previousKeyReferences?: readonly string[];
  readonly identity: KmsWorkloadIdentity;
}
const V2 = 'aliyun-kms.v2';

export class KmsSecretCipher implements SecretCipher {
  private readonly currentKeyReference: string;
  private readonly previousKeyReferences: readonly string[];
  private readonly identity: KmsWorkloadIdentity;
  constructor(
    private readonly client: KmsCryptographyClient,
    options: KmsSecretCipherOptions,
  ) {
    try {
      const legacy = Reflect.get(options, 'keyReference') as unknown;
      const current = Reflect.get(options, 'currentKeyReference') as unknown;
      const previous = Reflect.get(options, 'previousKeyReferences') as unknown;
      const identity = Reflect.get(options, 'identity') as unknown;
      const selected = current ?? legacy;
      if (typeof selected !== 'string') throw stableError('UNVERSIONED_KMS_KEY_REFERENCE');
      this.currentKeyReference = selected;
      this.previousKeyReferences = Object.freeze(
        Array.isArray(previous)
          ? previous.map((value) => (typeof value === 'string' ? value : ''))
          : [],
      );
      validateKey(this.currentKeyReference);
      for (const key of this.previousKeyReferences) validateKey(key);
      if (
        new Set([this.currentKeyReference, ...this.previousKeyReferences]).size !==
        1 + this.previousKeyReferences.length
      )
        throw stableError('INVALID_KMS_KEYRING');
      this.identity = snapshotKmsIdentity(identity);
    } catch (error) {
      if (hasCode(error)) throw error;
      throw stableError('INVALID_KMS_CONFIGURATION');
    }
  }
  async encrypt(adminId: string, plaintext: string): Promise<string> {
    const ciphertext = await this.client.encrypt({
      keyReference: this.currentKeyReference,
      plaintext,
      aad: aad(adminId),
      identity: this.identity,
    });
    return `${V2}.${Buffer.from(this.currentKeyReference).toString('base64url')}.${Buffer.from(ciphertext).toString('base64url')}`;
  }
  async decrypt(adminId: string, envelope: string): Promise<string> {
    const parts = envelope.split('.');
    let references: readonly string[];
    let payload: string | undefined;
    if (parts[0] === 'aliyun-kms' && parts[1] === 'v2' && parts.length === 4) {
      const encodedReference = parts[2];
      if (!encodedReference) throw stableError('SECRET_DECRYPTION_FAILED');
      const embedded = decodeStrict(encodedReference);
      payload = parts[3];
      references = [embedded];
      if (![this.currentKeyReference, ...this.previousKeyReferences].includes(embedded))
        throw stableError('SECRET_DECRYPTION_FAILED');
    } else if (parts[0] === 'aliyun-kms' && parts[1] === 'v1' && parts.length === 3) {
      references = [this.currentKeyReference, ...this.previousKeyReferences];
      payload = parts[2];
    } else throw stableError('SECRET_DECRYPTION_FAILED');
    if (!payload) throw stableError('SECRET_DECRYPTION_FAILED');
    const ciphertext = decodeStrict(payload);
    for (const keyReference of references) {
      try {
        return await this.client.decrypt({
          keyReference,
          ciphertext,
          aad: aad(adminId),
          identity: this.identity,
        });
      } catch {
        /* try retained key */
      }
    }
    throw stableError('SECRET_DECRYPTION_FAILED');
  }
}
function aad(adminId: string) {
  return `iam-service:totp-secret:v1:${adminId}`;
}
function validateKey(reference: string) {
  if (!/^acs:kms:[^\s:]+:[^\s:]+:key\/[^\s:]+:version\/[A-Za-z0-9._-]+$/.test(reference))
    throw stableError('UNVERSIONED_KMS_KEY_REFERENCE');
}
function decodeStrict(value: string) {
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (!value || bytes.toString('base64url') !== value) throw new Error();
    return bytes.toString('utf8');
  } catch {
    throw stableError('SECRET_DECRYPTION_FAILED');
  }
}
export function snapshotKmsIdentity(value: unknown): KmsWorkloadIdentity {
  try {
    if (typeof value !== 'object' || value === null) throw stableError('UNSUPPORTED_KMS_IDENTITY');
    const mode = Reflect.get(value, 'mode') as unknown;
    if (mode === 'ecs_ram_role') {
      const roleName = Reflect.get(value, 'roleName') as unknown;
      if (typeof roleName !== 'string' || !/^[A-Za-z0-9.@_-]{1,64}$/.test(roleName))
        throw stableError('INVALID_KMS_IDENTITY');
      return Object.freeze({ mode, roleName });
    }
    if (mode === 'oidc_role_arn') {
      const roleArn = Reflect.get(value, 'roleArn') as unknown;
      const oidcProviderArn = Reflect.get(value, 'oidcProviderArn') as unknown;
      const clientId = Reflect.get(value, 'clientId') as unknown;
      if (
        typeof roleArn !== 'string' ||
        !/^acs:ram::[0-9]+:role\/[A-Za-z0-9._/-]+$/.test(roleArn) ||
        typeof oidcProviderArn !== 'string' ||
        !/^acs:ram::[0-9]+:oidc-provider\/[A-Za-z0-9._/-]+$/.test(oidcProviderArn) ||
        typeof clientId !== 'string' ||
        !/^[A-Za-z0-9._:@/-]{1,128}$/.test(clientId)
      )
        throw stableError('INVALID_KMS_IDENTITY');
      return Object.freeze({ mode, roleArn, oidcProviderArn, clientId });
    }
    throw stableError('UNSUPPORTED_KMS_IDENTITY');
  } catch (error) {
    if (hasCode(error)) throw error;
    throw stableError('INVALID_KMS_IDENTITY');
  }
}
export function validateKmsWorkloadIdentity(identity: KmsWorkloadIdentity): void {
  snapshotKmsIdentity(identity);
}
function hasCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' && error !== null && typeof Reflect.get(error, 'code') === 'string'
  );
}
function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
