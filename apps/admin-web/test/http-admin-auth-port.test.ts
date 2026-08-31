/* eslint-disable @typescript-eslint/require-await -- async fetch fakes implement the platform contract. */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_MFA_CHALLENGE_TTL_MS,
  ADMIN_MFA_CHALLENGE_TTL_SECONDS,
  createHttpAdminAuthPort,
} from '../lib/http-admin-auth-port';

const environment = {
  apiUrl: 'https://iam.example.invalid',
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

const validChallengeId = 'A'.repeat(43);

function passwordBody(overrides: Record<string, unknown> = {}) {
  return {
    challengeId: validChallengeId,
    expiresInSeconds: ADMIN_MFA_CHALLENGE_TTL_SECONDS,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HTTP AdminAuthPort', () => {
  it('validates HTTPS and KMS configuration when the port is constructed', () => {
    const capture = telemetryCapture();

    expect(() =>
      createHttpAdminAuthPort(
        { apiUrl: 'http://iam.example.invalid', kmsIdentityReference: '' },
        { telemetry: capture.telemetry },
      ),
    ).toThrow();
    expect(capture.events).toEqual([
      { operation: 'iam.config', reason: 'INVALID_CONFIG' },
    ]);
  });

  it('adds a bounded abort signal and KMS identity to password requests', async () => {
    let request: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init?: RequestInit) => {
        request = init;
        return jsonResponse({
          ...passwordBody(),
        });
      }),
    );
    const port = createHttpAdminAuthPort(environment, {
      deadlineMs: 25,
      now: () => 1_000_000_000,
    });

    await expect(port.beginPasswordChallenge({
      identifier: 'operator@example.invalid',
      password: 'sensitive-password',
    })).resolves.toEqual({
      challengeId: validChallengeId,
      expiresAt: 1_000_000_000 + ADMIN_MFA_CHALLENGE_TTL_MS,
    });

    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.redirect).toBe('error');
    expect(new Headers(request?.headers).get('X-Service-Identity-Ref')).toBe(
      environment.kmsIdentityReference,
    );
  });

  it('aborts timed-out IAM calls and emits only a sanitized reason code', async () => {
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
    const port = createHttpAdminAuthPort(environment, {
      deadlineMs: 1,
      telemetry: capture.telemetry,
    });

    const timeoutResult = await port.beginPasswordChallenge({
      identifier: 'sensitive-identifier',
      password: 'sensitive-password',
    });
    expect(typeof timeoutResult.expiresAt).toBe('number');
    expect(capture.events).toContainEqual({
      operation: 'iam.password.begin',
      reason: 'TIMEOUT',
    });
    expect(JSON.stringify(capture.events)).not.toMatch(
      /sensitive-identifier|sensitive-password/,
    );
  });

  it('keeps the deadline active while consuming an IAM response body', async () => {
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
    const port = createHttpAdminAuthPort(environment, {
      deadlineMs: 1,
      telemetry: capture.telemetry,
    });

    const bodyTimeoutResult = await port.beginPasswordChallenge({
      identifier: 'admin',
      password: 'secret',
    });
    expect(typeof bodyTimeoutResult.expiresAt).toBe('number');
    expect(capture.events).toContainEqual({
      operation: 'iam.password.begin',
      reason: 'TIMEOUT',
    });
  });

  it('normalizes malformed challenge responses into a fixed-shape decoy', async () => {
    const capture = telemetryCapture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ...passwordBody({ expiresInSeconds: ADMIN_MFA_CHALLENGE_TTL_SECONDS + 1 }),
        }),
      ),
    );
    const port = createHttpAdminAuthPort(environment, {
      now: () => 1_000_000,
      telemetry: capture.telemetry,
    });

    await expect(
      port.beginPasswordChallenge({ identifier: 'admin', password: 'secret' }),
    ).resolves.toMatchObject({
      expiresAt: 1_000_000 + ADMIN_MFA_CHALLENGE_TTL_MS,
    });
    const result = await port.beginPasswordChallenge({
      identifier: 'admin',
      password: 'secret',
    });
    expect(result.challengeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.expiresAt).toBe(1_000_000 + ADMIN_MFA_CHALLENGE_TTL_MS);
    expect(capture.events).toContainEqual({
      operation: 'iam.password.begin',
      reason: 'MALFORMED_RESPONSE',
    });
  });

  it.each([
    ['non-2xx', () => jsonResponse(passwordBody(), 401)],
    ['too-short ID', () => jsonResponse(passwordBody({ challengeId: 'short' }))],
    ['too-long ID', () => jsonResponse(passwordBody({ challengeId: 'A'.repeat(44) }))],
    ['invalid ID characters', () => jsonResponse(passwordBody({ challengeId: 'A'.repeat(42) + '!' }))],
    ['variable TTL', () => jsonResponse(passwordBody({ expiresInSeconds: 599 }))],
    ['legacy timestamp', () => jsonResponse({ challengeId: validChallengeId, expiresAt: 1_000_120_000 })],
  ])('returns an indistinguishable decoy for %s', async (_label, response) => {
    vi.stubGlobal('fetch', vi.fn(async () => response()));
    const port = createHttpAdminAuthPort(environment, { now: () => 1_000_000 });

    await expect(
      port.beginPasswordChallenge({ identifier: 'admin', password: 'secret' }),
    ).resolves.toSatisfy((result) => {
      const challenge = result as { challengeId: string; expiresAt: number };
      return (
        /^[A-Za-z0-9_-]{43}$/.test(challenge.challengeId) &&
        challenge.expiresAt === 1_000_000 + ADMIN_MFA_CHALLENGE_TTL_MS
      );
    });
  });

  it.each([
    ['timeout', (_url: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('timed out', 'AbortError'));
      });
    })],
    ['network', () => Promise.reject(new Error('offline'))],
  ])('returns an indistinguishable decoy for %s', async (_label, fetchImpl) => {
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    const port = createHttpAdminAuthPort(environment, {
      deadlineMs: 1,
      now: () => 1_000_000,
    });

    await expect(
      port.beginPasswordChallenge({ identifier: 'admin', password: 'secret' }),
    ).resolves.toMatchObject({
      expiresAt: 1_000_000 + ADMIN_MFA_CHALLENGE_TTL_MS,
    });
  });

  it('recognizes an authoritative consumed challenge outcome', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ kind: 'CONSUMED' })),
    );
    const port = createHttpAdminAuthPort(environment);

    await expect(
      port.verifyTotp({
        challengeId: '11111111-1111-4111-8111-111111111111',
        code: '042731',
      }),
    ).resolves.toEqual({ kind: 'CONSUMED' });
  });

  it('never includes credentials, codes, or challenge ids in failure telemetry', async () => {
    const capture = telemetryCapture();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    const port = createHttpAdminAuthPort(environment, {
      telemetry: capture.telemetry,
    });

    await expect(
      port.verifyTotp({
        challengeId: 'sensitive-challenge-id',
        code: '123456',
      }),
    ).rejects.toThrow();
    expect(capture.events).toContainEqual({
      operation: 'iam.totp.verify',
      reason: 'NETWORK_FAILURE',
    });
    expect(JSON.stringify(capture.events)).not.toMatch(
      /sensitive-challenge-id|123456/,
    );
  });
});
