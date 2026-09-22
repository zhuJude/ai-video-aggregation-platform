/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- environment/JSON boundaries are validated immediately. */
import { pathToFileURL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/index.js';
import { Producer, type SessionCredentials } from 'rocketmq-client-nodejs';
import { RefreshingRocketMqProducer } from './adapters/refreshing-rocketmq.producer.js';
import { AliyunOssObjectStore } from './adapters/aliyun-oss.object-store.js';
import {
  AlibabaCloudKmsAdapter,
  OidcIdentityTokenVerifier,
  createRamRoleCredentials,
  createWorkloadIdentityCredentials,
  readOfficialStsSession,
  type ExpiringCredentialsProvider,
} from './adapters/aliyun-runtime.adapters.js';
import { createAssetSupportingServices } from './application/asset-service.factory.js';
import {
  AssetMetrics,
  AssetReadiness,
  PeriodicAssetWorkers,
  startAssetService,
} from './runtime/asset.runtime.js';

export { startAssetService };

export async function runAssetProcess(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: required('DATABASE_URL') }),
  });
  const workloadCredentials = workloadIdentityCredentials('asset-service');
  const kms = new AlibabaCloudKmsAdapter({
    regionId: required('ALIBABA_CLOUD_REGION'),
    credentials: workloadCredentials,
    ...(process.env.KMS_ENDPOINT === undefined ? {} : { endpoint: process.env.KMS_ENDPOINT }),
  });
  const externalId = await kms.resolveSecret(required('OSS_STS_EXTERNAL_ID_KMS_REFERENCE'));
  const ossCredentials = createRamRoleCredentials({
    roleArn: required('OSS_RAM_ROLE_ARN'),
    externalId,
    regionId: required('ALIBABA_CLOUD_REGION'),
    sourceCredentials: workloadCredentials,
    ...(process.env.STS_ENDPOINT === undefined ? {} : { endpoint: process.env.STS_ENDPOINT }),
  });
  const ossKmsKeyReference = required('OSS_KMS_KEY_REFERENCE');
  const ossKmsKeyId = await kms.resolveKeyId(ossKmsKeyReference);
  const objectStore = new AliyunOssObjectStore({
    environment: environment(),
    region: required('OSS_REGION'),
    bucket: required('OSS_BUCKET'),
    bucketAcl: required('OSS_BUCKET_ACL') === 'private' ? 'private' : 'public-read',
    ramRoleArn: required('OSS_RAM_ROLE_ARN'),
    kmsKeyId: ossKmsKeyId,
    cdnBaseUrl: required('CDN_BASE_URL'),
    cdnAuthKeyReference: required('CDN_AUTH_KMS_REFERENCE'),
    cdnAuthValiditySeconds: positiveInteger(process.env.CDN_AUTH_VALIDITY_SECONDS, 300),
    credentialProvider: () => ossCredentials.get(),
    secretResolver: (reference) => kms.resolveSecret(reference),
  });
  const rocket = rocketConfig();
  const producer = new RefreshingRocketMqProducer({
    credentials: () => rocketCredentials(workloadCredentials),
    create: (credentials) =>
      new Producer({
        endpoints: rocket.endpoints,
        namespace: rocket.namespace,
        topic: rocket.topic,
        sessionCredentials: credentials,
      }),
    onRetirementError: logFailure,
  });
  await Promise.all([prisma.$connect(), producer.startup()]);
  const userOidc = new OidcIdentityTokenVerifier({
    jwksUrl: requiredUrl('OIDC_JWKS_URL'),
    issuer: required('AUTH_ISSUER'),
    audience: required('AUTH_AUDIENCE'),
  });
  const serviceOidc = new OidcIdentityTokenVerifier({
    jwksUrl: requiredUrl('OIDC_JWKS_URL'),
    issuer: required('AUTH_ISSUER'),
    audience: required('SERVICE_AUTH_AUDIENCE'),
  });
  const metrics = new AssetMetrics({
    gauges: {
      pendingDeletions: () =>
        count(
          prisma,
          'SELECT COUNT(*)::bigint AS count FROM "AssetDeletion" WHERE "deletedAt" IS NULL',
        ),
      pendingImports: () =>
        count(
          prisma,
          `SELECT COUNT(*)::bigint AS count FROM "ResultImport" WHERE status IN ('RESERVED','COPYING')`,
        ),
    },
  });
  const services = createAssetSupportingServices({
    objectStore,
    prisma: prisma as unknown as Parameters<typeof createAssetSupportingServices>[0]['prisma'],
    eventPublisher: {
      publish: async (event) => {
        await producer.send({
          topic: rocket.topic,
          tag: event.type,
          keys: [event.id],
          body: Buffer.from(JSON.stringify(event)),
        });
      },
    },
    identityTokenVerifier: userOidc,
    serviceIdentityTokenVerifier: serviceOidc,
    uploadPolicy: parseUploadPolicy(required('UPLOAD_POLICY_JSON')),
    metrics,
    providerCallbackAuth: {
      providers: parseProviderKeys(required('PROVIDER_CALLBACK_KEYS_JSON')),
      macVerifier: kms,
    },
  });
  const readiness = new AssetReadiness({
    database: {
      ping: async () => {
        await prisma.$queryRawUnsafe('SELECT 1');
      },
    },
    objectStore,
    kms: { ping: () => kms.pingKey(ossKmsKeyReference) },
    ram: {
      ping: async () => {
        await ossCredentials.get();
      },
    },
    auth: {
      ping: async () => {
        await Promise.all([userOidc.ping(), serviceOidc.ping()]);
      },
    },
    broker: { ping: () => producerPing(producer, rocket.topic) },
    config: {
      environment: environment(),
      bucket: required('OSS_BUCKET'),
      region: required('OSS_REGION'),
      ramRoleArn: required('OSS_RAM_ROLE_ARN'),
      kmsKeyReference: required('OSS_KMS_KEY_REFERENCE'),
      publicRead: required('OSS_BUCKET_ACL') === 'public-read',
    },
    timeoutMs: positiveInteger(process.env.READINESS_TIMEOUT_MS, 2_000),
  });
  const workers = new PeriodicAssetWorkers({
    lifecycle: {
      run: async () => {
        await services.lifecycle.run();
        await services.nonceCleanup.run();
      },
    },
    outbox: services.outboxJob,
    intervalMs: positiveInteger(process.env.WORKER_INTERVAL_MS, 1_000),
    onError: logFailure,
  });
  const runtime = await startAssetService({
    http: services.http,
    readiness,
    metrics,
    workers,
    workersEnabled: boolean(process.env.ASSET_WORKERS_ENABLED, true),
    host: process.env.HOST ?? '0.0.0.0',
    port: positiveInteger(process.env.PORT, 3_000),
  });
  installShutdownHandlers(async () => {
    await runtime.close();
    await Promise.allSettled([producer.shutdown(), prisma.$disconnect()]);
  });
}

