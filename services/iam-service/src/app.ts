import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';

import { Argon2idPasswordHasher } from './adapters/argon2id-password.hasher.js';
import { KmsAdminAccessTokenIssuer, type KmsEdDsaSigner } from './adapters/kms-admin-access-token.issuer.js';
import { KmsSecretCipher, type KmsCryptographyClient } from './adapters/kms-secret.cipher.js';
import { OtplibTotpProvider } from './adapters/otplib-totp.provider.js';
import { PrismaAdminAuthRepository } from './adapters/prisma-admin-auth.repository.js';
import { PrismaIamAdministrationRepository } from './adapters/prisma-iam-administration.repository.js';
import { KmsHmacLoginIdentifier, RedisAdminLoginThrottle, type KmsHmacClient } from './adapters/redis-admin-login-throttle.js';
import { AdminAuthService } from './application/admin-auth.service.js';
import type { SuperAdminBootstrapAuthorizer } from './application/iam-administration.repository.js';
import { IamAdministrationService } from './application/iam-administration.service.js';
import { parseIamEnvironment, type IamEnvironment } from './config/environment.js';
import { generateUuidV7 } from './domain/uuid-v7.js';
import { PrismaClient } from './generated/prisma/client.js';
import { AdminAuthController } from './http/admin-auth.controller.js';
import { IamHttpExceptionFilter } from './http/iam-http-exception.filter.js';
import { IamAdminGuard, RolesController, type AdminAccessVerifier } from './http/roles.controller.js';
import { OperationsController } from './http/operations.controller.js';
import { EventLoopWatchdog, ServiceHealth } from './operational/health.js';
import { IamMetrics } from './operational/metrics.js';
import { PendingSessionCleanupWorker } from './operational/pending-session-cleanup.worker.js';
import { IamResourceLifecycle } from './operational/resource-lifecycle.js';

export interface IamCloudInfrastructure {
  readonly cryptographyClient: KmsCryptographyClient;
  readonly signer: KmsEdDsaSigner;
  readonly hmacClient: KmsHmacClient;
  readonly recoveryPepperKeyring: {
    readonly current: { readonly version: string; readonly key: Uint8Array };
    readonly previous?: readonly { readonly version: string; readonly key: Uint8Array }[];
  };
  readonly accessVerifier: AdminAccessVerifier;
  readonly bootstrapAuthorizer: SuperAdminBootstrapAuthorizer;
  readonly kmsReady: (references: readonly string[], signal: AbortSignal) => Promise<boolean>;
  readonly close: () => Promise<void>;
}

export interface IamApplicationOptions {
  readonly environment?: IamEnvironment;
  readonly cloud?: IamCloudInfrastructure;
  readonly lifecycle?: IamResourceLifecycle;
}

