import { createHash, randomUUID } from 'node:crypto';
import { PublicApiError } from '@repo/service-kit';

export interface RedisScriptClient {
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>;
}

export type RatePolicyName =
  'catalog-read' | 'payment-write' | 'point-adjustment' | 'sms' | 'task-write';

export interface RateLimitIdentity {
  readonly deviceId?: string;
  readonly ip?: string;
  readonly phone?: string;
  readonly userId?: string;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly degraded?: boolean;
  readonly retryAfterSeconds: number;
}

interface RatePolicy {
  readonly failOpen: boolean;
  readonly limit: number;
  readonly windowMs: number;
}

const POLICIES: Readonly<Record<RatePolicyName, RatePolicy>> = {
  'catalog-read': { failOpen: true, limit: 120, windowMs: 60_000 },
  'payment-write': { failOpen: false, limit: 10, windowMs: 60_000 },
  'point-adjustment': { failOpen: false, limit: 5, windowMs: 60_000 },
  sms: { failOpen: false, limit: 5, windowMs: 60_000 },
  'task-write': { failOpen: false, limit: 20, windowMs: 60_000 },
};

const SLIDING_WINDOW_LUA = `
-- rate-limit-sliding-window
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = window
  if oldest[2] then retry = math.max(1, tonumber(oldest[2]) + window - now) end
  return {0, retry}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, 0}
`;

export class RateLimitUnavailableError extends PublicApiError {
  constructor() {
    super('RATE_LIMIT_UNAVAILABLE', '请求保护服务暂时不可用', true);
    this.name = 'RateLimitUnavailableError';
  }
}

export interface RateLimiterOptions {
  readonly now?: () => number;
  readonly onFailOpen?: (policy: RatePolicyName) => void;
}

function hashedIdentity(identity: RateLimitIdentity): string {
  const normalized = Object.entries(identity)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`)
    .join('|');
  return createHash('sha256')
    .update(normalized || 'anonymous')
    .digest('hex');
}

function parseRedisResult(result: unknown): [number, number] {
  if (!Array.isArray(result) || result.length !== 2) {
    throw new Error('invalid rate-limit Redis response');
  }
  const allowed = Number(result[0]);
  const retryAfterMs = Number(result[1]);
  if (!Number.isFinite(allowed) || !Number.isFinite(retryAfterMs)) {
    throw new Error('invalid rate-limit Redis values');
  }
  return [allowed, retryAfterMs];
}

export class RateLimiter {
  private readonly now: () => number;
  private readonly onFailOpen: (policy: RatePolicyName) => void;

  constructor(
    private readonly redis: RedisScriptClient,
    options: RateLimiterOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.onFailOpen = options.onFailOpen ?? (() => undefined);
  }

  async consume(policyName: RatePolicyName, identity: RateLimitIdentity): Promise<RateLimitResult> {
    const policy = POLICIES[policyName];
    const now = this.now();
    try {
      const result = await this.redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        `rate:${policyName}:${hashedIdentity(identity)}`,
        String(now),
        String(policy.windowMs),
        String(policy.limit),
        `${String(now)}:${randomUUID()}`,
      );
      const [allowed, retryAfterMs] = parseRedisResult(result);
      return {
        allowed: allowed === 1,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      };
    } catch {
      if (!policy.failOpen) {
        throw new RateLimitUnavailableError();
      }
      this.onFailOpen(policyName);
      return { allowed: true, degraded: true, retryAfterSeconds: 0 };
    }
  }
}
