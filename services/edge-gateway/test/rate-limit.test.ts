import { describe, expect, it, vi } from 'vitest';
import {
  RateLimiter,
  RateLimitUnavailableError,
  type RedisScriptClient,
} from '../src/limits/rate-limiter.js';
import { IdempotencyGuard } from '../src/http/idempotency.guard.js';

class MemoryRedis implements RedisScriptClient {
  readonly windows = new Map<string, number[]>();
  readonly idempotency = new Map<string, string>();

  eval(script: string, _keyCount: number, ...args: string[]): Promise<unknown> {
    const key = args[0] ?? '';
    if (script.includes('rate-limit-sliding-window')) {
      const now = Number(args[1]);
      const windowMs = Number(args[2]);
      const limit = Number(args[3]);
      const current = (this.windows.get(key) ?? []).filter((value) => value > now - windowMs);
      if (current.length >= limit) {
        return Promise.resolve([0, Math.max(1, (current[0] ?? now) + windowMs - now)]);
      }
      current.push(now);
      this.windows.set(key, current);
      return Promise.resolve([1, 0]);
    }
    if (script.includes('idempotency-fingerprint')) {
      const fingerprint = args[1] ?? '';
      const existing = this.idempotency.get(key);
      if (existing === undefined) {
        this.idempotency.set(key, fingerprint);
        return Promise.resolve(1);
      }
      return Promise.resolve(existing === fingerprint ? 0 : -1);
    }
    throw new Error('unknown script');
  }
}

describe('edge rate policies', () => {
  it('limits SMS requests more strictly than read APIs', async () => {
    const limiter = new RateLimiter(new MemoryRedis());
    const identity = { ip: '203.0.113.7', phone: '13800138000' };

    for (let index = 0; index < 5; index += 1) {
      await expect(limiter.consume('sms', identity)).resolves.toMatchObject({ allowed: true });
    }
    await expect(limiter.consume('sms', identity)).resolves.toMatchObject({ allowed: false });
    await expect(limiter.consume('catalog-read', identity)).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('fails closed for sensitive writes and fails open for catalog reads when Redis is down', async () => {
    const redis: RedisScriptClient = {
      eval: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    const onFailOpen = vi.fn();
    const limiter = new RateLimiter(redis, { onFailOpen });

    await expect(limiter.consume('task-write', { userId: 'user-1' })).rejects.toBeInstanceOf(
      RateLimitUnavailableError,
    );
    await expect(limiter.consume('catalog-read', { ip: '203.0.113.8' })).resolves.toEqual({
      allowed: true,
      degraded: true,
      retryAfterSeconds: 0,
    });
    expect(onFailOpen).toHaveBeenCalledOnce();
  });
});

describe('idempotency enforcement', () => {
  it('requires a valid idempotency key for financial and task commands', async () => {
    const guard = new IdempotencyGuard(new MemoryRedis());

    await expect(
      guard.claim({ body: {}, key: undefined, route: 'task-create', subjectId: 'user-1' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_REQUIRED' });
    await expect(
      guard.claim({ body: {}, key: 'too-short', route: 'payment-create', subjectId: 'user-1' }),
    ).rejects.toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
  });

  it('allows an exact replay but rejects reuse with a different request body', async () => {
    const guard = new IdempotencyGuard(new MemoryRedis());
    const key = 'request-key-1234567890';
    const first = {
      body: { quoteId: 'quote-1' },
      key,
      route: 'task-create' as const,
      subjectId: 'user-1',
    };

    await expect(guard.claim(first)).resolves.toEqual({ replay: false });
    await expect(guard.claim(first)).resolves.toEqual({ replay: true });
    await expect(guard.claim({ ...first, body: { quoteId: 'quote-2' } })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });
});