async function producerPing(producer: Pick<Producer, 'send'>, topic: string): Promise<void> {
  await producer.send({
    topic,
    tag: 'health.probe',
    keys: ['asset-service-health'],
    body: Buffer.from('{"type":"health.probe","source":"asset-service"}'),
  });
}

async function count(prisma: PrismaClient, query: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(query);
  return Number(rows[0]?.count ?? 0n);
}
function parseProviderKeys(value: string): Record<string, { kmsKeyReference: string }> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('INVALID_PROVIDER_CALLBACK_KEYS');
  const result: Record<string, { kmsKeyReference: string }> = {};
  for (const [provider, config] of Object.entries(parsed)) {
    if (
      typeof config !== 'object' ||
      config === null ||
      !('kmsKeyReference' in config) ||
      typeof config.kmsKeyReference !== 'string'
    )
      throw new Error('INVALID_PROVIDER_CALLBACK_KEYS');
    result[provider] = { kmsKeyReference: config.kmsKeyReference };
  }
  return result;
}
function rocketConfig(): {
  endpoints: string;
  namespace: string;
  topic: string;
} {
  return {
    endpoints: required('ROCKETMQ_ENDPOINTS'),
    namespace: process.env.ROCKETMQ_NAMESPACE ?? '',
    topic: required('ROCKETMQ_TOPIC'),
  };
}
async function rocketCredentials(
  provider: ExpiringCredentialsProvider,
): Promise<{ value: SessionCredentials; expiresAt: Date }> {
  const value = await readOfficialStsSession(provider);
  return {
    value: {
      accessKey: value.accessKeyId,
      accessSecret: value.accessKeySecret,
      securityToken: value.securityToken,
    },
    expiresAt: value.expiresAt,
  };
}
function workloadIdentityCredentials(sessionName: string): ExpiringCredentialsProvider {
  return createWorkloadIdentityCredentials({
    oidcProviderArn: required('ACK_OIDC_PROVIDER_ARN'),
    roleArn: required('ACK_ROLE_ARN'),
    tokenFile: required('ACK_OIDC_TOKEN_FILE'),
    regionId: required('ALIBABA_CLOUD_REGION'),
    sessionName,
    ...(process.env.STS_ENDPOINT === undefined ? {} : { endpoint: process.env.STS_ENDPOINT }),
  });
}
function parseUploadPolicy(value: string): { allowedMimeTypes: Record<string, bigint> } {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('INVALID_UPLOAD_POLICY');
  const allowedMimeTypes: Record<string, bigint> = {};
  for (const [mime, bytes] of Object.entries(parsed)) {
    if (
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ||
      typeof bytes !== 'string' ||
      !/^\d+$/.test(bytes) ||
      BigInt(bytes) <= 0n
    )
      throw new Error('INVALID_UPLOAD_POLICY');
    allowedMimeTypes[mime] = BigInt(bytes);
  }
  if (Object.keys(allowedMimeTypes).length === 0) throw new Error('INVALID_UPLOAD_POLICY');
  return { allowedMimeTypes };
}
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`MISSING_${name}`);
  return value;
}
function requiredUrl(name: string): URL {
  const value = new URL(required(name));
  if (value.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(value.hostname))
    throw new Error(`INSECURE_${name}`);
  return value;
}
function environment(): 'local' | 'development' | 'test' | 'staging' | 'production' {
  const value = process.env.NODE_ENV ?? 'production';
  if (!['local', 'development', 'test', 'staging', 'production'].includes(value))
    throw new Error('INVALID_NODE_ENV');
  return value as 'local' | 'development' | 'test' | 'staging' | 'production';
}
function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('INVALID_INTEGER_CONFIGURATION');
  return parsed;
}
function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('INVALID_BOOLEAN_CONFIGURATION');
}
function logFailure(error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', code: 'BACKGROUND_WORKER_FAILED', errorType: error instanceof Error ? error.name : 'Error' })}\n`,
  );
}
function installShutdownHandlers(close: () => Promise<void>): void {
  let closing: Promise<void> | null = null;
  const shutdown = () => {
    closing ??= close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runAssetProcess();
