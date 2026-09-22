import { createHash } from 'node:crypto';
import { PublicApiError } from '@repo/service-kit';
import type { RedisScriptClient } from '../limits/rate-limiter.js';

const IDEMPOTENCY_LUA = `
-- idempotency-fingerprint
local key = KEYS[1]
local fingerprint = ARGV[1]
local ttl = tonumber(ARGV[2])
local current = redis.call('GET', key)
if not current then
  redis.call('SET', key, fingerprint, 'PX', ttl)
  return 1
end
if current == fingerprint then return 0 end
return -1
`;

export type IdempotentRoute =
  'payment-create' | 'point-adjustment' | 'refund-create' | 'task-create';

export interface IdempotencyClaim {
  readonly body: unknown;
  readonly key: string | undefined;
  readonly route: IdempotentRoute;
  readonly subjectId: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class IdempotencyGuard {
  constructor(private readonly redis: RedisScriptClient) {}

  async claim(input: IdempotencyClaim): Promise<{ replay: boolean }> {
    if (input.key === undefined) {
      throw new PublicApiError('IDEMPOTENCY_REQUIRED', '缺少幂等键', false);
    }
    if (!/^[\x21-\x7e]{16,128}$/.test(input.key)) {
      throw new PublicApiError('INVALID_IDEMPOTENCY_KEY', '幂等键格式无效', false);
    }
    const storageKey = `idempotency:${input.route}:${digest(input.subjectId)}:${digest(input.key)}`;
    const fingerprint = digest(JSON.stringify(canonicalize(input.body)));
    let result: unknown;
    try {
      result = await this.redis.eval(
        IDEMPOTENCY_LUA,
        1,
        storageKey,
        fingerprint,
        String(24 * 60 * 60 * 1000),
      );
    } catch {
      throw new PublicApiError('IDEMPOTENCY_UNAVAILABLE', '请求保护服务暂时不可用', true);
    }
    if (Number(result) === -1) {
      throw new PublicApiError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求', false);
    }
    if (Number(result) !== 0 && Number(result) !== 1) {
      throw new PublicApiError('IDEMPOTENCY_UNAVAILABLE', '请求保护服务暂时不可用', true);
    }
    return { replay: Number(result) === 0 };
  }
}
