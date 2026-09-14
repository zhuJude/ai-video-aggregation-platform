import Credential, {
  OIDCRoleArnCredentialsProvider,
  RAMRoleARNCredentialsProvider,
  type CredentialsProvider,
} from '@alicloud/credentials';
import KmsClient from '@alicloud/kms20160120';
import {
  DecryptRequest,
  DescribeKeyRequest,
  GenerateDataKeyRequest,
  GetSecretValueRequest,
} from '@alicloud/kms20160120';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { KmsSecretResolver, RamRoleSessionIssuer } from './aliyun-sms.sender.js';
import type { KmsDataKeyResolver } from './prisma-notification.repository.js';
import type { UserTokenClaims, UserTokenVerifier } from '../http/http-auth.adapter.js';

interface KmsPort {
  generateDataKey(request: GenerateDataKeyRequest): Promise<unknown>;
  decrypt(request: DecryptRequest): Promise<unknown>;
  getSecretValue(request: GetSecretValueRequest): Promise<unknown>;
  describeKey(request: DescribeKeyRequest): Promise<unknown>;
}
type KmsConstructor = new (config: unknown) => KmsPort;
type CredentialConstructor = new (config?: unknown, provider?: CredentialsProvider) => unknown;
interface OfficialStsSessionProvider {
  getSession(): Promise<{
    accessKeyId: string;
    accessKeySecret: string;
    securityToken: string;
    expiration: string;
  }>;
}
export type ExpiringCredentialsProvider = CredentialsProvider & OfficialStsSessionProvider;

export class AlibabaCloudKmsDataKeys implements KmsDataKeyResolver, KmsSecretResolver {
  private readonly client: KmsPort;
  constructor(
    input:
      | { client: KmsPort }
      | {
          regionId: string;
          endpoint?: string;
          protocol?: 'HTTP' | 'HTTPS';
          credentials: CredentialsProvider;
        },
  ) {
    if ('client' in input) {
      this.client = input.client;
      return;
    }
    const Client = moduleConstructor(KmsClient) as KmsConstructor;
    const CredentialClient = moduleConstructor(Credential) as CredentialConstructor;
    this.client = new Client({
      credential: new CredentialClient(null, input.credentials),
      regionId: input.regionId,
      ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
      ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
    });
  }
  async generateDataKey(
    reference: string,
  ): Promise<{ plaintextKey: Buffer; wrappedKey: Buffer; keyVersion: string }> {
    const body = unwrap(
      await this.client.generateDataKey(
        new GenerateDataKeyRequest({ keyId: keyId(reference), keySpec: 'AES_256' }),
      ),
    );
    if (
      typeof body.plaintext !== 'string' ||
      typeof body.ciphertextBlob !== 'string' ||
      typeof body.keyVersionId !== 'string'
    )
      throw new Error('KMS_DATA_KEY_UNAVAILABLE');
    return {
      plaintextKey: Buffer.from(body.plaintext, 'base64'),
      wrappedKey: Buffer.from(body.ciphertextBlob, 'utf8'),
      keyVersion: body.keyVersionId,
    };
  }
  async decryptDataKey(input: { wrappedKey: Uint8Array; keyVersion: string }): Promise<Buffer> {
    const body = unwrap(
      await this.client.decrypt(
        new DecryptRequest({
          ciphertextBlob: Buffer.from(input.wrappedKey).toString('utf8'),
        }),
      ),
    );
    if (typeof body.plaintext !== 'string') throw new Error('KMS_DECRYPT_UNAVAILABLE');
    return Buffer.from(body.plaintext, 'base64');
  }
  async resolveSecret(reference: string): Promise<string> {
    const body = unwrap(
      await this.client.getSecretValue(
        new GetSecretValueRequest({ secretName: secretName(reference) }),
      ),
    );
    if (typeof body.secretData !== 'string' || body.secretData.length === 0)
      throw new Error('KMS_SECRET_UNAVAILABLE');
    return body.secretData;
  }
  async pingKey(reference: string): Promise<void> {
    await this.client.describeKey(new DescribeKeyRequest({ keyId: keyId(reference) }));
  }
}

function moduleConstructor(value: unknown): unknown {
  if (typeof value === 'function') return value;
  if (typeof value === 'object' && value !== null && 'default' in value)
    return (value as { default: unknown }).default;
  throw new Error('ALIYUN_SDK_CONSTRUCTOR_UNAVAILABLE');
}

