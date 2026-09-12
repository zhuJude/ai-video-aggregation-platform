import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as pollTask } from '../app/api/tasks/[id]/route';
import { GET as streamTask } from '../app/api/tasks/[id]/events/route';
import { GET as readRefreshSessionStatus, POST as refreshSession } from '../app/auth/refresh/route';
import {
  establishAuthenticatedServerSession,
  readAuthenticatedServerSession,
  readAuthenticatedServerSessionState,
} from '../lib/auth/server-session';
import { taskGateway } from '../lib/tasks/gateway';

const OWNER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a6101';
const FORGED_OWNER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a6199';
const VERIFIED_PHONE_OWNER = '+8613800138000';
const SESSION_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a6111';
const ROTATED_SESSION_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a6112';
const cookies = vi.hoisted(() => new Map<string, string>());
const deletedCookies = vi.hoisted(() => [] as string[]);
const cookieWrites = vi.hoisted(
  () => [] as Array<{ name: string; value: string; options?: Record<string, unknown> }>,
);

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      delete: (name: string) => {
        deletedCookies.push(name);
        cookies.delete(name);
      },
      get: (name: string) => {
        const value = cookies.get(name);
        return value ? { value } : undefined;
      },
      set: (name: string, value: string, options?: Record<string, unknown>) => {
        cookieWrites.push(options ? { name, value, options } : { name, value });
        if (options?.maxAge === 0) cookies.delete(name);
        else cookies.set(name, value);
      },
    }),
}));

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const accessToken = (suffix: string, sessionId = SESSION_ID, subject = OWNER_ID) =>
  `${encode({ alg: 'ES256', typ: 'JWT' })}.${encode({
    aud: 'user-web',
    exp: Math.floor(Date.now() / 1_000) + 900,
    iss: 'identity-service',
    sid: sessionId,
    sub: subject,
  })}.${suffix}`;
const REFRESH_A = 'A'.repeat(43);
const REFRESH_B = 'B'.repeat(43);

beforeEach(async () => {
  cookies.clear();
  deletedCookies.length = 0;
  cookieWrites.length = 0;
  process.env.USER_WEB_SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64url');
  process.env.GATEWAY_URL = 'https://gateway.internal';
  await establishAuthenticatedServerSession(
    accessToken('first-signature'),
    SESSION_ID,
    REFRESH_A,
    VERIFIED_PHONE_OWNER,
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'locks');
});

