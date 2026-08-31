import type {
  ChallengeIssue,
  ChallengeIssueResult,
  ChallengeRemoval,
  ChallengeStore,
  ChallengeVerification,
  ChallengeVerificationResult,
} from '../ports/challenge-store.js';
import { isSmsSecurityRedisKey, smsChallengeKey } from '../domain/sms-security-key.js';

export { SMS_SECURITY_REDIS_HASH_TAG } from '../domain/sms-security-key.js';

export interface RedisEvalClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export const REDIS_ISSUE_CHALLENGE_SCRIPT = String.raw`
local challengeKey = KEYS[1]
local recordJson = ARGV[1]
local challengeTtlMs = tonumber(ARGV[2])

for index = 2, #KEYS do
  local argumentOffset = 3 + ((index - 2) * 2)
  local limit = tonumber(ARGV[argumentOffset])
  local current = tonumber(redis.call('GET', KEYS[index]) or '0')
  if current >= limit then
    return 0
  end
end

redis.call('SET', challengeKey, recordJson, 'PX', challengeTtlMs)

for index = 2, #KEYS do
  local argumentOffset = 3 + ((index - 2) * 2)
  local windowMs = tonumber(ARGV[argumentOffset + 1])
  local count = redis.call('INCR', KEYS[index])
  if count == 1 then
    redis.call('PEXPIRE', KEYS[index], windowMs)
  end
end

return 1
`;

export const REDIS_VERIFY_CHALLENGE_SCRIPT = String.raw`
local challengeKey = KEYS[1]
local expectedDigest = ARGV[1]
local nowMs = tonumber(ARGV[2])
local maxAttempts = tonumber(ARGV[3])
local recordJson = redis.call('GET', challengeKey)

if not recordJson then
  return -1
end

local challenge = cjson.decode(recordJson)
if tonumber(challenge.expiresAtMs) <= nowMs then
  redis.call('DEL', challengeKey)
  return -2
end

if tonumber(challenge.failedAttempts) >= maxAttempts then
  return -3
end

if challenge.codeDigest == expectedDigest then
  redis.call('DEL', challengeKey)
  return 1
end

challenge.failedAttempts = tonumber(challenge.failedAttempts) + 1
redis.call('SET', challengeKey, cjson.encode(challenge), 'KEEPTTL')
return 0
`;

const REDIS_REMOVE_CHALLENGE_SCRIPT = String.raw`
local recordJson = redis.call('GET', KEYS[1])
if not recordJson then
  return 0
end
local challenge = cjson.decode(recordJson)
if challenge.codeDigest == ARGV[1] and tonumber(challenge.issuedAtMs) == tonumber(ARGV[2]) then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const VERIFY_RESULTS: Record<number, ChallengeVerificationResult> = {
  1: 'verified',
  0: 'invalid',
  [-1]: 'missing',
  [-2]: 'expired',
  [-3]: 'locked',
};

export class RedisChallengeStore implements ChallengeStore {
  constructor(private readonly redis: RedisEvalClient) {}

  async issue(input: ChallengeIssue): Promise<ChallengeIssueResult> {
    const ttlMs = input.record.expiresAtMs - input.nowMs;
    if (ttlMs <= 0) throw new Error('INVALID_SMS_CHALLENGE_TTL');

    const keys = [smsChallengeKey(input.phoneHash), ...input.rateLimits.map((rule) => rule.key)];
    if (keys.some((key) => !isSmsSecurityRedisKey(key))) {
      throw new Error('SMS_SECURITY_REDIS_CROSSSLOT_KEY');
    }
    const rateArguments = input.rateLimits.flatMap((rule) => [rule.limit, rule.windowMs]);
    const result = await this.redis.eval(
      REDIS_ISSUE_CHALLENGE_SCRIPT,
      keys.length,
      ...keys,
      JSON.stringify(input.record),
      ttlMs,
      ...rateArguments,
    );

    if (result === 1) return 'issued';
    if (result === 0) return 'rate_limited';
    throw new Error('UNEXPECTED_REDIS_SMS_ISSUE_RESULT');
  }

  async verify(input: ChallengeVerification): Promise<ChallengeVerificationResult> {
    const result = await this.redis.eval(
      REDIS_VERIFY_CHALLENGE_SCRIPT,
      1,
      smsChallengeKey(input.phoneHash),
      input.codeDigest,
      input.nowMs,
      input.maxAttempts,
    );
    if (typeof result !== 'number' || VERIFY_RESULTS[result] === undefined) {
      throw new Error('UNEXPECTED_REDIS_SMS_VERIFY_RESULT');
    }
    return VERIFY_RESULTS[result];
  }

  async remove(input: ChallengeRemoval): Promise<void> {
    await this.redis.eval(
      REDIS_REMOVE_CHALLENGE_SCRIPT,
      1,
      smsChallengeKey(input.phoneHash),
      input.codeDigest,
      input.issuedAtMs,
    );
  }
}