export class AlibabaCloudRamRoleIssuer implements RamRoleSessionIssuer {
  constructor(
    private readonly input: {
      regionId: string;
      credentials: CredentialsProvider;
      endpoint?: string;
      now?: () => Date;
    },
  ) {}
  async assumeRole(input: { roleArn: string; externalId: string }) {
    let builder = RAMRoleARNCredentialsProvider.builder()
      .withCredentialsProvider(this.input.credentials)
      .withRoleArn(input.roleArn)
      .withExternalId(input.externalId)
      .withStsRegionId(this.input.regionId)
      .withRoleSessionName('notification-service')
      .withDurationSeconds(3_600)
      .withConnectTimeout(2_000)
      .withReadTimeout(2_000);
    if (this.input.endpoint !== undefined) builder = builder.withStsEndpoint(this.input.endpoint);
    return readOfficialStsSession(builder.build(), this.input.now?.() ?? new Date());
  }
  async ping(input: { roleArn: string; externalId: string }): Promise<void> {
    await this.assumeRole(input);
  }
}

export function createWorkloadIdentityCredentials(input: {
  oidcProviderArn: string;
  roleArn: string;
  tokenFile: string;
  regionId: string;
  endpoint?: string;
}): ExpiringCredentialsProvider {
  let builder = OIDCRoleArnCredentialsProvider.builder()
    .withOIDCProviderArn(input.oidcProviderArn)
    .withRoleArn(input.roleArn)
    .withOIDCTokenFilePath(input.tokenFile)
    .withRoleSessionName('notification-service')
    .withStsRegionId(input.regionId)
    .withDurationSeconds(3_600)
    .withConnectTimeout(2_000)
    .withReadTimeout(2_000);
  if (input.endpoint !== undefined) builder = builder.withStsEndpoint(input.endpoint);
  return builder.build();
}

export async function readOfficialStsSession(
  provider: OfficialStsSessionProvider,
  now = new Date(),
  maxSessionMs = 3_600_000,
) {
  const session = await provider.getSession();
  const expiresAt = new Date(session.expiration);
  const remainingMs = expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(expiresAt.getTime()) || remainingMs <= 0)
    throw new Error('STS_CREDENTIALS_EXPIRED');
  if (remainingMs > maxSessionMs) throw new Error('STS_EXPIRATION_OUT_OF_RANGE');
  if (!session.accessKeyId || !session.accessKeySecret || !session.securityToken)
    throw new Error('RAM_ROLE_CREDENTIALS_UNAVAILABLE');
  return {
    accessKeyId: session.accessKeyId,
    accessKeySecret: session.accessKeySecret,
    securityToken: session.securityToken,
    expiresAt,
  };
}

export class OidcUserTokenVerifier implements UserTokenVerifier {
  private readonly keys;
  constructor(private readonly input: { jwksUrl: URL; issuer: string; audience: string }) {
    this.keys = createRemoteJWKSet(input.jwksUrl, {
      timeoutDuration: 2_000,
      cooldownDuration: 30_000,
    });
  }
  async verify(token: string): Promise<UserTokenClaims> {
    const { payload } = await jwtVerify(token, this.keys, {
      issuer: this.input.issuer,
      audience: this.input.audience,
      algorithms: ['RS256', 'ES256'],
    });
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.iss !== 'string' ||
      typeof payload.token_use !== 'string'
    )
      throw Object.assign(new Error('JWT_CLAIMS_INVALID'), { code: 'JWT_CLAIMS_INVALID' });
    return {
      sub: payload.sub,
      tokenUse: payload.token_use,
      issuer: payload.iss,
      audience: payload.aud ?? [],
    };
  }
  async ping(): Promise<void> {
    const response = await fetch(this.input.jwksUrl, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error('OIDC_JWKS_UNAVAILABLE');
    const body = (await response.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error('OIDC_JWKS_INVALID');
  }
}

function unwrap(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('ALIYUN_SDK_INVALID_RESPONSE');
  const body = 'body' in value ? (value as { body: unknown }).body : value;
  if (typeof body !== 'object' || body === null) throw new Error('ALIYUN_SDK_INVALID_RESPONSE');
  return body as Record<string, unknown>;
}
function keyId(reference: string): string {
  const value = reference.startsWith('kms://') ? reference.slice(6) : reference;
  if (!value || value.length > 512) throw new Error('INVALID_KMS_KEY_REFERENCE');
  return value;
}
function secretName(reference: string): string {
  const value = reference.startsWith('kms://')
    ? reference.split('/').slice(3).join('/')
    : reference;
  if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{1,254}$/.test(value))
    throw new Error('INVALID_KMS_SECRET_REFERENCE');
  return value;
}
