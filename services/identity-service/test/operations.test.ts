import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { createIdentityApplication } from '../src/app.js';
import { HmacPrivacyIdentifierHasher } from '../src/adapters/hmac-privacy-identifier.hasher.js';
import { parseIdentityEnvironment } from '../src/config/environment.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { smsRateKey } from '../src/domain/sms-security-key.js';
import { EventLoopWatchdog, ServiceHealth } from '../src/operational/health.js';
import { IdentityMetrics } from '../src/operational/metrics.js';
import { IdentityResourceLifecycle } from '../src/operational/resource-lifecycle.js';
import { bootstrap, gracefulShutdown } from '../src/main.js';

const key = (name: string) => `kms://identity/${name}#version=v1`;
const environment = Object.freeze({
  host: '127.0.0.1',
  port: 39001,
  databaseUrl: 'postgresql://unused:unused@127.0.0.1:1/identity',
  redisUrl: 'redis://127.0.0.1:1/15',
  smsChallengeKeyReference: key('sms'),
  privacyKeyReference: key('privacy'),
  previousPrivacyKeyReferences: [],
  jwtSigningKeyReference: key('jwt'),
  smsSignNameReference: key('sign'),
  smsTemplateCodeReference: key('template'),
  smsRoleReference: key('role'),
  readinessTimeoutMs: 10,
  readinessAbortGraceMs: 10,
  databaseOperationTimeoutMs: 5_000,
  redisOperationTimeoutMs: 5_000,
  eventLoopStallThresholdMs: 250,
  smsCredentialKind: 'ecs_ram_role' as const,
});

