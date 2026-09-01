import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';

import { AliyunSmsSender, type AliyunSmsClientProvider } from './adapters/aliyun-sms.sender.js';
import { HmacChallengeCodeHasher } from './adapters/hmac-challenge-code.hasher.js';
import { HmacPrivacyIdentifierHasher } from './adapters/hmac-privacy-identifier.hasher.js';
import { JoseAccessTokenVerifier, type AccessVerificationKeyProvider } from './adapters/jose-access-token.verifier.js';
import { PrismaAccountMutationRepository } from './adapters/prisma-account-mutation.repository.js';
import { PrismaSessionRepository } from './adapters/prisma-session.repository.js';
import { RedisChallengeStore } from './adapters/redis-challenge.store.js';
import { IdentityAccountService } from './application/identity-account.service.js';
import { SessionService } from './application/session.service.js';
import { SmsChallengeService } from './application/sms-challenge.service.js';
import { parseIdentityEnvironment, type IdentityEnvironment } from './config/environment.js';
import { PrismaClient } from './generated/prisma/client.js';
import { AuthController, BrowserRefreshController } from './http/auth.controller.js';
import { IdentityHttpExceptionFilter } from './http/identity-http-exception.filter.js';
import { JwtAccessGuard } from './http/jwt-access.guard.js';
import { OperationsController } from './http/operations.controller.js';
import { EventLoopWatchdog, ServiceHealth } from './operational/health.js';
import { IdentityMetrics } from './operational/metrics.js';
import { IdentityResourceLifecycle } from './operational/resource-lifecycle.js';
import type { AccessTokenIssuer } from './ports/access-token-issuer.js';
import type { ChallengeSecretProvider } from './ports/challenge-secret.js';
import type { PrivacyIdentifierSecretProvider } from './ports/privacy-identifier.js';
import type { KmsReferencedConfigResolver } from './ports/sms-sender.js';

export interface IdentityCloudInfrastructure {
  readonly accessTokenIssuer: AccessTokenIssuer;
  readonly accessVerificationKeyProvider: AccessVerificationKeyProvider;
  readonly challengeSecretProvider: ChallengeSecretProvider;
  readonly privacySecretProvider: PrivacyIdentifierSecretProvider;
  readonly smsClientProvider: AliyunSmsClientProvider;
  readonly kmsConfigResolver: KmsReferencedConfigResolver;
  readonly kmsReady: (references: readonly string[], signal: AbortSignal) => Promise<boolean>;
  readonly smsReady: (signal: AbortSignal) => Promise<boolean>;
  readonly close: () => Promise<void>;
}

export interface IdentityApplicationOptions {
  readonly environment?: IdentityEnvironment;
  readonly cloud?: IdentityCloudInfrastructure;
  readonly lifecycle?: IdentityResourceLifecycle;
}

export interface IdentityApplication {
  readonly app: NestFastifyApplication;
  readonly environment: IdentityEnvironment;
}

