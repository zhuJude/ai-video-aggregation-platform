import type { ApiError } from '@repo/contracts/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiClient, type ApiClientOptions } from '../lib/api-client';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('apiClient', () => {
  it('normalizes a runtime write method before enforcing its idempotency key', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json({ accepted: true }, { status: 202 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const runtimeOptions = {
      method: 'post',
      body: { phone: '13800138000' },
    } as unknown as ApiClientOptions;

    await expect(apiClient('/v1/auth/sms/request', runtimeOptions)).rejects.toThrow(
      'Writes require a 16–128 character printable idempotency key.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends browser credentials and request metadata for a write', async () => {
    let capturedRequest: Request | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        capturedRequest = new Request(input, init);
        return Promise.resolve(Response.json({ accepted: true }, { status: 202 }));
      }),
    );

    await apiClient<{ accepted: boolean }>('/v1/auth/sms/request', {
      method: 'POST',
      body: { phone: '13800138000' },
      idempotencyKey: 'sms-request-0123456789abcdef',
    });

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.credentials).toBe('include');
    expect(capturedRequest?.headers.get('x-trace-id')).toMatch(/^[a-f0-9]{32}$/);
    expect(capturedRequest?.headers.get('x-correlation-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(capturedRequest?.headers.get('idempotency-key')).toBe('sms-request-0123456789abcdef');
    await expect(capturedRequest?.json()).resolves.toEqual({ phone: '13800138000' });
  });

  it('maps a conforming Gateway error and its Retry-After header', async () => {
    const responseBody = {
      code: 'SMS_RATE_LIMITED',
      message: 'Too many requests.',
      traceId: 'fedcba9876543210fedcba9876543210',
      retryable: true,
      details: { scope: 'phone' },
    } satisfies ApiError;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json(responseBody, {
            status: 429,
            headers: { 'Retry-After': '90' },
          }),
        ),
      ),
    );

    await expect(
      apiClient('/v1/auth/sms/request', {
        method: 'POST',
        body: { phone: '13800138000' },
        idempotencyKey: 'sms-request-fedcba9876543210',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'SMS_RATE_LIMITED',
        message: 'Too many requests.',
        retryAfterSeconds: 90,
        retryable: true,
        traceId: 'fedcba9876543210fedcba9876543210',
      }),
    );
  });

  it('aborts an ordinary request after ten seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Request timed out', 'TimeoutError'));
            });
          }),
      ),
    );

    const rejection = expect(apiClient('/v1/models')).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
  });
});
