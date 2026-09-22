import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  classifyHttpFailure,
  classifyProviderFailure,
} from '../src/domain/retry-policy.js';

describe('provider retry policy', () => {
  it.each([
    [429, true, 'PROVIDER_RATE_LIMITED'],
    [500, true, 'PROVIDER_UNAVAILABLE'],
    [503, true, 'PROVIDER_UNAVAILABLE'],
    [400, false, 'PROVIDER_REJECTED'],
    [401, false, 'PROVIDER_AUTH_FAILED'],
    [403, false, 'PROVIDER_AUTH_FAILED'],
  ] as const)('classifies HTTP %i', (status, retryable, code) => {
    expect(classifyHttpFailure(status)).toMatchObject({ retryable, code, status });
  });

  it('honors a valid retry-after without shortening the provider delay', () => {
    expect(classifyHttpFailure(429, 17)).toMatchObject({ retryAfterMs: 17_000 });
    expect(backoffMs({ attempt: 1, retryAfterMs: 17_000, jitterKey: 'task-a' })).toBe(17_000);
  });

  it('caps exponential backoff and retry-after at five minutes', () => {
    expect(backoffMs({ attempt: 20, jitterKey: 'task-a' })).toBe(300_000);
    expect(backoffMs({ attempt: 1, retryAfterMs: 900_000, jitterKey: 'task-a' })).toBe(300_000);
  });

  it('adds reproducible deterministic jitter from stable execution identity', () => {
    const first = backoffMs({ attempt: 3, jitterKey: 'execution-a:task-a' });
    expect(first).toBe(backoffMs({ attempt: 3, jitterKey: 'execution-a:task-a' }));
    expect(first).toBeGreaterThanOrEqual(4_000);
    expect(first).toBeLessThan(5_000);
    expect(backoffMs({ attempt: 3, jitterKey: 'execution-b:task-b' })).not.toBe(first);
  });

  it.each([
    [{ name: 'AbortError' }, 'PROVIDER_TIMEOUT'],
    [{ code: 'ETIMEDOUT' }, 'PROVIDER_TIMEOUT'],
    [{ code: 'ECONNRESET' }, 'PROVIDER_NETWORK_ERROR'],
    [new TypeError('fetch failed'), 'PROVIDER_NETWORK_ERROR'],
  ] as const)('marks transport failure as ambiguous', (error, code) => {
    expect(classifyProviderFailure(error)).toMatchObject({
      code,
      retryable: true,
      ambiguous: true,
    });
  });

  it('reads status and retry-after from a provider error without trusting its code', () => {
    expect(
      classifyProviderFailure({ status: 429, code: 'VENDOR_SPECIFIC', retryAfterSeconds: 3 }),
    ).toEqual({
      kind: 'HTTP',
      status: 429,
      retryable: true,
      ambiguous: false,
      code: 'PROVIDER_RATE_LIMITED',
      retryAfterMs: 3_000,
    });
  });

  it('fails unknown errors closed without retrying forever', () => {
    expect(classifyProviderFailure(new Error('unexpected'))).toEqual({
      kind: 'UNKNOWN',
      retryable: false,
      ambiguous: false,
      code: 'PROVIDER_PROTOCOL_ERROR',
    });
  });
});
