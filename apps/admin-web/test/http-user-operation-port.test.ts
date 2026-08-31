/* eslint-disable @typescript-eslint/require-await -- async fetch fakes implement the platform contract. */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpUserOperationPorts } from '../lib/http-user-operation-port';

const environment = {
  apiUrl: 'https://operations.example.invalid',
  kmsIdentityReference: 'kms://service/admin-web',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

function telemetryCapture() {
  const events: unknown[] = [];
  return {
    events,
    telemetry: {
      record(event: unknown) {
        events.push(event);
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HTTP user operation ports', () => {
  it('validates HTTPS and KMS configuration at construction', () => {
    const capture = telemetryCapture();

    expect(() =>
      createHttpUserOperationPorts(
        { apiUrl: 'http://operations.example.invalid' },
        { telemetry: capture.telemetry },
      ),
    ).toThrow();
    expect(capture.events).toEqual([
      { operation: 'operations.config', reason: 'INVALID_CONFIG' },
    ]);
  });

  it('adds deadlines and KMS identity to scope reads', async () => {
    let request: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init?: RequestInit) => {
        request = init;
        return jsonResponse({ ownerAdminId: null, assignedAdminIds: [] });
      }),
    );
    const { scopePort } = createHttpUserOperationPorts(environment, {
      deadlineMs: 25,
    });

    await scopePort.getUserScope('user-9');

    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.redirect).toBe('error');
    expect(new Headers(request?.headers).get('X-Service-Identity-Ref')).toBe(
      environment.kmsIdentityReference,
    );
  });

  it('aborts timed-out operations calls with sanitized telemetry', async () => {
    const capture = telemetryCapture();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) {
            reject(new Error('missing deadline'));
            return;
          }
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('timed out', 'AbortError'));
          });
        }),
      ),
    );
    const { scopePort } = createHttpUserOperationPorts(environment, {
      deadlineMs: 1,
      telemetry: capture.telemetry,
    });

    await expect(scopePort.getUserScope('sensitive-user-id')).rejects.toThrow();
    expect(capture.events).toContainEqual({
      operation: 'operations.scope.read',
      reason: 'TIMEOUT',
    });
    expect(JSON.stringify(capture.events)).not.toContain('sensitive-user-id');
  });

  it('keeps the deadline active while consuming an operations response body', async () => {
    const capture = telemetryCapture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init?: RequestInit) =>
        ({
          ok: true,
          json: () =>
            new Promise<unknown>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('timed out', 'AbortError'));
              });
            }),
        }) as Response,
      ),
    );
    const { scopePort } = createHttpUserOperationPorts(environment, {
      deadlineMs: 1,
      telemetry: capture.telemetry,
    });

    await expect(scopePort.getUserScope('user-9')).rejects.toThrow();
    expect(capture.events).toContainEqual({
      operation: 'operations.scope.read',
      reason: 'TIMEOUT',
    });
  });

  it('rejects malformed scope responses and records a reason code', async () => {
    const capture = telemetryCapture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ownerAdminId: 7, assignedAdminIds: [] })),
    );
    const { scopePort } = createHttpUserOperationPorts(environment, {
      telemetry: capture.telemetry,
    });

    await expect(scopePort.getUserScope('user-9')).rejects.toThrow();
    expect(capture.events).toContainEqual({
      operation: 'operations.scope.read',
      reason: 'MALFORMED_RESPONSE',
    });
  });

  it('forwards the trusted server session to the atomic mutation endpoint', async () => {
    let requestedUrl = '';
    let request: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        requestedUrl = String(url);
        request = init;
        return new Response(null, { status: 204 });
      }),
    );
    const { operationPort } = createHttpUserOperationPorts(environment);

    await operationPort.refreshUser({
      userId: 'user-9',
      trustedSessionToken: 'trusted-signed-session',
    });

    expect(requestedUrl).toContain('/v1/admin/users/user-9/refresh');
    expect(new Headers(request?.headers).get('X-Admin-Session-Token')).toBe(
      'trusted-signed-session',
    );
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails closed on authoritative downstream denial without leaking the session', async () => {
    const capture = telemetryCapture();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 403)));
    const { operationPort } = createHttpUserOperationPorts(environment, {
      telemetry: capture.telemetry,
    });

    await expect(
      operationPort.refreshUser({
        userId: 'user-9',
        trustedSessionToken: 'sensitive-session-token',
      }),
    ).rejects.toThrow();
    expect(capture.events).toContainEqual({
      operation: 'operations.user.refresh',
      reason: 'DOWNSTREAM_DENIED',
    });
    expect(JSON.stringify(capture.events)).not.toContain(
      'sensitive-session-token',
    );
  });
});