export async function createIdentityApplication(
  options: IdentityApplicationOptions = {},
): Promise<IdentityApplication> {
  const environment = options.environment ?? parseIdentityEnvironment(process.env);
  const lifecycle = options.lifecycle ?? new IdentityResourceLifecycle();
  const cloud = options.cloud ?? unavailableCloudInfrastructure();
  if (!lifecycle.has('cloud')) lifecycle.register('cloud', async () => {
    await cloud.close();
    process.stdout.write(`${JSON.stringify({ level: 'info', event: 'identity_cloud_resources_closed' })}\n`);
  });
  let app: NestFastifyApplication | undefined;
  try {
    assertIdentityCloudInfrastructure(cloud);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: environment.databaseUrl, query_timeout: environment.databaseOperationTimeoutMs, connectionTimeoutMillis: environment.databaseOperationTimeoutMs }),
  });
  lifecycle.register('database', () => prisma.$disconnect());
  const readinessPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: environment.databaseUrl, query_timeout: environment.readinessTimeoutMs, connectionTimeoutMillis: environment.readinessTimeoutMs }),
  });
  lifecycle.register('readiness_database', () => readinessPrisma.$disconnect());
  const redis = new Redis(environment.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    commandTimeout: environment.redisOperationTimeoutMs,
    connectTimeout: environment.redisOperationTimeoutMs,
  });
  lifecycle.register('redis', () => closeRedis(redis));
  redis.on('error', () => undefined);
  const readinessRedis = new Redis(environment.redisUrl, {
    lazyConnect: true, maxRetriesPerRequest: 1, enableReadyCheck: true,
    commandTimeout: environment.readinessTimeoutMs, connectTimeout: environment.readinessTimeoutMs,
  });
  lifecycle.register('readiness_redis', () => disconnectRedis(readinessRedis));
  readinessRedis.on('error', () => undefined);
  const watchdog = new EventLoopWatchdog(environment.eventLoopStallThresholdMs);
  lifecycle.register('watchdog', () => { watchdog.close(); });
  const sessionsRepository = new PrismaSessionRepository(prisma);
  const accountRepository = new PrismaAccountMutationRepository(prisma);
  const metrics = new IdentityMetrics(() =>
    prisma.session.count({
      where: { consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() }, user: { status: 'ACTIVE' } },
    }),
  );
  const privacy = new HmacPrivacyIdentifierHasher(
    cloud.privacySecretProvider,
    environment.privacyKeyReference,
    environment.previousPrivacyKeyReferences,
  );
  const sms = new SmsChallengeService({
    store: new RedisChallengeStore(redis),
    sender: new AliyunSmsSender(
      cloud.smsClientProvider,
      {
        getReferences: () => Promise.resolve({
          credentialKind: environment.smsCredentialKind,
          signNameKmsReference: environment.smsSignNameReference,
          templateCodeKmsReference: environment.smsTemplateCodeReference,
          roleKmsReference: environment.smsRoleReference,
        }),
      },
      cloud.kmsConfigResolver,
    ),
    hasher: new HmacChallengeCodeHasher(
      cloud.challengeSecretProvider,
      environment.smsChallengeKeyReference,
    ),
    privacyIdentifierHasher: privacy,
    securityMetrics: metrics,
  });
  const sessionService = new SessionService({
    repository: sessionsRepository,
    accessTokenIssuer: cloud.accessTokenIssuer,
  });
  const accountService = new IdentityAccountService({
    repository: accountRepository,
    smsVerifier: sms,
    operationFingerprintHasher: privacy,
  });
  const keyReferences = [
    environment.smsChallengeKeyReference,
    environment.privacyKeyReference,
    ...environment.previousPrivacyKeyReferences,
    environment.jwtSigningKeyReference,
    environment.smsSignNameReference,
    environment.smsTemplateCodeReference,
    environment.smsRoleReference,
  ];
  const health = new ServiceHealth(
    [
      { name: 'postgres', check: async () => { await readinessPrisma.$queryRaw`SELECT 1::int AS ok`; return true; } },
      { name: 'redis', check: async () => { await readinessRedis.ping(); return true; } },
      { name: 'kms', check: (signal) => cloud.kmsReady(keyReferences, signal) },
      { name: 'sms', check: (signal) => cloud.smsReady(signal) },
    ],
    watchdog,
    environment.readinessTimeoutMs,
    environment.readinessTimeoutMs,
    environment.readinessAbortGraceMs,
    { adapterStuck: (dependency) => {
      metrics.increment('identity_readiness_adapter_stuck_total');
      process.emitWarning('READINESS_ADAPTER_STUCK', { code: 'READINESS_ADAPTER_STUCK', detail: dependency });
    } },
  );
  lifecycle.register('health', () => { health.close(); });
  const verifier = new JoseAccessTokenVerifier({
    keyProvider: cloud.accessVerificationKeyProvider,
    statusRepository: sessionsRepository,
  });
  const resources = new RuntimeResources(lifecycle);

  @Module({
    controllers: [AuthController, BrowserRefreshController, OperationsController],
    providers: [
      JwtAccessGuard,
      IdentityHttpExceptionFilter,
      { provide: 'SESSION_SERVICE', useValue: sessionService },
      { provide: 'SMS_CHALLENGE_SERVICE', useValue: sms },
      { provide: 'IDENTITY_ACCOUNT_SERVICE', useValue: accountService },
      { provide: 'ACCESS_TOKEN_VERIFIER', useValue: verifier },
      { provide: 'SERVICE_METRICS', useValue: metrics },
      { provide: 'SERVICE_HEALTH', useValue: health },
      { provide: RuntimeResources, useValue: resources },
    ],
  })
  // Nest dynamic modules are intentionally declarative containers.
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class IdentityRuntimeModule {}

  app = await NestFactory.create<NestFastifyApplication>(
    IdentityRuntimeModule,
    new FastifyAdapter({ logger: false }),
    { logger: false },
  );
  app.useGlobalFilters(new IdentityHttpExceptionFilter());
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

class RuntimeResources implements OnApplicationShutdown {
  constructor(private readonly lifecycle: IdentityResourceLifecycle) {}
  async onApplicationShutdown(): Promise<void> {
    await this.lifecycle.close();
  }
}

function unavailableCloudInfrastructure(): IdentityCloudInfrastructure {
  const unavailable = (): Promise<never> => Promise.reject(stableError('CLOUD_SDK_UNAVAILABLE'));
  return {
    accessTokenIssuer: { issue: unavailable },
    accessVerificationKeyProvider: { resolve: unavailable },
    challengeSecretProvider: { getSecret: unavailable },
    privacySecretProvider: { getPrivacyIdentifierSecret: unavailable },
    smsClientProvider: { getClient: unavailable },
    kmsConfigResolver: { resolveValue: unavailable },
    kmsReady: () => Promise.resolve(false),
    smsReady: () => Promise.resolve(false),
    close: () => Promise.resolve(),
  };
}

function assertIdentityCloudInfrastructure(cloud: unknown): asserts cloud is IdentityCloudInfrastructure {
  if (
    !hasMethod(member(cloud, 'accessTokenIssuer'), 'issue') ||
    !hasMethod(member(cloud, 'accessVerificationKeyProvider'), 'resolve') ||
    !hasMethod(member(cloud, 'challengeSecretProvider'), 'getSecret') ||
    !hasMethod(member(cloud, 'privacySecretProvider'), 'getPrivacyIdentifierSecret') ||
    !hasMethod(member(cloud, 'smsClientProvider'), 'getClient') ||
    !hasMethod(member(cloud, 'kmsConfigResolver'), 'resolveValue') ||
    !hasMethod(cloud, 'kmsReady') || !hasMethod(cloud, 'smsReady') || !hasMethod(cloud, 'close')
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

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
