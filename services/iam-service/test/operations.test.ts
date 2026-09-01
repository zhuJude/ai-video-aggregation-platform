import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';
import { generate } from 'otplib';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createIamApplication, RuntimeResources } from '../src/app.js';
import { Argon2idPasswordHasher } from '../src/adapters/argon2id-password.hasher.js';
import { buildAdminLoginReservationKey, buildAdminLoginThrottleKey } from '../src/adapters/redis-admin-login-throttle.js';
import { parseIamEnvironment } from '../src/config/environment.js';
import { generateUuidV7 } from '../src/domain/uuid-v7.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { ServiceHealth } from '../src/operational/health.js';
import { IamMetrics } from '../src/operational/metrics.js';
import { IamResourceLifecycle } from '../src/operational/resource-lifecycle.js';
import { bootstrap, gracefulShutdown } from '../src/main.js';

const key = (name: string) => `acs:kms:cn-hangzhou:123456:key/${name}:version/v1`;
const environment = Object.freeze({
  host: '127.0.0.1', port: 39002,
  databaseUrl: 'postgresql://unused:unused@127.0.0.1:1/iam', redisUrl: 'redis://127.0.0.1:1/15',
  signingKeyReference: key('jwt'), totpKeyReference: key('totp'), previousTotpKeyReferences: [],
  previousSigningKeyReferences: [],
  loginHmacKeyReference: key('hmac'), previousLoginHmacKeyReferences: [], recoveryPepperKeyReference: key('pepper'),
  previousRecoveryPepperKeyReferences: [], kmsIdentity: { mode: 'ecs_ram_role' as const, roleName: 'iam-service-role' },
  dummyPasswordHash: '$argon2id$v=19$m=65536,p=1,t=3$aWFtLWR1bW15LXNhbHQtdjEh$sS8ky5sVrjEWO/XGr1C11lT6qVhj8IbY+eDsxB3/eys',
  bootstrapProofReference: key('bootstrap'), readinessTimeoutMs: 10, readinessAbortGraceMs: 10,
  databaseOperationTimeoutMs: 5_000, redisOperationTimeoutMs: 5_000, eventLoopStallThresholdMs: 250,
  pendingCleanupIntervalMs: 60_000, pendingCleanupBatchSize: 100,
});

