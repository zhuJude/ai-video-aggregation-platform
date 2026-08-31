import type { ApiError } from '@repo/contracts/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiClient, parseRetryAfter, type ApiClientOptions } from '../lib/api-client';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('apiClient', () => {
  it('does not fetch when the caller signal is already aborted', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const reason = new DOMException('The view was closed.', 'AbortError');
    caller.abort(reason);
    const addEventListener = vi.spyOn(caller.signal, 'addEventListener');
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiClient('/v1/models', { signal: caller.signal })).rejects.toBe(reason);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an in-flight fetch with the caller reason', async () => {
    const caller = new AbortController();
    const reason = new DOMException('The phone changed.', 'AbortError');
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = init?.signal ?? undefined;
            requestSignal?.addEventListener('abort', () => {
              const propagatedReason = (requestSignal as unknown as { readonly reason?: unknown })
                .reason;
              reject(propagatedReason as Error);
            });
          }),
      ),
    );

    const rejection = expect(apiClient('/v1/models', { signal: caller.signal })).rejects.toBe(
      reason,
    );
    caller.abort(reason);

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });

  it('cleans caller listeners and timeout after a settled request', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const addEventListener = vi.spyOn(caller.signal, 'addEventListener');
    const removeEventListener = vi.spyOn(caller.signal, 'removeEventListener');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    );

    await apiClient('/v1/models', { signal: caller.signal });

    const abortSubscription = addEventListener.mock.calls.find(([type]) => type === 'abort');
    expect(abortSubscription).toBeDefined();
    expect(removeEventListener).toHaveBeenCalledWith('abort', abortSubscription?.[1]);
    expect(vi.getTimerCount()).toBe(0);
  });

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
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.UTC(2026, 7, 31, 5, 0, 0);
  const futureDate = new Date(now + 90_000).toUTCString();
  const pastDate = new Date(now - 30_000).toUTCString();

  it.each([
    ['accepts digit-only delta seconds', '90', 90],
    ['accepts a future HTTP-date', futureDate, 90],
    ['maps a past HTTP-date to zero', pastDate, 0],
    ['caps an excessive valid delta at five minutes', '301', 300],
    ['rejects fractions', '1.5', undefined],
    ['rejects an explicit plus sign', '+3', undefined],
    ['rejects negative values', '-1', undefined],
    ['rejects exponent notation', '1e100', undefined],
    ['rejects numeric lookalikes', '0x10', undefined],
    ['rejects unsafe integer overflow', '9007199254740992', undefined],
    ['rejects malformed dates', 'soon', undefined],
    ['handles a missing header', null, undefined],
  ] as const)('%s', (_label, header, expected) => {
    expect(parseRetryAfter(header, now)).toBe(expected);
  });
});