describe('authenticated task BFF', () => {
  it('survives an isolated server module load without a shared in-memory registry', async () => {
    const cookie = cookies.get('__Host-user-session');
    expect(cookie).toBeTruthy();
    vi.resetModules();
    const isolated = await import('../lib/auth/server-session');

    await expect(isolated.readAuthenticatedServerSession()).resolves.toEqual({
      ownerId: VERIFIED_PHONE_OWNER,
    });
  });

  it('encrypts tokens and verified owner, and rejects tampering or the wrong key', async () => {
    const encrypted = cookies.get('__Host-user-session');
    expect(encrypted).toBeTruthy();
    if (!encrypted) throw new Error('MISSING_ENCRYPTED_SESSION');
    expect(encrypted).not.toContain(REFRESH_A);
    expect(encrypted).not.toContain(accessToken('first-signature'));
    expect(encrypted).not.toContain(VERIFIED_PHONE_OWNER);
    expect(cookies.get('refresh_token')).toBe(REFRESH_A);

    cookies.set('__Host-user-session', `${encrypted}x`);
    await expect(readAuthenticatedServerSession()).resolves.toBeUndefined();
    cookies.set('__Host-user-session', encrypted);
    process.env.USER_WEB_SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64url');
    await expect(readAuthenticatedServerSession()).resolves.toBeUndefined();
  });

  it('uses the OTP-verified phone owner, never an unverified JWT subject', async () => {
    await establishAuthenticatedServerSession(
      accessToken('forged-subject', SESSION_ID, FORGED_OWNER_ID),
      SESSION_ID,
      REFRESH_A,
      VERIFIED_PHONE_OWNER,
    );
    await expect(readAuthenticatedServerSession()).resolves.toEqual({
      ownerId: VERIFIED_PHONE_OWNER,
    });
    expect(FORGED_OWNER_ID).not.toBe(VERIFIED_PHONE_OWNER);
  });
  it('adds Bearer auth, forwards a valid cursor and streams without buffering', async () => {
    const cancelUpstream = vi.fn();
    const upstreamBody = new ReadableStream<Uint8Array>({ cancel: cancelUpstream });
    const upstreamFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(upstreamBody, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'x-correlation-id': 'upstream-correlation',
          'x-trace-id': '0123456789abcdef0123456789abcdef',
        },
      }),
    );
    vi.stubGlobal('fetch', upstreamFetch);
    const cursor = '4:0198f4d4-21c2-7b7d-8a03-08a0da2a6201';
    const response = await streamTask(
      new Request('https://app.example/api/tasks/task-1/events', {
        headers: { 'Last-Event-ID': cursor },
      }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    const [request, requestInit] = upstreamFetch.mock.calls[0] ?? [];
    const forwarded = new Request(request as string | URL | Request, requestInit);
    expect(forwarded.url).toBe('https://gateway.internal/v1/tasks/task-1/events');
    expect(forwarded.headers.get('authorization')).toMatch(/^Bearer .+\.first-signature$/);
    expect(forwarded.headers.get('last-event-id')).toBe(cursor);
    expect(response.body).toBe(upstreamBody);
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(cancelUpstream).not.toHaveBeenCalled();
  });

  it('returns a typed refresh requirement without rotating on an upstream 401', async () => {
    const cancelUpstream = vi.fn();
    const upstreamFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(new ReadableStream<Uint8Array>({ cancel: cancelUpstream }), { status: 401 }),
      );
    vi.stubGlobal('fetch', upstreamFetch);
    const response = await pollTask(new Request('https://app.example/api/tasks/task-1'), {
      params: Promise.resolve({ id: 'task-1' }),
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ code: 'SESSION_REFRESH_REQUIRED' });
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(cancelUpstream).toHaveBeenCalledTimes(1);
    expect(deletedCookies).toEqual([]);
  });

  it('rotates an apparently active local session after a Gateway 401 and retries successfully', async () => {
    let lockTail = Promise.resolve();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
          const result = lockTail.then(callback);
          lockTail = result.then(
            () => undefined,
            () => undefined,
          );
          return result;
        },
      },
    });
    const task = await taskGateway.getTask('task-1', { ownerId: VERIFIED_PHONE_OWNER });
    const oldCookie = cookies.get('__Host-user-session');
    let refreshed = false;
    let gatewayRefreshes = 0;
    let taskRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === '/auth/refresh') {
          return refreshSession(
            new Request('https://app.example/auth/refresh', {
              headers: { origin: 'https://app.example', 'sec-fetch-site': 'same-origin' },
              method: 'POST',
            }),
          );
        }
        if (url === 'https://gateway.internal/v1/auth/refresh') {
          gatewayRefreshes += 1;
          refreshed = true;
          return Response.json(
            {
              accessToken: accessToken('gateway-401-refresh', ROTATED_SESSION_ID),
              sessionId: ROTATED_SESSION_ID,
            },
            {
              headers: {
                'Set-Cookie': `refresh_token=${REFRESH_B}; Path=/auth/refresh; HttpOnly; Secure; SameSite=Lax`,
              },
            },
          );
        }
        if (url === 'https://gateway.internal/v1/tasks/task-1') {
          taskRequests += 1;
          return refreshed ? Response.json(task) : new Response(null, { status: 401 });
        }
        throw new Error('UNEXPECTED_FETCH');
      }),
    );
    vi.resetModules();
    const client = await import('../lib/auth/client-session');

    const response = await client.fetchWithSessionRefresh(() =>
      pollTask(new Request('https://app.example/api/tasks/task-1'), {
        params: Promise.resolve({ id: 'task-1' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(gatewayRefreshes).toBe(1);
    expect(taskRequests).toBe(3);
    expect(cookies.get('__Host-user-session')).not.toBe(oldCookie);
  });

  it('cancels upstream bodies when poll or stream errors are replaced', async () => {
    const cancelPoll = vi.fn();
    const cancelStream = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(new ReadableStream<Uint8Array>({ cancel: cancelPoll }), { status: 503 }),
        )
        .mockResolvedValueOnce(
          new Response(new ReadableStream<Uint8Array>({ cancel: cancelStream }), { status: 429 }),
        ),
    );

    const pollResponse = await pollTask(new Request('https://app.example/api/tasks/task-1'), {
      params: Promise.resolve({ id: 'task-1' }),
    });
    const streamResponse = await streamTask(
      new Request('https://app.example/api/tasks/task-1/events'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(pollResponse.status).toBe(503);
    expect(streamResponse.status).toBe(429);
    expect(cancelPoll).toHaveBeenCalledTimes(1);
    expect(cancelStream).toHaveBeenCalledTimes(1);
  });

  it('returns only a minimal validated status envelope from polling', async () => {
    const task = await taskGateway.getTask('task-1', { ownerId: VERIFIED_PHONE_OWNER });
    const upstreamFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json(task));
    vi.stubGlobal('fetch', upstreamFetch);

    const response = await pollTask(new Request('https://app.example/api/tasks/task-1'), {
      params: Promise.resolve({ id: 'task-1' }),
    });

    expect(response.status).toBe(200);
    const responseText = await response.clone().text();
    expect(responseText).not.toContain('parametersSnapshot');
    expect(responseText).not.toContain('financial');
    expect(responseText).not.toContain('prompt');
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('does not clear a session merely because the Gateway asks for refresh', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })),
    );
    const failed = await pollTask(new Request('https://app.example/api/tasks/task-1'), {
      params: Promise.resolve({ id: 'task-1' }),
    });
    expect(failed.status).toBe(401);
    expect(deletedCookies).toEqual([]);

    const unknown = await pollTask(new Request('https://app.example/api/tasks/task-1'), {
      params: Promise.resolve({ id: 'task-1' }),
    });
    expect(unknown.status).toBe(401);
  });

  it('fails closed for an expired app session without contacting the Gateway', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1_000);
    const upstreamFetch = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', upstreamFetch);

    const response = await pollTask(new Request('https://app.example/api/tasks/task-1'), {
      params: Promise.resolve({ id: 'task-1' }),
    });

    expect(response.status).toBe(401);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('keeps an expired RSC read side-effect free so rendering never mutates cookies', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 901_000);
    const refreshFetch = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', refreshFetch);

    await expect(readAuthenticatedServerSession()).resolves.toBeUndefined();
    await expect(readAuthenticatedServerSessionState()).resolves.toEqual({
      kind: 'needs-refresh',
    });
    expect(refreshFetch).not.toHaveBeenCalled();
    expect(deletedCookies).toEqual([]);
  });

  it('reports same-origin session status without exposing data or mutating cookies', async () => {
    const writesBefore = cookieWrites.length;
    const active = await readRefreshSessionStatus(
      new Request('https://app.example/auth/refresh', {
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
    );
    expect(active.status).toBe(204);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 901_000);
    const expired = await readRefreshSessionStatus(
      new Request('https://app.example/auth/refresh', {
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
    );
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toEqual({ code: 'SESSION_REFRESH_REQUIRED' });

    const crossSite = await readRefreshSessionStatus(
      new Request('https://app.example/auth/refresh', {
        headers: { 'sec-fetch-site': 'cross-site' },
      }),
    );
    expect(crossSite.status).toBe(403);
    expect(cookieWrites).toHaveLength(writesBefore);
    expect(deletedCookies).toEqual([]);
  });

  it('refreshes in a mutable same-origin route and returns to an allowlisted task page', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 901_000);
    const oldCookie = cookies.get('__Host-user-session');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            accessToken: accessToken('route-refresh', ROTATED_SESSION_ID),
            sessionId: ROTATED_SESSION_ID,
          },
          {
            headers: {
              'Set-Cookie': `refresh_token=${REFRESH_B}; Path=/auth/refresh; HttpOnly; Secure; SameSite=Lax`,
            },
          },
        ),
      ),
    );

    const response = await refreshSession(
      new Request('https://app.example/auth/refresh', {
        headers: { origin: 'https://app.example', 'sec-fetch-site': 'same-origin' },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(204);
    expect(cookies.get('__Host-user-session')).not.toBe(oldCookie);
  });

  it('fails closed when an old encrypted cookie replays its consumed refresh token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 901_000);
    const oldCookie = cookies.get('__Host-user-session');
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json(
            {
              accessToken: accessToken('rotated-once', ROTATED_SESSION_ID),
              sessionId: ROTATED_SESSION_ID,
            },
            {
              headers: {
                'Set-Cookie': `refresh_token=${REFRESH_B}; Path=/auth/refresh; HttpOnly; Secure; SameSite=Lax`,
              },
            },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 401 })),
    );
    await refreshSession(
      new Request('https://app.example/auth/refresh', {
        headers: { origin: 'https://app.example', 'sec-fetch-site': 'same-origin' },
        method: 'POST',
      }),
    );
    cookies.set('__Host-user-session', oldCookie ?? '');
    cookies.set('refresh_token', REFRESH_A);

    const replay = await refreshSession(
      new Request('https://app.example/auth/refresh', {
        headers: { origin: 'https://app.example', 'sec-fetch-site': 'same-origin' },
        method: 'POST',
      }),
    );

    expect(replay.status).toBe(401);
    expect(deletedCookies).toContain('__Host-user-session');
  });

  it('rejects cross-origin refresh attempts before rotating credentials', async () => {
    const upstreamFetch = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', upstreamFetch);
    const response = await refreshSession(
      new Request('https://app.example/auth/refresh', {
        headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(403);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('clears both cookies at their exact paths when route refresh fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 901_000);
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })),
    );
    const response = await refreshSession(
      new Request('https://app.example/auth/refresh', {
        headers: { origin: 'https://app.example', 'sec-fetch-site': 'same-origin' },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(401);
    expect(deletedCookies).toContain('__Host-user-session');
    expect(cookieWrites).toContainEqual({
      name: 'refresh_token',
      value: '',
      options: {
        httpOnly: true,
        maxAge: 0,
        path: '/auth/refresh',
        sameSite: 'lax',
        secure: true,
      },
    });
  });

  it('turns refresh transport and lock rejection into a fail-closed result', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
          return callback();
        },
      },
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')));
    vi.resetModules();
    const client = await import('../lib/auth/client-session');

    await expect(client.coordinateSessionRefresh()).resolves.toBe(false);

    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: () => Promise.reject(new Error('lock unavailable')) },
    });
    vi.resetModules();
    const isolatedClient = await import('../lib/auth/client-session');
    await expect(isolatedClient.coordinateSessionRefresh()).resolves.toBe(false);
  });

  it('deduplicates two expired RSC trampoline refreshes across isolated tabs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 901_000);
    let lockTail = Promise.resolve();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
          const result = lockTail.then(callback);
          lockTail = result.then(
            () => undefined,
            () => undefined,
          );
          return result;
        },
      },
    });
    let gatewayRefreshes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === '/auth/refresh') {
          const request = new Request('https://app.example/auth/refresh', {
            headers: { origin: 'https://app.example', 'sec-fetch-site': 'same-origin' },
            method: init?.method ?? 'GET',
          });
          return init?.method === 'POST'
            ? refreshSession(request)
            : readRefreshSessionStatus(request);
        }
        gatewayRefreshes += 1;
        return Response.json(
          {
            accessToken: accessToken('coordinated-refresh', ROTATED_SESSION_ID),
            sessionId: ROTATED_SESSION_ID,
          },
          {
            headers: {
              'Set-Cookie': `refresh_token=${REFRESH_B}; Path=/auth/refresh; HttpOnly; Secure; SameSite=Lax`,
            },
          },
        );
      }),
    );
    vi.resetModules();
    const tabA = await import('../lib/auth/client-session');
    vi.resetModules();
    const tabB = await import('../lib/auth/client-session');

    await expect(
      Promise.all([tabA.coordinateSessionRefresh(), tabB.coordinateSessionRefresh()]),
    ).resolves.toEqual([true, true]);
    expect(gatewayRefreshes).toBe(1);
  });

  it('rechecks the original request under the cross-tab lock before refreshing', async () => {
    let lockTail = Promise.resolve();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
          const result = lockTail.then(callback);
          lockTail = result.then(
            () => undefined,
            () => undefined,
          );
          return result;
        },
      },
    });
    let refreshed = false;
    let refreshPosts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url !== '/auth/refresh') throw new Error('UNEXPECTED_FETCH');
        refreshPosts += 1;
        refreshed = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }),
    );
    vi.resetModules();
    const tabA = await import('../lib/auth/client-session');
    vi.resetModules();
    const tabB = await import('../lib/auth/client-session');
    const discardedBodies: Array<ReturnType<typeof vi.fn>> = [];
    const refreshRequiredResponse = () => {
      const response = Response.json({ code: 'SESSION_REFRESH_REQUIRED' }, { status: 401 });
      if (!response.body) throw new Error('MISSING_RESPONSE_BODY');
      const body = response.body;
      Object.defineProperty(response, 'body', { value: body });
      const cancel = vi.spyOn(body, 'cancel');
      discardedBodies.push(cancel);
      return response;
    };
    const requestA = vi.fn(() =>
      Promise.resolve(refreshed ? new Response(null, { status: 200 }) : refreshRequiredResponse()),
    );
    const requestB = vi.fn(() =>
      Promise.resolve(refreshed ? new Response(null, { status: 200 }) : refreshRequiredResponse()),
    );

    const [responseA, responseB] = await Promise.all([
      tabA.fetchWithSessionRefresh(requestA),
      tabB.fetchWithSessionRefresh(requestB),
    ]);

    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    expect(refreshPosts).toBe(1);
    // The first caller performs one lock-protected preflight and one post-rotation retry.
    expect(requestA).toHaveBeenCalledTimes(3);
    expect(requestB).toHaveBeenCalledTimes(2);
    expect(discardedBodies).toHaveLength(3);
    expect(discardedBodies.map((cancel) => cancel.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it('fails closed without attempting a refresh when Web Locks are unavailable', async () => {
    const refreshFetch = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', refreshFetch);
    vi.resetModules();
    const client = await import('../lib/auth/client-session');
    const request = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(Response.json({ code: 'SESSION_REFRESH_REQUIRED' }, { status: 401 }));

    const response = await client.fetchWithSessionRefresh(request);

    expect(response.status).toBe(401);
    expect(request).toHaveBeenCalledTimes(1);
    expect(refreshFetch).not.toHaveBeenCalled();
  });

  it('fails closed instead of proxying a malformed polling payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ taskId: 'task-1', accessToken: 'must-not-cross-the-bff' }),
        ),
    );

    const response = await pollTask(new Request('https://app.example/api/tasks/task-1'), {
      params: Promise.resolve({ id: 'task-1' }),
    });

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('must-not-cross-the-bff');
  });
});
