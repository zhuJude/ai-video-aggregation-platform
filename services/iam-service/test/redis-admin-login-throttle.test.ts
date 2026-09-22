import { createHmac, randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildAdminLoginReservationKey,
  buildAdminLoginThrottleKey,
  KmsHmacLoginIdentifier,
  RedisAdminLoginThrottle,
} from '../src/adapters/redis-admin-login-throttle.js';
import { generateUuidV7 } from '../src/domain/uuid-v7.js';
import { resolveIamTestRedisUrl } from './test-targets.js';

const url = resolveIamTestRedisUrl({ IAM_TEST_REDIS_URL: process.env['IAM_TEST_REDIS_URL'] });
const integration = url ? it : it.skip;
const fixtureKeys = new Set<string>();
const sentinelKey = `iam:test:sentinel:${generateUuidV7()}`;
const sentinelValue = randomBytes(16).toString('hex');
let redis: Redis | null = null;
function identifier(
  secret = Buffer.alloc(32, 7),
  current = 'v1',
  previous: readonly string[] = [],
) {
  return new KmsHmacLoginIdentifier(
    {
      signHmac: ({ data, keyReference }) =>
        Promise.resolve(createHmac('sha256', secret).update(keyReference).update(data).digest()),
    },
    {
      currentKeyReference: `acs:kms:cn-test:123:key/login-id:version/${current}`,
      previousKeyReferences: previous.map((v) => `acs:kms:cn-test:123:key/login-id:version/${v}`),
      identity: { mode: 'ecs_ram_role', roleName: 'iam-runtime' },
    },
  );
}

describe('RedisAdminLoginThrottle', () => {
  beforeAll(async () => {
    if (!url) return;
    redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    await redis.set(sentinelKey, sentinelValue);
  });
  afterEach(async () => {
    if (!redis) return;
    for (const key of fixtureKeys) await redis.del(key);
    fixtureKeys.clear();
    await expect(redis.get(sentinelKey)).resolves.toBe(sentinelValue);
  });
  afterAll(async () => {
    if (!redis) return;
    for (const key of fixtureKeys) await redis.del(key);
    await expect(redis.get(sentinelKey)).resolves.toBe(sentinelValue);
    await redis.del(sentinelKey);
    await redis.quit();
  });

  it('uses opaque cluster-safe keys and propagates dependencies', async () => {
    const evalCommand = vi.fn().mockResolvedValue(1);
    const throttle = new RedisAdminLoginThrottle(
      { eval: evalCommand, del: vi.fn() as never },
      identifier(),
    );
    const permit = await throttle.reserve('Admin.Person@example.com', new Date(1000));
    expect(permit).not.toBeNull();
    const budget = evalCommand.mock.calls[0]?.[2] as string;
    const reservations = evalCommand.mock.calls[0]?.[3] as string;
    expect(budget).toMatch(/^iam:admin-login:\{[0-9a-f]{64}\}:v2:budget$/);
    expect(reservations.replace(':reservations', ':budget')).toBe(budget);
    expect(budget).not.toContain('Admin.Person');
    const failure = new Error('redis unavailable');
    await expect(
      new RedisAdminLoginThrottle(
        { eval: vi.fn().mockRejectedValue(failure), del: vi.fn() as never },
        identifier(),
      ).reserve('x@y.test', new Date()),
    ).rejects.toBe(failure);
  });

  it('snapshots HMAC keyring and workload identity', async () => {
    const seen: unknown[] = [];
    const identity: { mode: 'ecs_ram_role'; roleName: string } = {
      mode: 'ecs_ram_role',
      roleName: 'iam-runtime',
    };
    const options = {
      currentKeyReference: 'acs:kms:cn-test:123:key/login-id:version/v1',
      previousKeyReferences: ['acs:kms:cn-test:123:key/login-id:version/v0'],
      identity,
    };
    const service = new KmsHmacLoginIdentifier(
      {
        signHmac: (input) => {
          seen.push(input);
          return Promise.resolve(new Uint8Array(32));
        },
      },
      options,
    );
    identity.roleName = 'attacker';
    options.currentKeyReference = 'acs:kms:cn-test:123:key/login-id:version/evil';
    options.previousKeyReferences[0] = 'bad';
    await service.identifyCandidates('ops@example.com');
    expect(seen).toEqual([
      expect.objectContaining({
        keyReference: 'acs:kms:cn-test:123:key/login-id:version/v1',
        identity: { mode: 'ecs_ram_role', roleName: 'iam-runtime' },
      }),
      expect.objectContaining({ keyReference: 'acs:kms:cn-test:123:key/login-id:version/v0' }),
    ]);
  });

  integration(
    'atomically caps concurrent reservations and preserves locks across HMAC overlap',
    async () => {
      const client = requireRedis();
      const secret = randomBytes(32);
      const email = `attack-${generateUuidV7()}@example.test`;
      const old = identifier(secret, 'v1');
      const digest = await old.identify(email);
      for (const key of [
        buildAdminLoginThrottleKey('iam:admin-login', digest),
        buildAdminLoginReservationKey('iam:admin-login', digest),
      ])
        fixtureKeys.add(key);
      const throttle = new RedisAdminLoginThrottle(client, old, {
        maxFailures: 5,
        reservationTtlMs: 30_000,
      });
      const now = new Date();
      const attempts = await Promise.all(
        Array.from({ length: 20 }, () => throttle.reserve(email, now)),
      );
      const permits = attempts.filter((p) => p !== null);
      expect(permits).toHaveLength(5);
      await Promise.all(permits.map((p) => throttle.commitFailure(p, now)));
      await expect(throttle.reserve(email, now)).resolves.toBeNull();
      const rotated = new RedisAdminLoginThrottle(client, identifier(secret, 'v2', ['v1']), {
        maxFailures: 5,
      });
      await expect(rotated.reserve(email, now)).resolves.toBeNull();
      await expect(client.get(sentinelKey)).resolves.toBe(sentinelValue);
    },
  );

  integration(
    'counts a failed permit reported after its execution TTL using Redis server time',
    async () => {
      const client = requireRedis();
      const testIdentifier = identifier(randomBytes(32));
      const email = `slow-${generateUuidV7()}@example.test`;
      const digest = await testIdentifier.identify(email);
      for (const key of [
        buildAdminLoginThrottleKey('iam:admin-login', digest),
        buildAdminLoginReservationKey('iam:admin-login', digest),
      ])
        fixtureKeys.add(key);
      const throttle = new RedisAdminLoginThrottle(client, testIdentifier, {
        maxFailures: 1,
        reservationTtlMs: 30,
        permitReportGraceMs: 5_000,
      });
      const permit = await throttle.reserve(email, new Date(0));
      if (!permit) throw new Error('EXPECTED_PERMIT');
      await new Promise((resolve) => setTimeout(resolve, 60));
      await throttle.commitFailure(permit, new Date(0));
      await expect(throttle.reserve(email, new Date(0))).resolves.toBeNull();
    },
  );
});
function requireRedis() {
  if (!redis) throw new Error('IAM_TEST_REDIS_URL_REQUIRED');
  return redis;
}
