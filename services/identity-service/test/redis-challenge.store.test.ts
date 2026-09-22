import { describe, expect, it } from 'vitest';

import {
  RedisChallengeStore,
  REDIS_ISSUE_CHALLENGE_SCRIPT,
  REDIS_VERIFY_CHALLENGE_SCRIPT,
  SMS_SECURITY_REDIS_HASH_TAG,
  type RedisEvalClient,
} from '../src/adapters/redis-challenge.store.js';

class FakeRedisClient implements RedisEvalClient {
  readonly calls: Array<{ script: string; numberOfKeys: number; args: Array<string | number> }> =
    [];
  results: unknown[] = [];

  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
    this.calls.push({ script, numberOfKeys, args });
    return Promise.resolve(this.results.shift());
  }
}

describe('RedisChallengeStore', () => {
  it('uses the required phone hash challenge key and only hashed rate-limit keys', async () => {
    const redis = new FakeRedisClient();
    redis.results.push(1);
    const store = new RedisChallengeStore(redis);
    const phoneHash = 'a'.repeat(64);

    await expect(
      store.issue({
        phoneHash,
        nowMs: 61_000,
        record: {
          codeDigest: 'b'.repeat(64),
          issuedAtMs: 1_000,
          expiresAtMs: 301_000,
          failedAttempts: 0,
        },
        rateLimits: [
          {
            key: `sms:rate:${SMS_SECURITY_REDIS_HASH_TAG}:phone:${phoneHash}`,
            limit: 5,
            windowMs: 3_600_000,
          },
          {
            key: `sms:rate:${SMS_SECURITY_REDIS_HASH_TAG}:ip:${'c'.repeat(64)}`,
            limit: 30,
            windowMs: 3_600_000,
          },
          {
            key: `sms:rate:${SMS_SECURITY_REDIS_HASH_TAG}:device:${'d'.repeat(64)}`,
            limit: 10,
            windowMs: 3_600_000,
          },
        ],
      }),
    ).resolves.toBe('issued');

    const call = redis.calls[0];
    expect(call?.script).toBe(REDIS_ISSUE_CHALLENGE_SCRIPT);
    expect(call?.numberOfKeys).toBe(4);
    const keys = call?.args.slice(0, 4).map(String) ?? [];
    expect(keys).toEqual([
      `sms:challenge:${SMS_SECURITY_REDIS_HASH_TAG}:${phoneHash}`,
      `sms:rate:${SMS_SECURITY_REDIS_HASH_TAG}:phone:${phoneHash}`,
      `sms:rate:${SMS_SECURITY_REDIS_HASH_TAG}:ip:${'c'.repeat(64)}`,
      `sms:rate:${SMS_SECURITY_REDIS_HASH_TAG}:device:${'d'.repeat(64)}`,
    ]);
    expect(keys.every((key) => key.includes(SMS_SECURITY_REDIS_HASH_TAG))).toBe(true);
    expect(call?.args[5]).toBe(240_000);
    expect(JSON.stringify(call)).not.toContain('+8613800138000');
  });

  it('rejects a rate key whose first Redis hash tag targets another slot', async () => {
    const redis = new FakeRedisClient();
    const store = new RedisChallengeStore(redis);

    await expect(
      store.issue({
        phoneHash: 'a'.repeat(64),
        nowMs: 1_000,
        record: {
          codeDigest: 'b'.repeat(64),
          issuedAtMs: 1_000,
          expiresAtMs: 301_000,
          failedAttempts: 0,
        },
        rateLimits: [
          {
            key: `sms:rate:{other}:${SMS_SECURITY_REDIS_HASH_TAG}:phone:${'c'.repeat(64)}`,
            limit: 1,
            windowMs: 60_000,
          },
        ],
      }),
    ).rejects.toThrow('SMS_SECURITY_REDIS_CROSSSLOT_KEY');
    expect(redis.calls).toEqual([]);
  });

  it.each([
    [1, 'verified'],
    [0, 'invalid'],
    [-1, 'missing'],
    [-2, 'expired'],
    [-3, 'locked'],
  ] as const)('maps atomic verification result %i to %s', async (redisResult, expected) => {
    const redis = new FakeRedisClient();
    redis.results.push(redisResult);
    const store = new RedisChallengeStore(redis);

    await expect(
      store.verify({
        phoneHash: 'a'.repeat(64),
        codeDigest: 'b'.repeat(64),
        nowMs: 10_000,
        maxAttempts: 5,
      }),
    ).resolves.toBe(expected);

    expect(redis.calls[0]?.script).toBe(REDIS_VERIFY_CHALLENGE_SCRIPT);
  });

  it('keeps issue and verification state transitions atomic in Lua', () => {
    expect(REDIS_ISSUE_CHALLENGE_SCRIPT).toContain("redis.call('SET'");
    expect(REDIS_ISSUE_CHALLENGE_SCRIPT).toContain("redis.call('INCR'");
    expect(REDIS_VERIFY_CHALLENGE_SCRIPT).toContain("redis.call('DEL', challengeKey)");
    expect(REDIS_VERIFY_CHALLENGE_SCRIPT).toContain('failedAttempts');
    expect(REDIS_VERIFY_CHALLENGE_SCRIPT).not.toContain('GETDEL');
  });
});