describe('identity production operations', () => {
  afterEach(() => vi.useRealTimers());
  it('strictly parses refs and forbids static access keys', () => {
    const env = {
      IDENTITY_DATABASE_URL: environment.databaseUrl,
      IDENTITY_REDIS_URL: environment.redisUrl,
      IDENTITY_SMS_CHALLENGE_KMS_KEY_REF: key('sms'),
      IDENTITY_PRIVACY_KMS_KEY_REF: key('privacy'),
      IDENTITY_JWT_SIGNING_KMS_KEY_REF: key('jwt'),
      IDENTITY_SMS_SIGN_NAME_KMS_REF: key('sign'),
      IDENTITY_SMS_TEMPLATE_KMS_REF: key('template'),
      IDENTITY_SMS_ROLE_KMS_REF: key('role'),
      IDENTITY_SMS_CREDENTIAL_KIND: 'ecs_ram_role',
    };
    expect(parseIdentityEnvironment(env)).toMatchObject({ port: 3001, host: '0.0.0.0' });
    expect(parseIdentityEnvironment(env)).toMatchObject({
      databaseOperationTimeoutMs: 5_000,
      redisOperationTimeoutMs: 5_000,
      readinessAbortGraceMs: 500,
    });
    expect(() => parseIdentityEnvironment({ ...env, ALIYUN_ACCESS_KEY_SECRET: 'secret' })).toThrow(
      'STATIC_ACCESS_KEYS_FORBIDDEN',
    );
    expect(() =>
      parseIdentityEnvironment({ ...env, IDENTITY_JWT_SIGNING_KMS_KEY_REF: 'floating' }),
    ).toThrow('UNVERSIONED_KMS_REFERENCE');
  });

  it('bounds readiness, detects stalled liveness and never returns dependency details', async () => {
    const health = new ServiceHealth(
      [
        { name: 'postgres', check: () => Promise.resolve(true) },
        { name: 'redis', check: () => Promise.resolve(false) },
        { name: 'kms', check: () => new Promise(() => undefined) },
      ],
      { healthy: () => false },
      10,
    );
    expect(health.liveness()).toEqual({ statusCode: 503, body: { status: 'stalled' } });
    expect(await health.readiness()).toEqual({
      statusCode: 503,
      body: {
        status: 'not_ready',
        checks: { postgres: 'up', redis: 'down', kms: 'timeout' },
      },
    });
    expect(JSON.stringify(await health.readiness())).not.toContain('postgresql://');
  });

  it('single-flights 100 hanging probes without duplicating an uncooperative dependency', async () => {
    let calls = 0;
    let recovered = false;
    const adapterStuck = vi.fn();
    const HealthWithProtocol = ServiceHealth as unknown as new (
      ...args: unknown[]
    ) => ServiceHealth;
    const health = new HealthWithProtocol(
      [
        {
          name: 'kms',
          check: () => {
            calls += 1;
            return recovered ? Promise.resolve(true) : new Promise<boolean>(() => undefined);
          },
        },
      ],
      { healthy: () => true },
      10,
      10,
      10,
      { adapterStuck },
    );
    const results = await Promise.all(Array.from({ length: 100 }, () => health.readiness()));
    expect(calls).toBe(1);
    expect(results.every(({ body }) => body.checks['kms'] === 'timeout')).toBe(true);
    await new Promise((resolve) => {
      setTimeout(resolve, 22);
    });
    recovered = true;
    await expect(health.readiness()).resolves.toMatchObject({
      statusCode: 503,
      body: { checks: { kms: 'adapter_stuck' } },
    });
    expect(calls).toBe(1);
    expect(adapterStuck).toHaveBeenCalledOnce();
    expect(adapterStuck).toHaveBeenCalledWith('kms');
    health.close();
  });

  it('recovers on the next probe cycle after an abort-aware timeout and aborts on close', async () => {
    let calls = 0;
    const health = new ServiceHealth(
      [
        {
          name: 'kms',
          check: (signal) => {
            calls += 1;
            if (calls > 1) return Promise.resolve(true);
            return new Promise<boolean>((resolve) => {
              signal.addEventListener(
                'abort',
                () => {
                  resolve(false);
                },
                { once: true },
              );
            });
          },
        },
      ],
      { healthy: () => true },
      10,
      10,
    );
    await expect(health.readiness()).resolves.toMatchObject({ statusCode: 503 });
    await new Promise((resolve) => {
      setTimeout(resolve, 12);
    });
    await expect(health.readiness()).resolves.toMatchObject({ statusCode: 200 });
    expect(calls).toBe(2);

    let aborted = false;
    const closing = new ServiceHealth(
      [
        {
          name: 'kms',
          check: (signal) =>
            new Promise<boolean>((resolve) => {
              if (signal.aborted) {
                aborted = true;
                resolve(false);
                return;
              }
              signal.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  resolve(false);
                },
                { once: true },
              );
            }),
        },
      ],
      { healthy: () => true },
      1_000,
    );
    const pending = closing.readiness();
    closing.close();
    await expect(pending).resolves.toMatchObject({ statusCode: 503 });
    expect(aborted).toBe(true);
    health.close();
  });

  it('renders fixed-cardinality Prometheus metrics without PII', async () => {
    const metrics = new IdentityMetrics(() => Promise.resolve(3));
    metrics.increment('identity_login_success_total');
    metrics.increment('identity_sms_rate_limit_rejections_total');
    metrics.increment('identity_readiness_adapter_stuck_total');
    const output = await metrics.render();
    expect(output).toContain('identity_active_sessions 3');
    expect(output).toContain('identity_readiness_adapter_stuck_total 1');
    expect(output).not.toMatch(/phone|email|adminId|traceId|127\.0\.0\.1/);
  });

  it('exposes liveness, degraded readiness, metrics and fail-closed SMS', async () => {
    let shutdownOutput = '';
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        shutdownOutput += chunk.toString();
        return true;
      });
    const { app } = await createIdentityApplication({ environment });
    try {
      const server = app.getHttpAdapter().getInstance();
      expect((await server.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      const ready = await server.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(503);
      expect(ready.body).not.toContain(environment.databaseUrl);
      expect((await server.inject({ method: 'GET', url: '/metrics' })).body).toContain(
        'identity_login_success_total',
      );
      const sms = await server.inject({
        method: 'POST',
        url: '/v1/auth/sms/request',
        payload: { phone: '13812345678', deviceId: 'device-1' },
      });
      expect(sms.statusCode).toBe(503);
      const login = await server.inject({
        method: 'POST',
        url: '/v1/auth/sms/verify',
        payload: { phone: '13812345678', code: '123456', deviceName: 'browser' },
      });
      expect(login.statusCode).toBe(503);
    } finally {
      await app.close();
      stderr.mockRestore();
    }
    expect(shutdownOutput).not.toContain('runtime_shutdown_failed');
  });

  it('can close an event-loop watchdog idempotently', () => {
    const watchdog = new EventLoopWatchdog(250, 50);
    expect(watchdog.healthy()).toBe(true);
    watchdog.close();
    watchdog.close();
  });

  it('rolls back every allocated resource once when Nest construction fails', async () => {
    const closed: string[] = [];
    const lifecycle = new IdentityResourceLifecycle({
      resourceClosed: (resource) => {
        closed.push(resource);
      },
    });
    const originalError = Object.assign(new Error('synthetic Nest construction failure'), {
      code: 'NEST_CREATE_FAILED',
    });
    const create = vi.spyOn(NestFactory, 'create').mockRejectedValueOnce(originalError);
    const handlesBefore = new Set(activeHandles());
    const cloudClose = vi.fn(() => Promise.resolve());
    try {
      await expect(
        createIdentityApplication({
          environment,
          lifecycle,
          cloud: {
            accessTokenIssuer: { issue: () => Promise.resolve('test.jwt') },
            accessVerificationKeyProvider: { resolve: () => Promise.resolve(null) },
            challengeSecretProvider: {
              getSecret: () => Promise.resolve(new Uint8Array(32).fill(1)),
            },
            privacySecretProvider: {
              getPrivacyIdentifierSecret: () => Promise.resolve(new Uint8Array(32).fill(2)),
            },
            smsClientProvider: {
              getClient: () =>
                Promise.resolve({ sendSms: () => Promise.resolve({ body: { code: 'OK' } }) }),
            },
            kmsConfigResolver: { resolveValue: () => Promise.resolve('configured') },
            kmsReady: () => Promise.resolve(false),
            smsReady: () => Promise.resolve(false),
            close: cloudClose,
          },
        }),
      ).rejects.toBe(originalError);
      await lifecycle.close();
      expect(cloudClose).toHaveBeenCalledOnce();
      expect(closed).toEqual([
        'health',
        'watchdog',
        'readiness_redis',
        'redis',
        'readiness_database',
        'database',
        'cloud',
      ]);
      expect(new Set(closed).size).toBe(closed.length);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      expect(activeHandles().filter((handle) => !handlesBefore.has(handle))).toEqual([]);
    } finally {
      create.mockRestore();
    }
  });

  it('closes the partially created Nest app and every resource when init fails', async () => {
    const closed: string[] = [];
    const lifecycle = new IdentityResourceLifecycle({
      resourceClosed: (resource) => {
        closed.push(resource);
      },
    });
    const originalError = Object.assign(new Error('synthetic Nest init failure'), {
      code: 'NEST_INIT_FAILED',
    });
    const partialApp = {
      useGlobalFilters: vi.fn(),
      init: vi.fn(() => Promise.reject(originalError)),
      close: vi.fn(() => Promise.resolve()),
    };
    const create = vi.spyOn(NestFactory, 'create').mockResolvedValueOnce(partialApp as never);
    let shutdownOutput = '';
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        shutdownOutput += chunk.toString();
        return true;
      });
    const cloudClose = vi.fn(() => Promise.reject(new Error('sensitive close failure')));
    try {
      await expect(
        createIdentityApplication({
          environment,
          lifecycle,
          cloud: {
            accessTokenIssuer: { issue: () => Promise.resolve('test.jwt') },
            accessVerificationKeyProvider: { resolve: () => Promise.resolve(null) },
            challengeSecretProvider: {
              getSecret: () => Promise.resolve(new Uint8Array(32).fill(1)),
            },
            privacySecretProvider: {
              getPrivacyIdentifierSecret: () => Promise.resolve(new Uint8Array(32).fill(2)),
            },
            smsClientProvider: {
              getClient: () =>
                Promise.resolve({ sendSms: () => Promise.resolve({ body: { code: 'OK' } }) }),
            },
            kmsConfigResolver: { resolveValue: () => Promise.resolve('configured') },
            kmsReady: () => Promise.resolve(false),
            smsReady: () => Promise.resolve(false),
            close: cloudClose,
          },
        }),
      ).rejects.toBe(originalError);
      expect(partialApp.close).toHaveBeenCalledOnce();
      expect(cloudClose).toHaveBeenCalledOnce();
      expect(closed).toEqual([
        'health',
        'watchdog',
        'readiness_redis',
        'redis',
        'readiness_database',
        'database',
        'cloud',
      ]);
      expect(shutdownOutput).toContain('"resources":["cloud"]');
      expect(shutdownOutput).not.toContain('sensitive close failure');
    } finally {
      create.mockRestore();
      stderr.mockRestore();
    }
  });

  it('continues ordered cleanup after a disposer failure and never invokes a disposer twice', async () => {
    const attempts: string[] = [];
    let shutdownOutput = '';
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        shutdownOutput += chunk.toString();
        return true;
      });
    const lifecycle = new IdentityResourceLifecycle();
    for (const resource of [
      'health',
      'watchdog',
      'readiness_redis',
      'redis',
      'readiness_database',
      'database',
      'cloud',
    ] as const) {
      lifecycle.register(resource, () => {
        attempts.push(resource);
        if (resource === 'watchdog') return Promise.reject(new Error('sensitive disposer failure'));
        return Promise.resolve();
      });
    }
    try {
      await expect(lifecycle.close()).rejects.toThrow('RUNTIME_RESOURCE_CLOSE_FAILED');
      await expect(lifecycle.close()).rejects.toThrow('RUNTIME_RESOURCE_CLOSE_FAILED');
      expect(attempts).toEqual([
        'health',
        'watchdog',
        'readiness_redis',
        'redis',
        'readiness_database',
        'database',
        'cloud',
      ]);
      expect(shutdownOutput).toContain('"resources":["watchdog"]');
      expect(shutdownOutput).not.toContain('sensitive disposer failure');
    } finally {
      stderr.mockRestore();
    }
  });

  it('supports an external cloud factory, real listener, and controlled graceful shutdown', async () => {
    const close = vi.fn(() => Promise.resolve());
    let shutdownOutput = '';
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        shutdownOutput += chunk.toString();
        return true;
      });
    const cloudFactory = vi.fn(() =>
      Promise.resolve({
        accessTokenIssuer: { issue: () => Promise.resolve('test.jwt') },
        accessVerificationKeyProvider: { resolve: () => Promise.resolve(null) },
        challengeSecretProvider: { getSecret: () => Promise.resolve(new Uint8Array(32).fill(1)) },
        privacySecretProvider: {
          getPrivacyIdentifierSecret: () => Promise.resolve(new Uint8Array(32).fill(2)),
        },
        smsClientProvider: {
          getClient: () =>
            Promise.resolve({ sendSms: () => Promise.resolve({ body: { code: 'OK' } }) }),
        },
        kmsConfigResolver: { resolveValue: () => Promise.resolve('configured') },
        kmsReady: () => Promise.resolve(false),
        smsReady: () => Promise.resolve(false),
        close,
      }),
    );
    try {
      const app = await bootstrap({
        environment: { ...environment, port: 0 },
        cloudFactory,
        manageSignals: false,
      });
      expect(cloudFactory).toHaveBeenCalledOnce();
      const health = await fetch(`${await app.getUrl()}/healthz`);
      expect(health.status).toBe(200);
      await gracefulShutdown(app, 'SIGTERM');
      await gracefulShutdown(app, 'SIGTERM');
      expect(close).toHaveBeenCalledOnce();
      expect(shutdownOutput).not.toContain('runtime_shutdown_failed');

      shutdownOutput = '';
      const failingClose = vi.fn(() => Promise.reject(new Error('sensitive adapter detail')));
      const failingApp = await bootstrap({
        environment: { ...environment, port: 0 },
        cloudFactory: async () => ({ ...(await cloudFactory()), close: failingClose }),
        manageSignals: false,
      });
      await gracefulShutdown(failingApp, 'SIGTERM');
      await gracefulShutdown(failingApp, 'SIGTERM');
      expect(failingClose).toHaveBeenCalledOnce();
      expect(shutdownOutput).toContain('"resources":["cloud"]');
      expect(shutdownOutput).not.toContain('sensitive adapter detail');

      const creationFailureClose = vi.fn(() => Promise.resolve());
      await expect(
        bootstrap({
          environment: { ...environment, port: 0 },
          cloudFactory: async () => ({
            ...(await cloudFactory()),
            accessTokenIssuer: {} as never,
            close: creationFailureClose,
          }),
          manageSignals: false,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CLOUD_INFRASTRUCTURE' });
      expect(creationFailureClose).toHaveBeenCalledOnce();

      const blocker = createServer();
      blocker.on('error', () => undefined);
      await new Promise<void>((resolve) => {
        blocker.listen(0, '127.0.0.1', resolve);
      });
      const occupiedPort = (blocker.address() as AddressInfo).port;
      const listenFailureClose = vi.fn(() => Promise.resolve());
      try {
        await expect(
          bootstrap({
            environment: { ...environment, port: occupiedPort },
            cloudFactory: async () => ({ ...(await cloudFactory()), close: listenFailureClose }),
            manageSignals: false,
          }),
        ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      } finally {
        await new Promise<void>((resolve) => {
          blocker.close(() => {
            resolve();
          });
        });
      }
      expect(listenFailureClose).toHaveBeenCalledOnce();
    } finally {
      stderr.mockRestore();
    }
  });

  it.skipIf(!process.env['IDENTITY_TEST_DATABASE_URL'] || !process.env['IDENTITY_TEST_REDIS_URL'])(
    'keeps business SMS/session flow working beyond a 10ms timed-out readiness probe',
    async () => {
      let sentCode = '';
      const databaseUrl = process.env['IDENTITY_TEST_DATABASE_URL'] as string;
      const redisUrl = process.env['IDENTITY_TEST_REDIS_URL'] as string;
      const phone = `139${String(Date.now() % 100_000_000).padStart(8, '0')}`;
      const phoneE164 = `+86${phone}`;
      const deviceId = `task6-${String(Date.now())}`;
      const cleanupPrisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: databaseUrl }),
      });
      const cleanupRedis = new Redis(redisUrl);
      const privacy = new HmacPrivacyIdentifierHasher(
        { getPrivacyIdentifierSecret: () => Promise.resolve(new Uint8Array(32).fill(2)) },
        environment.privacyKeyReference,
      );
      const { app } = await createIdentityApplication({
        environment: {
          ...environment,
          databaseUrl,
          redisUrl,
          readinessTimeoutMs: 10,
          readinessAbortGraceMs: 10,
        },
        cloud: {
          accessTokenIssuer: {
            issue: async () => {
              await delay(25);
              return 'test.jwt';
            },
          },
          accessVerificationKeyProvider: { resolve: () => Promise.resolve(null) },
          challengeSecretProvider: { getSecret: () => Promise.resolve(new Uint8Array(32).fill(1)) },
          privacySecretProvider: {
            getPrivacyIdentifierSecret: () => Promise.resolve(new Uint8Array(32).fill(2)),
          },
          smsClientProvider: {
            getClient: () =>
              Promise.resolve({
                sendSms: async (request) => {
                  await delay(25);
                  const parsed: unknown = JSON.parse(request.templateParam);
                  sentCode =
                    typeof parsed === 'object' &&
                    parsed !== null &&
                    typeof Reflect.get(parsed, 'code') === 'string'
                      ? String(Reflect.get(parsed, 'code'))
                      : '';
                  return { body: { code: 'OK' } };
                },
              }),
          },
          kmsConfigResolver: {
            resolveValue: (reference) =>
              Promise.resolve(reference.includes('template') ? 'SMS_123' : 'approved-sign'),
          },
          kmsReady: (_references: readonly string[], signal: AbortSignal) =>
            delayedReadiness(signal, 25),
          smsReady: () => Promise.resolve(true),
          close: () => Promise.resolve(),
        },
      });
      try {
        const response = await app
          .getHttpAdapter()
          .getInstance()
          .inject({ method: 'GET', url: '/readyz' });
        expect(response.statusCode).toBe(503);
        const readinessBody: unknown = response.json();
        const checks =
          typeof readinessBody === 'object' && readinessBody !== null
            ? (Reflect.get(readinessBody, 'checks') as unknown)
            : undefined;
        expect(
          typeof checks === 'object' && checks !== null ? Reflect.get(checks, 'kms') : undefined,
        ).toBe('timeout');
        const server = app.getHttpAdapter().getInstance();
        expect(
          (
            await server.inject({
              method: 'POST',
              url: '/v1/auth/sms/request',
              payload: { phone, deviceId },
            })
          ).statusCode,
        ).toBe(201);
        expect(sentCode).toMatch(/^\d{6}$/);
        const login = await server.inject({
          method: 'POST',
          url: '/v1/auth/sms/verify',
          payload: { phone, code: sentCode, deviceName: 'task6-browser' },
        });
        expect(login.statusCode).toBe(201);
        const cookie = login.headers['set-cookie'];
        expect(cookie).toContain('HttpOnly');
        const refresh = await server.inject({
          method: 'POST',
          url: '/auth/refresh',
          headers: { cookie },
        });
        expect(refresh.statusCode).toBe(201);
      } finally {
        await app.close();
        const user = await cleanupPrisma.user.findUnique({ where: { phoneE164 } });
        if (user) {
          await cleanupPrisma.session.deleteMany({ where: { userId: user.id } });
          await cleanupPrisma.user.delete({ where: { id: user.id } });
        }
        const [phoneHash, ipHash, deviceHash] = await Promise.all([
          privacy.hash('redis-phone', phoneE164),
          privacy.hash('redis-ip', '127.0.0.1'),
          privacy.hash('redis-device', deviceId),
        ]);
        await cleanupRedis.del(
          smsRateKey('cooldown', phoneHash),
          smsRateKey('phone', phoneHash),
          smsRateKey('ip', ipHash),
          smsRateKey('device', deviceHash),
        );
        await Promise.all([cleanupPrisma.$disconnect(), cleanupRedis.quit()]);
      }
    },
  );
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function delayedReadiness(signal: AbortSignal, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(true);
    }, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { once: true },
    );
  });
}

function activeHandles(): readonly unknown[] {
  const getActiveHandles = Reflect.get(process, '_getActiveHandles') as
    (() => readonly unknown[]) | undefined;
  return getActiveHandles?.() ?? [];
}