describe('iam production operations', () => {
  it('strictly parses the environment and rejects access keys', () => {
    const env = {
      IAM_DATABASE_URL: environment.databaseUrl, IAM_REDIS_URL: environment.redisUrl,
      IAM_JWT_SIGNING_KMS_KEY_REF: key('jwt'), IAM_TOTP_KMS_KEY_REF: key('totp'),
      IAM_LOGIN_HMAC_KMS_KEY_REF: key('hmac'), IAM_RECOVERY_PEPPER_KMS_KEY_REF: key('pepper'),
      IAM_DUMMY_PASSWORD_HASH: environment.dummyPasswordHash, IAM_BOOTSTRAP_PROOF_KMS_REF: key('bootstrap'),
      IAM_KMS_IDENTITY_MODE: 'ecs_ram_role', IAM_KMS_ECS_RAM_ROLE_NAME: 'iam-service-role',
    };
    expect(parseIamEnvironment(env)).toMatchObject({ port: 3002 });
    expect(parseIamEnvironment(env)).toMatchObject({
      databaseOperationTimeoutMs: 5_000,
      redisOperationTimeoutMs: 5_000,
      readinessAbortGraceMs: 500,
    });
    expect(() => parseIamEnvironment({ ...env, ALIBABA_CLOUD_ACCESS_KEY_ID: 'forbidden' })).toThrow('STATIC_ACCESS_KEYS_FORBIDDEN');
  });

  it('reports recovery and fixed-cardinality metrics', async () => {
    let redisUp = false;
    const health = new ServiceHealth([{ name: 'redis', check: () => Promise.resolve(redisUp) }], { healthy: () => true }, 10, 0);
    expect((await health.readiness()).statusCode).toBe(503);
    redisUp = true;
    expect((await health.readiness()).statusCode).toBe(200);
    const metrics = new IamMetrics(() => Promise.resolve(2));
    metrics.increment('iam_mfa_failures_total'); metrics.increment('iam_authorization_denials_total');
    metrics.increment('iam_readiness_adapter_stuck_total');
    const output = await metrics.render();
    expect(output).toContain('iam_active_sessions 2');
    expect(output).toContain('iam_readiness_adapter_stuck_total 1');
    expect(output).not.toMatch(/email|adminId|traceId|127\.0\.0\.1/);
  });

  it('exposes operations and fails closed when the KMS SDK wiring is absent', async () => {
    const { app } = await createIamApplication({ environment });
    try {
      const server = app.getHttpAdapter().getInstance();
      expect((await server.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
      const metrics = await server.inject({ method: 'GET', url: '/metrics' });
      expect(metrics.body).toContain('iam_login_failure_total');
      expect(metrics.body).not.toContain(environment.databaseUrl);
      const login = await server.inject({ method: 'POST', url: '/v1/admin/auth/password', payload: { email: 'admin@example.test', password: 'correct horse battery staple' } });
      expect(login.statusCode).toBe(503);
      const mfa = await server.inject({ method: 'POST', url: '/v1/admin/auth/mfa/totp', payload: { challengeId: 'challenge', token: '123456', deviceName: 'browser' } });
      expect(mfa.statusCode).toBe(401);
      const guarded = await server.inject({ method: 'GET', url: '/v1/iam/permissions' });
      expect(guarded.statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it('supports an external KMS port factory, real listener, and controlled SIGINT shutdown', async () => {
    const close = vi.fn(() => Promise.resolve());
    const cloudFactory = vi.fn(() => Promise.resolve({
      cryptographyClient: { encrypt: () => Promise.resolve('cipher'), decrypt: () => Promise.resolve('secret') },
      signer: { sign: () => Promise.resolve(new Uint8Array(64).fill(3)), verify: () => Promise.resolve(true) },
      hmacClient: { signHmac: ({ data }: { data: Uint8Array }) => Promise.resolve(createHash('sha256').update(data).digest()) },
      recoveryPepperKeyring: { current: { version: 'v1', key: new Uint8Array(32).fill(4) } },
      accessVerifier: { verify: () => Promise.reject(new Error('unused')) },
      bootstrapAuthorizer: { authorize: () => Promise.resolve(false) },
      kmsReady: () => Promise.resolve(false),
      close,
    }));
    const app = await bootstrap({ environment: { ...environment, port: 0 }, cloudFactory, manageSignals: false });
    expect(cloudFactory).toHaveBeenCalledOnce();
    expect((await fetch(`${await app.getUrl()}/healthz`)).status).toBe(200);
    await gracefulShutdown(app, 'SIGINT');
    await gracefulShutdown(app, 'SIGINT');
    expect(close).toHaveBeenCalledOnce();

    const creationFailureClose = vi.fn(() => Promise.resolve());
    await expect(bootstrap({
      environment: { ...environment, port: 0 },
      cloudFactory: async () => ({
        ...await cloudFactory(),
        recoveryPepperKeyring: { current: { version: 'wrong', key: new Uint8Array(32).fill(4) } },
        close: creationFailureClose,
      }),
      manageSignals: false,
    })).rejects.toMatchObject({ code: 'RECOVERY_PEPPER_KEYRING_MISMATCH' });
    expect(creationFailureClose).toHaveBeenCalledOnce();

    const blocker = createServer();
    blocker.on('error', () => undefined);
    await new Promise<void>((resolve) => { blocker.listen(0, '127.0.0.1', resolve); });
    const occupiedPort = (blocker.address() as AddressInfo).port;
    const listenFailureClose = vi.fn(() => Promise.resolve());
    try {
      await expect(bootstrap({
        environment: { ...environment, port: occupiedPort },
        cloudFactory: async () => ({ ...await cloudFactory(), close: listenFailureClose }),
        manageSignals: false,
      })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((resolve) => { blocker.close(() => { resolve(); }); });
    }
    expect(listenFailureClose).toHaveBeenCalledOnce();
  });

  it('awaits active pending cleanup before disconnecting its business database', async () => {
    let releaseCleanup: (() => void) | undefined;
    const cleanupClose = vi.fn(() => new Promise<void>((resolve) => { releaseCleanup = resolve; }));
    const businessDatabaseClose = vi.fn(() => Promise.resolve());
    const readinessDatabaseClose = vi.fn(() => Promise.resolve());
    const redisDisconnect = vi.fn();
    const readinessRedisDisconnect = vi.fn();
    const cloudClose = vi.fn(() => Promise.resolve());
    const lifecycle = new IamResourceLifecycle();
    lifecycle.register('health', vi.fn());
    lifecycle.register('watchdog', vi.fn());
    lifecycle.register('pending_cleanup', cleanupClose);
    lifecycle.register('readiness_redis', readinessRedisDisconnect);
    lifecycle.register('redis', redisDisconnect);
    lifecycle.register('readiness_database', readinessDatabaseClose);
    lifecycle.register('database', businessDatabaseClose);
    lifecycle.register('cloud', cloudClose);
    const resources = new RuntimeResources(lifecycle);
    const closing = resources.onApplicationShutdown();
    await expect.poll(() => cleanupClose.mock.calls.length).toBe(1);
    expect(businessDatabaseClose).not.toHaveBeenCalled();
    releaseCleanup?.();
    await closing;
    expect(businessDatabaseClose).toHaveBeenCalledOnce();
    expect(readinessDatabaseClose).toHaveBeenCalledOnce();
    expect(redisDisconnect).toHaveBeenCalledOnce();
    expect(readinessRedisDisconnect).toHaveBeenCalledOnce();
    expect(cloudClose).toHaveBeenCalledOnce();
  });

  it.skipIf(!process.env['IAM_TEST_DATABASE_URL'])(
    'rolls back construction after an invalid dummy hash without leaking PostgreSQL sessions',
    async () => {
      const databaseUrl = process.env['IAM_TEST_DATABASE_URL'] as string;
      const observerPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
      const countSessions = async () => Number((await observerPrisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count FROM pg_stat_activity WHERE datname = current_database()
      `)[0]?.count ?? 0n);
      const before = await countSessions();
      const closed: string[] = [];
      const lifecycle = new IamResourceLifecycle({ resourceClosed: (resource) => { closed.push(resource); } });
      const cloudClose = vi.fn(() => Promise.resolve());
      try {
        await expect(createIamApplication({
          environment: { ...environment, databaseUrl, dummyPasswordHash: '$argon2id$invalid' },
          lifecycle,
          cloud: {
            cryptographyClient: { encrypt: () => Promise.resolve('cipher'), decrypt: () => Promise.resolve('secret') },
            signer: { sign: () => Promise.resolve(new Uint8Array(64).fill(3)), verify: () => Promise.resolve(true) },
            hmacClient: { signHmac: ({ data }) => Promise.resolve(createHash('sha256').update(data).digest()) },
            recoveryPepperKeyring: { current: { version: 'v1', key: new Uint8Array(32).fill(4) } },
            accessVerifier: { verify: () => Promise.reject(new Error('unused')) },
            bootstrapAuthorizer: { authorize: () => Promise.resolve(false) },
            kmsReady: () => Promise.resolve(false),
            close: cloudClose,
          },
        })).rejects.toMatchObject({ code: 'INVALID_DUMMY_PASSWORD_HASH' });
        await lifecycle.close();
        await expect.poll(countSessions).toBe(before);
        expect(cloudClose).toHaveBeenCalledOnce();
        expect(closed).toEqual(['watchdog', 'pending_cleanup', 'readiness_redis', 'redis', 'readiness_database', 'database', 'cloud']);
        expect(new Set(closed).size).toBe(closed.length);
      } finally { await observerPrisma.$disconnect(); }
    },
  );

  it.skipIf(!process.env['IAM_TEST_DATABASE_URL'] || !process.env['IAM_TEST_REDIS_URL'])(
    'becomes ready against real PostgreSQL and Redis with all versioned KMS references healthy',
    async () => {
      const { app } = await createIamApplication({
        environment: {
          ...environment,
          databaseUrl: process.env['IAM_TEST_DATABASE_URL'] as string,
          redisUrl: process.env['IAM_TEST_REDIS_URL'] as string,
          readinessTimeoutMs: 1_000,
        },
        cloud: {
          cryptographyClient: { encrypt: () => Promise.resolve('cipher'), decrypt: () => Promise.resolve('secret') },
          signer: { sign: () => Promise.resolve(new Uint8Array(64).fill(3)), verify: () => Promise.resolve(true) },
          hmacClient: { signHmac: ({ data }) => Promise.resolve(createHash('sha256').update(data).digest()) },
          recoveryPepperKeyring: { current: { version: 'v1', key: new Uint8Array(32).fill(4) } },
          accessVerifier: { verify: () => Promise.reject(new Error('unused')) },
          bootstrapAuthorizer: { authorize: () => Promise.resolve(false) },
          kmsReady: () => Promise.resolve(true),
          close: () => Promise.resolve(),
        },
      });
      try {
        const server = app.getHttpAdapter().getInstance();
        const response = await waitForReady(() => server.inject({ method: 'GET', url: '/readyz' }));
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: 'ready', checks: { postgres: 'up', redis: 'up', kms: 'up', pending_cleanup: 'up' } });
      } finally { await app.close(); }
    },
  );

  it.skipIf(!process.env['IAM_TEST_DATABASE_URL'] || !process.env['IAM_TEST_REDIS_URL'])(
    'completes password, TOTP, refresh, and an RBAC-guarded read through production composition',
    async () => {
      const databaseUrl = process.env['IAM_TEST_DATABASE_URL'] as string;
      const redisUrl = process.env['IAM_TEST_REDIS_URL'] as string;
      const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
      const redis = new Redis(redisUrl);
      const suffix = Date.now().toString(36);
      const adminId = generateUuidV7(), roleId = generateUuidV7(), proposedPermissionId = generateUuidV7();
      const task6SentinelId = generateUuidV7();
      const task6SentinelKey = `task6:sentinel:${suffix}`;
      let task6SentinelCreated = false;
      const email = `task6-${suffix}@example.test`;
      const password = 'Task6-happy-password-2026';
      const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
      const totpEnvelope = `aliyun-kms.v2.${Buffer.from(environment.totpKeyReference).toString('base64url')}.${Buffer.from('cipher').toString('base64url')}`;
      const identifier = createHash('sha256').update(new TextEncoder().encode(`iam-service:admin-login-id:v1:${email}`)).digest('hex');
      let app: Awaited<ReturnType<typeof createIamApplication>>['app'] | undefined;
      let permissionId = proposedPermissionId;
      let createdPermission = false;
      const cloud = {
        cryptographyClient: { encrypt: () => Promise.resolve('kms-ciphertext'), decrypt: () => Promise.resolve(secret) },
        signer: { sign: async () => { await delay(25); return new Uint8Array(64).fill(3); }, verify: () => Promise.resolve(true) },
        hmacClient: { signHmac: ({ data }: { data: Uint8Array }) => Promise.resolve(createHash('sha256').update(data).digest()) },
        recoveryPepperKeyring: { current: { version: 'v1', key: new Uint8Array(32).fill(4) } },
        accessVerifier: { verify: (token: string) => {
          const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: string; sid?: string };
          return Promise.resolve({ adminId: payload.sub ?? '', sessionId: payload.sid ?? '' });
        } },
        bootstrapAuthorizer: { authorize: () => Promise.resolve(false) },
        kmsReady: (_references: readonly string[], signal: AbortSignal) => delayedReadiness(signal, 25),
        close: () => Promise.resolve(),
      };
      try {
        await prisma.permission.create({ data: { id: task6SentinelId, key: task6SentinelKey, description: 'task6 sentinel' } });
        task6SentinelCreated = true;
        await prisma.adminUser.create({ data: {
          id: adminId, email, passwordHash: await new Argon2idPasswordHasher().hash(password),
          status: 'ACTIVE', mfaEnabled: true, totpSecretCiphertext: totpEnvelope, recoveryGeneration: generateUuidV7(),
        } });
        const permission = await prisma.permission.upsert({
          where: { key: 'iam:permissions:read' },
          create: { id: proposedPermissionId, key: 'iam:permissions:read', description: 'task6 read' },
          update: {},
        });
        permissionId = permission.id;
        createdPermission = permission.id === proposedPermissionId;
        await prisma.role.create({ data: { id: roleId, name: `task6-${suffix}`, description: 'task6 role', dataScope: 'ALL' } });
        await prisma.rolePermission.create({ data: { roleId, permissionId } });
        await prisma.adminRole.create({ data: { adminId, roleId, assignedBy: adminId } });
        ({ app } = await createIamApplication({
          environment: { ...environment, databaseUrl, redisUrl, readinessTimeoutMs: 10 },
          cloud,
        }));
        const server = app.getHttpAdapter().getInstance();
        expect((await server.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
        const passwordStep = await server.inject({ method: 'POST', url: '/v1/admin/auth/password', payload: { email, password } });
        expect(passwordStep.statusCode).toBe(201);
        const challengeId = jsonStringField(passwordStep.body, 'challengeId');
        const token = await generate({ secret, epoch: Date.now() / 1_000 });
        const mfa = await server.inject({ method: 'POST', url: '/v1/admin/auth/mfa/totp', payload: { challengeId, token, deviceName: 'task6-browser' } });
        expect(mfa.statusCode, mfa.body).toBe(201);
        const accessToken = jsonStringField(mfa.body, 'accessToken');
        const cookie = mfa.headers['set-cookie'];
        const guarded = await server.inject({ method: 'GET', url: '/v1/iam/permissions', headers: {
          authorization: `Bearer ${accessToken}`,
          'user-agent': 'task6-smoke',
          'x-trace-id': 'a'.repeat(32),
          'x-correlation-id': generateUuidV7(),
        } });
        expect(guarded.statusCode, guarded.body).toBe(200);
        expect((await server.inject({ method: 'POST', url: '/v1/admin/auth/refresh', headers: { cookie } })).statusCode).toBe(201);
      } finally {
        if (app) await app.close().catch(() => undefined);
        await prisma.adminSession.deleteMany({ where: { adminId } });
        await prisma.mfaChallenge.deleteMany({ where: { adminId } });
        await prisma.adminRole.deleteMany({ where: { adminId, roleId } });
        await prisma.rolePermission.deleteMany({ where: { roleId, permissionId } });
        await prisma.role.deleteMany({ where: { id: roleId } });
        if (createdPermission) await prisma.permission.deleteMany({ where: { id: proposedPermissionId } });
        await prisma.adminUser.deleteMany({ where: { id: adminId } });
        await redis.del(buildAdminLoginThrottleKey('iam:admin-login', identifier), buildAdminLoginReservationKey('iam:admin-login', identifier));
        await expectTask6FixturesRemoved(prisma, { adminId, roleId, proposedPermissionId, createdPermission });
        if (task6SentinelCreated) {
          expect(await prisma.permission.findUnique({ where: { id: task6SentinelId } })).toMatchObject({ key: task6SentinelKey });
          await prisma.permission.deleteMany({ where: { id: task6SentinelId } });
        }
        await Promise.all([prisma.$disconnect(), redis.quit()]);
      }
    },
  );
});

async function waitForReady<T extends { readonly statusCode: number }>(
  probe: () => Promise<T>,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let response = await probe();
  while (response.statusCode !== 200 && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    response = await probe();
  }
  return response;
}

async function expectTask6FixturesRemoved(
  prisma: PrismaClient,
  fixture: { readonly adminId: string; readonly roleId: string; readonly proposedPermissionId: string; readonly createdPermission: boolean },
): Promise<void> {
  expect(await prisma.adminUser.count({ where: { id: fixture.adminId } })).toBe(0);
  expect(await prisma.adminSession.count({ where: { adminId: fixture.adminId } })).toBe(0);
  expect(await prisma.mfaChallenge.count({ where: { adminId: fixture.adminId } })).toBe(0);
  expect(await prisma.role.count({ where: { id: fixture.roleId } })).toBe(0);
  if (fixture.createdPermission) expect(await prisma.permission.count({ where: { id: fixture.proposedPermissionId } })).toBe(0);
  expect(await prisma.auditEvent.count({ where: {
    OR: [{ actorId: fixture.adminId }, { resourceId: { in: [fixture.adminId, fixture.roleId] } }],
  } })).toBe(0);
}

function jsonStringField(body: string, field: string): string {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('INVALID_TEST_RESPONSE');
  const value = Reflect.get(parsed, field) as unknown;
  if (typeof value !== 'string') throw new Error('INVALID_TEST_RESPONSE');
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function delayedReadiness(signal: AbortSignal, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(true); }, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(false); }, { once: true });
  });
}
