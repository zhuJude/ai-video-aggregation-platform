import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as pollTask } from '../app/api/tasks/[id]/route';
import { GET as streamTask } from '../app/api/tasks/[id]/events/route';
import {
  establishAuthenticatedServerSession,
  readAuthenticatedServerSession,
} from '../lib/auth/server-session';
import { taskGateway } from '../lib/tasks/gateway';

const OWNER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a6101';
const SESSION_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a6111';
const ROTATED_SESSION_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a6112';
const cookies = vi.hoisted(() => new Map<string, string>());
const deletedCookies = vi.hoisted(() => [] as string[]);

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
      set: (name: string, value: string) => cookies.set(name, value),
    }),
}));

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const accessToken = (suffix: string, sessionId = SESSION_ID) =>
  `${encode({ alg: 'ES256', typ: 'JWT' })}.${encode({
    aud: 'user-web',
    exp: Math.floor(Date.now() / 1_000) + 900,
    iss: 'identity-service',
    sid: sessionId,
    sub: OWNER_ID,
  })}.${suffix}`;
const REFRESH_A = 'A'.repeat(43);
const REFRESH_B = 'B'.repeat(43);

beforeEach(async () => {
  cookies.clear();
  deletedCookies.length = 0;
  process.env.USER_WEB_SESSION_SIGNING_KEY = 'test-only-session-signing-key-32-bytes-minimum';
  process.env.GATEWAY_URL = 'https://gateway.internal';
  process.env.IDENTITY_SERVICE_URL = 'https://identity.internal';
  await establishAuthenticatedServerSession(accessToken('first-signature'), SESSION_ID, REFRESH_A);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('authenticated task BFF', () => {
  it('adds Bearer auth, forwards a valid cursor and streams without buffering', async () => {
    const upstreamBody = new ReadableStream<Uint8Array>();
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
    expect(forwarded.headers.get('authorization')).toBe(`Bearer ${accessToken('first-signature')}`);
    expect(forwarded.headers.get('last-event-id')).toBe(cursor);
    expect(response.body).toBe(upstreamBody);
    expect(response.headers.get('x-accel-buffering')).toBe('no');
  });

  it('rotates refresh server-side and retries an upstream 401 exactly once', async () => {
    const task = await taskGateway.getTask('task-1', { ownerId: OWNER_ID });
    const upstreamFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            accessToken: accessToken('rotated-signature', ROTATED_SESSION_ID),
            sessionId: ROTATED_SESSION_ID,
          },
          {
            headers: {
              'Set-Cookie': `refresh_token=${REFRESH_B}; Path=/auth/refresh; HttpOnly; Secure; SameSite=Lax`,
            },
          },
        ),
      )
      .mockResolvedValueOnce(Response.json(task));
    vi.stubGlobal('fetch', upstreamFetch);

    const response = await pollTask(new Request('https://app.example/api/tasks/task-1'), {
      params: Promise.resolve({ id: 'task-1' }),
    });

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(3);
    const [refresh, refreshInit] = upstreamFetch.mock.calls[1] ?? [];
    const refreshRequest = new Request(refresh as string | URL | Request, refreshInit);
    expect(refreshRequest.url).toBe('https://identity.internal/v1/auth/refresh');
    expect(refreshRequest.headers.get('cookie')).toBe(`refresh_token=${REFRESH_A}`);
    const [retry, retryInit] = upstreamFetch.mock.calls[2] ?? [];
    const retryRequest = new Request(retry as string | URL | Request, retryInit);
    expect(retryRequest.headers.get('authorization')).toBe(
      `Bearer ${accessToken('rotated-signature', ROTATED_SESSION_ID)}`,
    );
  });

  it('clears the app session when refresh fails and rejects unknown sessions', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(new Response(null, { status: 401 })),
    );
    const failed = await pollTask(new Request('https://app.example/api/tasks/task-1'), {
      params: Promise.resolve({ id: 'task-1' }),
    });
    expect(failed.status).toBe(401);
    expect(deletedCookies).toContain('__Host-user-session');

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

  it('refreshes an expired access token before authorizing an SSR or Server Action read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 901_000);
    const refreshFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          accessToken: accessToken('proactive-refresh', ROTATED_SESSION_ID),
          sessionId: ROTATED_SESSION_ID,
        },
        {
          headers: {
            'Set-Cookie': `refresh_token=${REFRESH_B}; Path=/auth/refresh; HttpOnly; Secure; SameSite=Lax`,
          },
        },
      ),
    );
    vi.stubGlobal('fetch', refreshFetch);

    await expect(readAuthenticatedServerSession()).resolves.toEqual({ ownerId: OWNER_ID });
    expect(refreshFetch).toHaveBeenCalledTimes(1);
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
