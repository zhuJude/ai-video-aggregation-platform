import { randomBytes } from 'node:crypto';

import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RedisChallengeStore } from '../src/adapters/redis-challenge.store.js';
import { smsChallengeKey, smsRateKey } from '../src/domain/sms-security-key.js';

const redisUrl = process.env['REDIS_URL'];

describe.runIf(redisUrl !== undefined)('RedisChallengeStore integration', () => {
  let redis: Redis | undefined;
  const keysToRemove = new Set<string>();

  beforeAll(async () => {
    if (!redisUrl) throw new Error('REDIS_URL_REQUIRED');
    redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    await redis.ping();
  });

  afterAll(async () => {
    if (!redis) return;
    if (keysToRemove.size > 0) await redis.del(...keysToRemove);
    await redis.quit();
  });

  it('executes atomic rate, lock, expiry and replay transitions in Redis Lua', async () => {
    const client = requireRedis();
    const store = new RedisChallengeStore({
      eval: (script, numberOfKeys, ...args) => client.eval(script, numberOfKeys, ...args),
    });
    const nowMs = Date.now();
    const phoneHash = randomBytes(32).toString('hex');
    const replayPhoneHash = randomBytes(32).toString('hex');
    const expiredPhoneHash = randomBytes(32).toString('hex');
    const rateKey = smsRateKey('phone', phoneHash);
    keysToRemove.add(smsChallengeKey(phoneHash));
    keysToRemove.add(smsChallengeKey(replayPhoneHash));
    keysToRemove.add(smsChallengeKey(expiredPhoneHash));
    keysToRemove.add(rateKey);

    const issue = {
      phoneHash,
      nowMs,
      record: {
        codeDigest: 'a'.repeat(64),
        issuedAtMs: nowMs,
        expiresAtMs: nowMs + 300_000,
        failedAttempts: 0,
      },
      rateLimits: [{ key: rateKey, limit: 1, windowMs: 60_000 }],
    };
    await expect(store.issue(issue)).resolves.toBe('issued');
    await expect(store.issue(issue)).resolves.toBe('rate_limited');

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        store.verify({
          phoneHash,
          codeDigest: 'b'.repeat(64),
          nowMs,
          maxAttempts: 5,
        }),
      ).resolves.toBe('invalid');
      await expect(client.pttl(smsChallengeKey(phoneHash))).resolves.toBeGreaterThan(0);
    }
    await expect(
      store.verify({ phoneHash, codeDigest: 'a'.repeat(64), nowMs, maxAttempts: 5 }),
    ).resolves.toBe('locked');

    await expect(
      store.issue({
        phoneHash: replayPhoneHash,
        nowMs,
        record: {
          codeDigest: 'c'.repeat(64),
          issuedAtMs: nowMs,
          expiresAtMs: nowMs + 300_000,
          failedAttempts: 0,
        },
        rateLimits: [],
      }),
    ).resolves.toBe('issued');
    await expect(
      store.verify({
        phoneHash: replayPhoneHash,
        codeDigest: 'c'.repeat(64),
        nowMs,
        maxAttempts: 5,
      }),
    ).resolves.toBe('verified');
    await expect(
      store.verify({
        phoneHash: replayPhoneHash,
        codeDigest: 'c'.repeat(64),
        nowMs,
        maxAttempts: 5,
      }),
    ).resolves.toBe('missing');

    await expect(
      store.issue({
        phoneHash: expiredPhoneHash,
        nowMs,
        record: {
          codeDigest: 'd'.repeat(64),
          issuedAtMs: nowMs,
          expiresAtMs: nowMs + 300_000,
          failedAttempts: 0,
        },
        rateLimits: [],
      }),
    ).resolves.toBe('issued');
    await expect(
      store.verify({
        phoneHash: expiredPhoneHash,
        codeDigest: 'd'.repeat(64),
        nowMs: nowMs + 300_000,
        maxAttempts: 5,
      }),
    ).resolves.toBe('expired');
    await expect(client.exists(smsChallengeKey(expiredPhoneHash))).resolves.toBe(0);
  });

  function requireRedis(): Redis {
    if (!redis) throw new Error('REDIS_NOT_CONNECTED');
    return redis;
  }
});
