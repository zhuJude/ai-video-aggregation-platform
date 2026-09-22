import type {
  AdminAccessTokenClaims,
  AdminAccessTokenIssuer,
} from '../ports/admin-access-token.js';
import { snapshotKmsIdentity, type KmsWorkloadIdentity } from './kms-secret.cipher.js';

export interface KmsEdDsaSigner {
  sign(input: {
    readonly algorithm: 'EdDSA';
    readonly keyReference: string;
    readonly data: Uint8Array;
    readonly identity: KmsWorkloadIdentity;
  }): Promise<Uint8Array>;
  verify(input: {
    readonly algorithm: 'EdDSA';
    readonly keyReference: string;
    readonly data: Uint8Array;
    readonly signature: Uint8Array;
    readonly identity: KmsWorkloadIdentity;
  }): Promise<boolean>;
}

export interface KmsAdminAccessTokenIssuerOptions {
  readonly keyReference: string;
  readonly identity: KmsWorkloadIdentity;
}

const ACCESS_TOKEN_LIFETIME_SECONDS = 10 * 60;

export class KmsAdminAccessTokenIssuer implements AdminAccessTokenIssuer {
  private readonly keyReference: string;
  private readonly identity: KmsWorkloadIdentity;
  constructor(
    private readonly signer: KmsEdDsaSigner,
    options: KmsAdminAccessTokenIssuerOptions,
  ) {
    try {
      const keyReference = Reflect.get(options, 'keyReference') as unknown;
      const identity = Reflect.get(options, 'identity') as unknown;
      if (
        typeof keyReference !== 'string' ||
        !/^acs:kms:[^\s:]+:[^\s:]+:key\/[^\s:]+:version\/[A-Za-z0-9._-]+$/.test(keyReference)
      )
        throw stableError('UNVERSIONED_KMS_SIGNING_KEY_REFERENCE');
      this.keyReference = keyReference;
      this.identity = snapshotKmsIdentity(identity);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) throw error;
      throw stableError('INVALID_KMS_SIGNER_CONFIGURATION');
    }
  }

  async issue(claims: AdminAccessTokenClaims): Promise<string> {
    const issuedAt = Math.floor(claims.issuedAt.getTime() / 1_000);
    const encodedHeader = encodeJson({
      alg: 'EdDSA',
      kid: this.keyReference,
      typ: 'JWT',
    });
    const encodedPayload = encodeJson({
      sub: claims.adminId,
      sid: claims.sessionId,
      iss: 'iam-service',
      aud: 'admin-web',
      iat: issuedAt,
      exp: issuedAt + ACCESS_TOKEN_LIFETIME_SECONDS,
    });
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = await this.signer.sign({
      algorithm: 'EdDSA',
      keyReference: this.keyReference,
      data: new TextEncoder().encode(signingInput),
      identity: this.identity,
    });
    if (signature.byteLength !== 64) throw stableError('INVALID_KMS_SIGNATURE');
    const verified = await verifySignature(this.signer, {
      algorithm: 'EdDSA',
      keyReference: this.keyReference,
      data: new TextEncoder().encode(signingInput),
      signature: signature.slice(),
      identity: this.identity,
    });
    if (!verified) throw stableError('INVALID_KMS_SIGNATURE');
    return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
  }
}

async function verifySignature(
  signer: KmsEdDsaSigner,
  input: Parameters<KmsEdDsaSigner['verify']>[0],
): Promise<boolean> {
  try {
    return await signer.verify(input);
  } catch {
    throw stableError('INVALID_KMS_SIGNATURE');
  }
}

function encodeJson(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
