import { pathToFileURL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/index.js';
import { Producer, type SessionCredentials } from 'rocketmq-client-nodejs';
import { RefreshingRocketMqProducer } from './adapters/refreshing-rocketmq.producer.js';
import { createOperationsSupportingServices } from './application/operations-service.factory.js';
import {
  FileWorkloadIdentityToken,
  HttpAssetAuthorizationGateway,
} from './adapters/asset-authorization.gateway.js';
import { HttpGenerationAuthorizationGateway } from './adapters/generation-authorization.gateway.js';
import { OidcTokenVerifier } from './adapters/oidc-token.verifier.js';
import {
  createWorkloadIdentityCredentials,
  readOfficialStsSession,
  type ExpiringCredentialsProvider,
} from './adapters/aliyun-workload-identity.js';
import {
  OperationsMetrics,
  OperationsReadiness,
  OperationsWorkerRunner,
  startOperationsService,
} from './runtime/production.js';

export { startOperationsService };

export async function runOperationsProcess(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: required('DATABASE_URL') }),
  });
  const workloadCredentials = workloadIdentityCredentials();
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
  const oidc = new OidcTokenVerifier({
    jwksUrl: requiredUrl('OIDC_JWKS_URL'),
    issuer: required('AUTH_ISSUER'),
    audience: required('AUTH_AUDIENCE'),
  });
  const workloadToken = new FileWorkloadIdentityToken(required('SERVICE_IDENTITY_TOKEN_FILE'));
  const assetGateway = new HttpAssetAuthorizationGateway(
    requiredUrl('ASSET_SERVICE_URL'),
    workloadToken,
  );
  const generationGateway = new HttpGenerationAuthorizationGateway(
    requiredUrl('GENERATION_SERVICE_URL'),
    workloadToken,
  );
  const metrics = new OperationsMetrics({
    gauges: {
      ticketBacklog: async () => ({
        open: await count(
          prisma,
          `SELECT COUNT(*)::bigint AS count FROM "Ticket" WHERE status = 'OPEN'`,
        ),
        inProgress: await count(
          prisma,
          `SELECT COUNT(*)::bigint AS count FROM "Ticket" WHERE status = 'IN_PROGRESS'`,
        ),
      }),
      pendingCompensations: () =>
        count(
          prisma,
          `SELECT COUNT(*)::bigint AS count FROM "SupportUploadCompensation" WHERE status = 'RELEASE_PENDING'`,
        ),
    },
  });
  const services = createOperationsSupportingServices({
    prisma: prisma as unknown as Parameters<typeof createOperationsSupportingServices>[0]['prisma'],
    eventPublisher: {
      publish: async (event) => {
        const publication = publicationMetric(event.type);
        try {
          await producer.send({
            topic: rocket.topic,
            tag: event.type,
            keys: [event.id],
            body: Buffer.from(JSON.stringify(event)),
          });
          if (publication !== null) metrics.publication(publication.kind, publication.result);
        } catch (error) {
          if (publication !== null) metrics.publication(publication.kind, 'failed');
          throw error;
        }
      },
    },
    adminTokenVerifier: oidc,
    userTokenVerifier: oidc,
    assetAuthorizationGateway: assetGateway,
    feedbackSubjectAuthorization: generationGateway,
    auth: { issuer: required('AUTH_ISSUER'), audience: required('AUTH_AUDIENCE') },
    trustedIframeOrigins: csv(process.env.TRUSTED_IFRAME_ORIGINS),
  });
  const readiness = new OperationsReadiness({
    database: {
      ping: async () => {
        await prisma.$queryRawUnsafe('SELECT 1');
      },
    },
    broker: { ping: () => producerPing(producer, rocket.topic) },
    auth: oidc,
    asset: assetGateway,
    generation: generationGateway,
    timeoutMs: positiveInteger(process.env.READINESS_TIMEOUT_MS, 2_000),
  });
  const workers = new OperationsWorkerRunner({
    outbox: services.outboxJob,
    compensation: { run: () => services.ticket.retryPendingAttachmentFinalizations() },
    intervalMs: positiveInteger(process.env.WORKER_INTERVAL_MS, 1_000),
    onError: logFailure,
  });
  const runtime = await startOperationsService({
    http: services.http,
    readiness,
    metrics,
    workers,
    workersEnabled: boolean(process.env.OPERATIONS_WORKERS_ENABLED, true),
    host: process.env.HOST ?? '0.0.0.0',
    port: positiveInteger(process.env.PORT, 3_000),
  });
  installShutdownHandlers(async () => {
    await runtime.close();
    await Promise.allSettled([producer.shutdown(), prisma.$disconnect()]);
  });
}

function publicationMetric(type: string): {
  kind: 'package' | 'content' | 'setting' | 'feature_flag';
  result: 'published' | 'retired';
} | null {
  const match =
    /^operations\.(package|content|system-setting|feature-flag)\.(published|retired)\.v1$/.exec(
      type,
    );
  if (match === null) return null;
  const kinds = {
    package: 'package',
    content: 'content',
    'system-setting': 'setting',
    'feature-flag': 'feature_flag',
  } as const;
  return {
    kind: kinds[match[1] as keyof typeof kinds],
    result: match[2] as 'published' | 'retired',
  };
}

async function producerPing(producer: Pick<Producer, 'send'>, topic: string): Promise<void> {
  await producer.send({
    topic,
    tag: 'health.probe',
    keys: ['operations-service-health'],
    body: Buffer.from('{"type":"health.probe","source":"operations-service"}'),
  });
}

async function count(prisma: PrismaClient, query: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(query);
  return Number(rows[0]?.count ?? 0n);
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
function workloadIdentityCredentials(): ExpiringCredentialsProvider {
  return createWorkloadIdentityCredentials({
    oidcProviderArn: required('ACK_OIDC_PROVIDER_ARN'),
    roleArn: required('ACK_ROLE_ARN'),
    tokenFile: required('ACK_OIDC_TOKEN_FILE'),
    regionId: required('ALIBABA_CLOUD_REGION'),
    ...(process.env.STS_ENDPOINT === undefined ? {} : { endpoint: process.env.STS_ENDPOINT }),
  });
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
function csv(value: string | undefined): string[] {
  return (
    value
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
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
  await runOperationsProcess();