export async function createIamApplication(
  options: IamApplicationOptions = {},
): Promise<{ readonly app: NestFastifyApplication; readonly environment: IamEnvironment }> {
  const environment = options.environment ?? parseIamEnvironment(process.env);
  const lifecycle = options.lifecycle ?? new IamResourceLifecycle();
  const cloud = options.cloud ?? unavailableCloudInfrastructure(environment);
  if (!lifecycle.has('cloud')) lifecycle.register('cloud', async () => {
    await cloud.close();
    process.stdout.write(`${JSON.stringify({ level: 'info', event: 'iam_cloud_resources_closed' })}\n`);
  });
  let app: NestFastifyApplication | undefined;
  try {
    assertIamCloudInfrastructure(cloud);
    validateRecoveryPepperKeyring(environment, cloud.recoveryPepperKeyring);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: environment.databaseUrl, query_timeout: environment.databaseOperationTimeoutMs, connectionTimeoutMillis: environment.databaseOperationTimeoutMs }) });
  lifecycle.register('database', () => prisma.$disconnect());
  const readinessPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: environment.databaseUrl, query_timeout: environment.readinessTimeoutMs, connectionTimeoutMillis: environment.readinessTimeoutMs }) });
  lifecycle.register('readiness_database', () => readinessPrisma.$disconnect());
  const redis = new Redis(environment.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableReadyCheck: true, commandTimeout: environment.redisOperationTimeoutMs, connectTimeout: environment.redisOperationTimeoutMs });
  lifecycle.register('redis', () => closeRedis(redis));
  redis.on('error', () => undefined);
  const readinessRedis = new Redis(environment.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableReadyCheck: true, commandTimeout: environment.readinessTimeoutMs, connectTimeout: environment.readinessTimeoutMs });
  lifecycle.register('readiness_redis', () => disconnectRedis(readinessRedis));
  readinessRedis.on('error', () => undefined);
  const watchdog = new EventLoopWatchdog(environment.eventLoopStallThresholdMs);
  lifecycle.register('watchdog', () => { watchdog.close(); });
  const authRepository = new PrismaAdminAuthRepository(prisma);
  const cleanupState: { worker?: PendingSessionCleanupWorker } = {};
  const metrics = new IamMetrics(() => prisma.adminSession.count({
    where: { status: 'ACTIVE', consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() }, admin: { status: 'ACTIVE' } },
  }), () => cleanupState.worker?.healthy() ?? false);
  const cleanupWorker = new PendingSessionCleanupWorker(
    authRepository,
    metrics,
    { recordFailure: () => { process.stderr.write(`${JSON.stringify({ level: 'error', event: 'pending_session_cleanup_failed', code: 'IAM_PENDING_CLEANUP_FAILED' })}\n`); } },
    environment.pendingCleanupIntervalMs,
    environment.pendingCleanupBatchSize,
  );
  cleanupState.worker = cleanupWorker;
  lifecycle.register('pending_cleanup', () => cleanupWorker.close());
  cleanupWorker.start();
  const loginIdentifier = new KmsHmacLoginIdentifier(cloud.hmacClient, {
    currentKeyReference: environment.loginHmacKeyReference,
    previousKeyReferences: environment.previousLoginHmacKeyReferences,
    identity: environment.kmsIdentity,
  });
  const auth = new AdminAuthService({
    repository: authRepository,
    passwordHasher: new Argon2idPasswordHasher(),
    dummyPasswordHash: environment.dummyPasswordHash,
    secretCipher: new KmsSecretCipher(cloud.cryptographyClient, {
      currentKeyReference: environment.totpKeyReference,
      previousKeyReferences: environment.previousTotpKeyReferences,
      identity: environment.kmsIdentity,
    }),
    totpProvider: new OtplibTotpProvider(),
    accessTokenIssuer: new KmsAdminAccessTokenIssuer(cloud.signer, {
      keyReference: environment.signingKeyReference,
      identity: environment.kmsIdentity,
    }),
    recoveryCodePepperKeyring: cloud.recoveryPepperKeyring,
    loginThrottle: new RedisAdminLoginThrottle(redis, loginIdentifier),
    cleanupObserver: {
      recordCleanupFailure: (event) => {
        process.stderr.write(`${JSON.stringify({ level: 'error', event: 'admin_auth_cleanup_failed', code: event.code, operation: event.operation })}\n`);
      },
    },
  });
  const iam = new IamAdministrationService({
    repository: new PrismaIamAdministrationRepository(prisma),
    bootstrapAuthorizer: cloud.bootstrapAuthorizer,
    uuidV7: generateUuidV7,
    metrics,
  });
  const references = [
    environment.signingKeyReference,
    ...environment.previousSigningKeyReferences,
    environment.totpKeyReference,
    ...environment.previousTotpKeyReferences,
    environment.loginHmacKeyReference,
    ...environment.previousLoginHmacKeyReferences,
    environment.recoveryPepperKeyReference,
    ...environment.previousRecoveryPepperKeyReferences,
    environment.bootstrapProofReference,
  ];
  const health = new ServiceHealth([
    { name: 'postgres', check: async () => { await readinessPrisma.$queryRaw`SELECT 1::int AS ok`; return true; } },
    { name: 'redis', check: async () => { await readinessRedis.ping(); return true; } },
    { name: 'kms', check: (signal) => cloud.kmsReady(references, signal) },
    { name: 'pending_cleanup', check: () => Promise.resolve(cleanupWorker.healthy()) },
  ], watchdog, environment.readinessTimeoutMs, environment.readinessTimeoutMs, environment.readinessAbortGraceMs, {
    adapterStuck: (dependency) => {
      metrics.increment('iam_readiness_adapter_stuck_total');
      process.emitWarning('READINESS_ADAPTER_STUCK', { code: 'READINESS_ADAPTER_STUCK', detail: dependency });
    },
  });
  lifecycle.register('health', () => { health.close(); });
  const resources = new RuntimeResources(lifecycle);

  @Module({
    controllers: [AdminAuthController, RolesController, OperationsController],
    providers: [
      IamAdminGuard,
      IamHttpExceptionFilter,
      { provide: 'ADMIN_AUTH_SERVICE', useValue: auth },
      { provide: 'IAM_ADMINISTRATION_SERVICE', useValue: iam },
      { provide: 'ADMIN_ACCESS_VERIFIER', useValue: cloud.accessVerifier },
      { provide: 'SERVICE_METRICS', useValue: metrics },
      { provide: 'SERVICE_HEALTH', useValue: health },
      { provide: RuntimeResources, useValue: resources },
    ],
  })
  // Nest dynamic modules are intentionally declarative containers.
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class IamRuntimeModule {}

  app = await NestFactory.create<NestFastifyApplication>(
    IamRuntimeModule,
    new FastifyAdapter({ logger: false }),
    { logger: false },
  );
  app.useGlobalFilters(new IamHttpExceptionFilter());
  await app.init();
  return { app, environment };
  } catch (error) {
    if (app) {
      try { await app.close(); }
      catch { /* The shared lifecycle below still closes every registered resource. */ }
    }
    try { await lifecycle.close(); }
    catch { /* Lifecycle emits a fixed, non-sensitive aggregate; preserve the startup error. */ }
    throw error;
  }
}

