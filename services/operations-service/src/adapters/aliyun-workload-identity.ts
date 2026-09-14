import { OIDCRoleArnCredentialsProvider, type CredentialsProvider } from '@alicloud/credentials';

interface OfficialStsSessionProvider {
  getSession(): Promise<{
    accessKeyId: string;
    accessKeySecret: string;
    securityToken: string;
    expiration: string;
  }>;
}
export type ExpiringCredentialsProvider = CredentialsProvider & OfficialStsSessionProvider;

/** ACK projected OIDC identity only; no environment access-key fallback. */
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
    .withRoleSessionName('operations-service')
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
  return { ...session, expiresAt };
}
