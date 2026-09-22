import { pathToFileURL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  ApacheRocketMqTransport,
  RefreshingRocketMqTransport,
  RocketMqNotificationConsumer,
  uniqueHealthConsumerGroup,
} from './adapters/rocketmq.consumer.js';
import {
  AlibabaCloudKmsDataKeys,
  AlibabaCloudRamRoleIssuer,
  OidcUserTokenVerifier,
  createWorkloadIdentityCredentials,
  readOfficialStsSession,
  type ExpiringCredentialsProvider,
} from './adapters/aliyun-runtime.adapters.js';
import { createNotificationServices } from './application/notification-service.factory.js';
import {
  NotificationMetrics,
  NotificationReadiness,
  startNotificationService,
} from './runtime/production.js';

export { startNotificationService };

export async function runNotificationProcess(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: required('DATABASE_URL') }),
  });
  await prisma.$connect();
  const workloadCredentials = workloadIdentityCredentials();
  const kms = new AlibabaCloudKmsDataKeys({
    regionId: required('ALIBABA_CLOUD_REGION'),
    credentials: workloadCredentials,
    ...(process.env.KMS_ENDPOINT === undefined ? {} : { endpoint: process.env.KMS_ENDPOINT }),
  });
  const ram = new AlibabaCloudRamRoleIssuer({
    regionId: required('ALIBABA_CLOUD_REGION'),
    credentials: workloadCredentials,
    ...(process.env.STS_ENDPOINT === undefined ? {} : { endpoint: process.env.STS_ENDPOINT }),
  });
  const oidc = new OidcUserTokenVerifier({
    jwksUrl: requiredUrl('OIDC_JWKS_URL'),
    issuer: required('AUTH_ISSUER'),
    audience: required('AUTH_AUDIENCE'),
  });
  const metrics = new NotificationMetrics({
    gauges: {
      operatorQueue: () => prisma.operatorQueueItem.count({ where: { status: 'OPEN' } }),
      retryQueue: () =>
        prisma.notification.count({
          where: { status: { in: ['PENDING', 'RETRY_PENDING', 'RECONCILING'] } },
        }),
    },
  });
  const services = await createNotificationServices({
    prisma,
    kms,
    phoneKmsReference: required('PHONE_KMS_REFERENCE'),
    smsCredentialKms: kms,
    ramRoleIssuer: ram,
    smsConfig: {
      roleArn: required('SMS_RAM_ROLE_ARN'),
      credentialKmsRef: required('SMS_CREDENTIAL_KMS_REFERENCE'),
      endpoint: required('SMS_ENDPOINT'),
      approvedSigns: csvRequired('SMS_APPROVED_SIGNS'),
      approvedTemplateCodes: csvRequired('SMS_APPROVED_TEMPLATE_CODES'),
    },
    userTokenVerifier: oidc,
    auth: { issuer: required('AUTH_ISSUER'), audience: required('AUTH_AUDIENCE') },
    metrics,
  });
  const rocket = rocketConfig();
  const transport = new RefreshingRocketMqTransport({
    credentials: async () => {
      const value = await readOfficialStsSession(workloadCredentials);
      return {
        value: {
          accessKey: value.accessKeyId,
          accessSecret: value.accessKeySecret,
          securityToken: value.securityToken,
        },
        expiresAt: value.expiresAt,
      };
    },
    create: (sessionCredentials) =>
      new ApacheRocketMqTransport({
        endpoints: rocket.endpoints,
        namespace: rocket.namespace,
        consumerGroup: rocket.consumerGroup,
        topic: rocket.topic,
        dlqTopic: rocket.dlqTopic,
        healthTopic: rocket.healthTopic,
        healthConsumerGroup: uniqueHealthConsumerGroup(rocket.consumerGroup),
        sessionCredentials,
      }),
    onRetirementError: logFailure,
    onSettlementError: logFailure,
  });
  const eventConsumer = new RocketMqNotificationConsumer({
    transport,
    handler: (event) => services.consumer.handle(event),
    metrics,
    maxInFlight: positiveInteger(process.env.CONSUMER_MAX_IN_FLIGHT, 8),
    maxDeliveryAttempts: positiveInteger(process.env.CONSUMER_MAX_DELIVERY_ATTEMPTS, 16),
    onError: logFailure,
  });
  const readiness = new NotificationReadiness({
    database: {
      ping: async () => {
        await prisma.$queryRawUnsafe('SELECT 1');
      },
    },
    kms: {
      ping: async () => {
        await Promise.all([
          kms.pingKey(required('PHONE_KMS_REFERENCE')),
          kms.resolveSecret(required('SMS_CREDENTIAL_KMS_REFERENCE')),
        ]);
      },
    },
    ram: {
      ping: async () => {
        const externalId = await kms.resolveSecret(required('SMS_CREDENTIAL_KMS_REFERENCE'));
        await ram.ping({ roleArn: required('SMS_RAM_ROLE_ARN'), externalId });
      },
    },
    auth: oidc,
    sms: { ping: () => services.smsHealth.ping() },
    broker: transport,
    config: {
      kmsPhoneKey: required('PHONE_KMS_REFERENCE'),
      ramRoleArn: required('SMS_RAM_ROLE_ARN'),
      smsRegion: required('SMS_REGION'),
      brokerEndpoints: rocket.endpoints,
      consumerGroup: rocket.consumerGroup,
      topic: rocket.topic,
    },
    timeoutMs: positiveInteger(process.env.READINESS_TIMEOUT_MS, 2_000),
  });
  const runtime = await startNotificationService({
    http: services.http,
    readiness,
    metrics,
    deliveryWorkers: services.workerRunner,
    eventConsumer,
    workersEnabled: boolean(process.env.NOTIFICATION_WORKERS_ENABLED, true),
    host: process.env.HOST ?? '0.0.0.0',
    port: positiveInteger(process.env.PORT, 3_000),
  });
  installShutdownHandlers(async () => {
    await runtime.close();
    await prisma.$disconnect();
  });
}

function rocketConfig(): {
  endpoints: string;
  namespace: string;
  consumerGroup: string;
  topic: string;
  dlqTopic: string;
  healthTopic: string;
} {
  return {
    endpoints: required('ROCKETMQ_ENDPOINTS'),
    namespace: process.env.ROCKETMQ_NAMESPACE ?? '',
    consumerGroup: required('ROCKETMQ_CONSUMER_GROUP'),
    topic: required('ROCKETMQ_TOPIC'),
    dlqTopic: required('ROCKETMQ_DLQ_TOPIC'),
    healthTopic: required('ROCKETMQ_HEALTH_TOPIC'),
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
function csvRequired(name: string): string[] {
  const values = required(name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error(`MISSING_${name}`);
  return values;
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
  await runNotificationProcess();