export class RuntimeResources implements OnApplicationShutdown {
  constructor(private readonly lifecycle: IamResourceLifecycle) {}
  async onApplicationShutdown(): Promise<void> {
    await this.lifecycle.close();
  }
}

function unavailableCloudInfrastructure(environment: IamEnvironment): IamCloudInfrastructure {
  const unavailable = (): Promise<never> => Promise.reject(stableError('CLOUD_SDK_UNAVAILABLE'));
  return {
    cryptographyClient: { encrypt: unavailable, decrypt: unavailable },
    signer: { sign: unavailable, verify: unavailable },
    hmacClient: { signHmac: unavailable },
    recoveryPepperKeyring: {
      current: { version: keyVersion(environment.recoveryPepperKeyReference), key: randomBytes(32) },
      previous: environment.previousRecoveryPepperKeyReferences.map((reference) => ({
        version: keyVersion(reference), key: randomBytes(32),
      })),
    },
    accessVerifier: { verify: unavailable },
    bootstrapAuthorizer: { authorize: unavailable },
    kmsReady: () => Promise.resolve(false),
    close: () => Promise.resolve(),
  };
}

function assertIamCloudInfrastructure(cloud: unknown): asserts cloud is IamCloudInfrastructure {
  if (
    !hasMethod(member(cloud, 'cryptographyClient'), 'encrypt') || !hasMethod(member(cloud, 'cryptographyClient'), 'decrypt') ||
    !hasMethod(member(cloud, 'signer'), 'sign') || !hasMethod(member(cloud, 'signer'), 'verify') ||
    !hasMethod(member(cloud, 'hmacClient'), 'signHmac') || !hasMethod(member(cloud, 'accessVerifier'), 'verify') ||
    !hasMethod(member(cloud, 'bootstrapAuthorizer'), 'authorize') || !hasMethod(cloud, 'kmsReady') || !hasMethod(cloud, 'close')
  ) throw stableError('INVALID_CLOUD_INFRASTRUCTURE');
}

function member(owner: unknown, key: string): unknown {
  return (typeof owner === 'object' && owner !== null) || typeof owner === 'function' ? Reflect.get(owner, key) as unknown : undefined;
}

function hasMethod(owner: unknown, key: string): boolean { return typeof member(owner, key) === 'function'; }

async function closeRedis(redis: Redis): Promise<void> {
  if (redis.status !== 'ready') { redis.disconnect(false); return; }
  try { await redis.quit(); }
  catch (error) { redis.disconnect(false); throw error; }
}

function disconnectRedis(redis: Redis): Promise<void> {
  redis.disconnect(false);
  return Promise.resolve();
}

function validateRecoveryPepperKeyring(
  environment: IamEnvironment,
  keyring: IamCloudInfrastructure['recoveryPepperKeyring'],
): void {
  const expected = [environment.recoveryPepperKeyReference, ...environment.previousRecoveryPepperKeyReferences].map(keyVersion);
  const actual = [keyring.current.version, ...(keyring.previous ?? []).map(({ version }) => version)];
  if (expected.length !== actual.length || expected.some((version, index) => version !== actual[index])) {
    throw stableError('RECOVERY_PEPPER_KEYRING_MISMATCH');
  }
}

function keyVersion(reference: string): string {
  const version = /:version\/([A-Za-z0-9._-]+)$/.exec(reference)?.[1];
  if (!version) throw stableError('UNVERSIONED_KMS_REFERENCE');
  return version;
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
