import Credential, {
  OIDCRoleArnCredentialsProvider,
  RAMRoleARNCredentialsProvider,
  type CredentialsProvider,
} from '@alicloud/credentials';
import KmsClient from '@alicloud/kms20160120';
import { DescribeKeyRequest, GetSecretValueRequest, VerifyMacRequest } from '@alicloud/kms20160120';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { StsCredentials } from './aliyun-oss.object-store.js';
import type { IdentityTokenVerifier, KmsMacVerifier } from '../http/http-auth.adapters.js';

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

interface KmsPort {
  getSecretValue(request: GetSecretValueRequest): Promise<unknown>;
  verifyMac(request: VerifyMacRequest): Promise<unknown>;
  describeKey?(request: DescribeKeyRequest): Promise<unknown>;
}

export class AlibabaCloudKmsAdapter implements KmsMacVerifier {
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
  async resolveSecret(reference: string): Promise<string> {
    const response = unwrap(
      await this.client.getSecretValue(
        new GetSecretValueRequest({ secretName: secretName(reference) }),
      ),
    );
    if (typeof response.secretData !== 'string' || response.secretData.length === 0)
      throw new Error('KMS_SECRET_UNAVAILABLE');
    return response.secretData;
  }
  async verifyMac(input: {
    kmsKeyReference: string;
    algorithm: 'HMAC_SHA_256';
    message: Uint8Array;
    mac: string;
  }): Promise<boolean> {
    const response = unwrap(
      await this.client.verifyMac(
        new VerifyMacRequest({
          keyId: keyId(input.kmsKeyReference),
          algorithm: input.algorithm,
          message: Buffer.from(input.message).toString('base64'),
          mac: input.mac,
        }),
      ),
    );
    return response.value === true;
  }
  async pingKey(reference: string): Promise<void> {
    await this.resolveKeyId(reference);
  }
  async resolveKeyId(reference: string): Promise<string> {
    if (this.client.describeKey === undefined) throw new Error('KMS_PROBE_UNAVAILABLE');
    const body = unwrap(
      await this.client.describeKey(new DescribeKeyRequest({ keyId: keyId(reference) })),
    );
    const metadata = body.keyMetadata;
    const resolved =
      typeof metadata === 'object' && metadata !== null && 'keyId' in metadata
        ? metadata.keyId
        : undefined;
    if (typeof resolved !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(resolved))
      throw new Error('KMS_KEY_ID_UNAVAILABLE');
    return resolved;
  }
}

function moduleConstructor(value: unknown): unknown {
  if (typeof value === 'function') return value;
  if (typeof value === 'object' && value !== null && 'default' in value)
    return (value as { default: unknown }).default;
  throw new Error('ALIYUN_SDK_CONSTRUCTOR_UNAVAILABLE');
}

export class AlibabaCloudRamRoleCredentials {
  constructor(private readonly provider: Pick<CredentialsProvider, 'getCredentials'>) {}
  async get(): Promise<StsCredentials> {
    const value = await this.provider.getCredentials();
    if (!value.accessKeyId || !value.accessKeySecret || !value.securityToken)
      throw new Error('RAM_ROLE_CREDENTIALS_UNAVAILABLE');
    return {
      accessKeyId: value.accessKeyId,
      accessKeySecret: value.accessKeySecret,
      securityToken: value.securityToken,
    };
  }
}

export function createRamRoleCredentials(input: {
  roleArn: string;
  externalId: string;
  regionId: string;
  sourceCredentials: CredentialsProvider;
  endpoint?: string;
}): AlibabaCloudRamRoleCredentials {
  let builder = RAMRoleARNCredentialsProvider.builder()
    .withCredentialsProvider(input.sourceCredentials)
    .withRoleArn(input.roleArn)
    .withExternalId(input.externalId)
    .withStsRegionId(input.regionId)
    .withRoleSessionName('asset-service')
    .withDurationSeconds(3_600)
    .withConnectTimeout(2_000)
    .withReadTimeout(2_000);
  if (input.endpoint !== undefined) builder = builder.withStsEndpoint(input.endpoint);
  return new AlibabaCloudRamRoleCredentials(builder.build());
}

export function createWorkloadIdentityCredentials(input: {
  oidcProviderArn: string;
  roleArn: string;
  tokenFile: string;
  regionId: string;
  endpoint?: string;
  sessionName: string;
}): ExpiringCredentialsProvider {
  let builder = OIDCRoleArnCredentialsProvider.builder()
    .withOIDCProviderArn(input.oidcProviderArn)
    .withRoleArn(input.roleArn)
    .withOIDCTokenFilePath(input.tokenFile)
    .withRoleSessionName(input.sessionName)
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
): Promise<StsCredentials & { expiresAt: Date }> {
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

export class OidcIdentityTokenVerifier implements IdentityTokenVerifier {
  private readonly keys;
  constructor(private readonly input: { jwksUrl: URL; issuer: string; audience: string }) {
    this.keys = createRemoteJWKSet(input.jwksUrl, {
      timeoutDuration: 2_000,
      cooldownDuration: 30_000,
    });
  }
  async verifyBearerToken(token: string): Promise<{ subject: string } | null> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.input.issuer,
        audience: this.input.audience,
        algorithms: ['RS256', 'ES256'],
      });
      return typeof payload.sub === 'string' && payload.sub.length > 0
        ? { subject: payload.sub }
        : null;
    } catch {
      return null;
    }
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
function secretName(reference: string): string {
  const match = /^kms:\/\/(?:[^/]+)\/(.+)$/.exec(reference);
  if (match?.[1] === undefined || !/^[A-Za-z0-9][A-Za-z0-9/_-]{1,254}$/.test(match[1]))
    throw new Error('INVALID_KMS_SECRET_REFERENCE');
  return match[1];
}
function keyId(reference: string): string {
  const value = reference.startsWith('kms://') ? reference.slice('kms://'.length) : reference;
  if (value.length === 0 || value.length > 512) throw new Error('INVALID_KMS_KEY_REFERENCE');
  return value;
}
