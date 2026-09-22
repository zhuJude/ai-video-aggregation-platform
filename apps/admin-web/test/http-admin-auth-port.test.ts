/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- Vitest asymmetric matchers are typed as any; async fetch fakes implement the platform contract. */

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
const flowCorrelationId = '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f';
const challengeIntentId = '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f';
const totpIntentId = '0198f7a4-c6db-7b39-8a4e-73af0c1d2e3f';
const traceIdPattern = /^[0-9a-f]{32}$/u;
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
  it('shares a frozen flow correlation, uses command idempotency keys, and creates a fresh trace per HTTP attempt', async () => {
    const requests: Array<{ headers: Headers; url: string }> = [];
    const port = createHttpAdminAuthPort(environment, {
      fetchImpl: async (input, init) => {
        const url =
          input instanceof URL ? input.href : input instanceof Request ? input.url : input;
        requests.push({ headers: new Headers(init?.headers), url });
        return url.endsWith('/password/challenges')
          ? jsonResponse(passwordBody())
          : jsonResponse({ kind: 'CONSUMED' });
      },
      now: () => 1_000_000,
    });
    const passwordInput = {
      correlationId: flowCorrelationId,
      idempotencyKey: challengeIntentId,
      identifier: 'admin',
      password: 'secret',
    };
    await port.beginPasswordChallenge(passwordInput);
    await port.beginPasswordChallenge(passwordInput);
    await port.verifyTotp({
      challengeId: validChallengeId,
      code: '042731',
      correlationId: flowCorrelationId,
      idempotencyKey: totpIntentId,
    });
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.headers.get('Content-Type')).toBe('application/json');
      expect(request.headers.get('X-Service-Identity-Ref')).toBe(environment.kmsIdentityReference);
      expect(request.headers.get('X-Trace-Id')).toMatch(/^[0-9a-f]{32}$/u);
      expect(request.headers.get('X-Correlation-Id')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      );
      expect(request.headers.get('X-Trace-Id')).not.toBe(request.headers.get('X-Correlation-Id'));
      expect(request.headers.get('X-Correlation-Id')).toBe(flowCorrelationId);
    }
    expect(requests[0]?.headers.get('Idempotency-Key')).toBe(challengeIntentId);
    expect(requests[1]?.headers.get('Idempotency-Key')).toBe(challengeIntentId);
    expect(requests[2]?.headers.get('Idempotency-Key')).toBe(totpIntentId);
    expect(new Set(requests.map(({ headers }) => headers.get('X-Trace-Id'))).size).toBe(3);
  });

  it.each([' bad ', '550e8400-e29b-41d4-a716-446655440000'])(
    'rejects malformed command ids before fetch: %s',
    async (invalidId) => {
      const fetchImpl = vi.fn(async () => jsonResponse(passwordBody()));
      const port = createHttpAdminAuthPort(environment, { fetchImpl });
      await expect(
        port.beginPasswordChallenge({
          correlationId: invalidId,
          idempotencyKey: challengeIntentId,
          identifier: 'admin',
          password: 'secret',
        }),
      ).rejects.toThrow('Invalid MFA request context');
      await expect(
        port.verifyTotp({
          challengeId: validChallengeId,
          code: '042731',
          correlationId: flowCorrelationId,
          idempotencyKey: invalidId,
        }),
      ).rejects.toThrow('Invalid MFA request context');
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('rejects a non-canonical 32-byte challenge id before TOTP fetch', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ kind: 'CONSUMED' }));
    const port = createHttpAdminAuthPort(environment, { fetchImpl });
    const alias = `${validChallengeId.slice(0, -1)}B`;
    await expect(
      port.verifyTotp({
        challengeId: alias,
        code: '042731',
        correlationId: flowCorrelationId,
        idempotencyKey: totpIntentId,
      }),
    ).rejects.toThrow('Invalid MFA challenge ID');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('validates HTTPS and KMS configuration when the port is constructed', () => {
    const capture = telemetryCapture();

    expect(() =>
      createHttpAdminAuthPort(
        { apiUrl: 'http://iam.example.invalid', kmsIdentityReference: '' },
        { telemetry: capture.telemetry },
      ),
    ).toThrow();
    expect(capture.events).toHaveLength(1);
    const event = capture.events[0] as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual(['correlationId', 'operation', 'reason', 'traceId']);
    expect(event.operation).toBe('iam.config');
    expect(event.reason).toBe('INVALID_CONFIG');
    expect(event.correlationId).toMatch(uuidV7Pattern);
    expect(event.traceId).toMatch(traceIdPattern);
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

    await expect(
      port.beginPasswordChallenge({
        identifier: 'operator@example.invalid',
        password: 'sensitive-password',
      }),
    ).resolves.toEqual({
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
      vi.fn(
        (_url: URL, init?: RequestInit) =>
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
    expect(capture.events).toContainEqual(
      expect.objectContaining({
        correlationId: expect.stringMatching(uuidV7Pattern),
        operation: 'iam.password.begin',
        reason: 'TIMEOUT',
        traceId: expect.stringMatching(traceIdPattern),
      }),
    );
    expect(JSON.stringify(capture.events)).not.toMatch(/sensitive-identifier|sensitive-password/);
  });

  it('keeps the deadline active while consuming an IAM response body', async () => {
    const capture = telemetryCapture();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: URL, init?: RequestInit) =>
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
    expect(capture.events).toContainEqual(
      expect.objectContaining({
        correlationId: expect.stringMatching(uuidV7Pattern),
        operation: 'iam.password.begin',
        reason: 'TIMEOUT',
        traceId: expect.stringMatching(traceIdPattern),
      }),
    );
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
    expect(capture.events).toContainEqual(
      expect.objectContaining({
        correlationId: expect.stringMatching(uuidV7Pattern),
        operation: 'iam.password.begin',
        reason: 'MALFORMED_RESPONSE',
        traceId: expect.stringMatching(traceIdPattern),
      }),
    );
  });

  it.each([
    ['non-2xx', () => jsonResponse(passwordBody(), 401)],
    ['too-short ID', () => jsonResponse(passwordBody({ challengeId: 'short' }))],
    ['too-long ID', () => jsonResponse(passwordBody({ challengeId: 'A'.repeat(44) }))],
    [
      'invalid ID characters',
      () => jsonResponse(passwordBody({ challengeId: 'A'.repeat(42) + '!' })),
    ],
    ['variable TTL', () => jsonResponse(passwordBody({ expiresInSeconds: 599 }))],
    [
      'legacy timestamp',
      () => jsonResponse({ challengeId: validChallengeId, expiresAt: 1_000_120_000 }),
    ],
  ])('returns an indistinguishable decoy for %s', async (_label, response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response()),
    );
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

  it('marks an authoritative password denial as safe to rotate while keeping network uncertainty retryable', async () => {
    const denied = createHttpAdminAuthPort(environment, {
      fetchImpl: async () => jsonResponse({ kind: 'REJECTED', reason: 'INVALID_CREDENTIALS' }, 401),
      now: () => 1_000_000,
    });
    const uncertain = createHttpAdminAuthPort(environment, {
      fetchImpl: async () => Promise.reject(new Error('lost')),
      now: () => 1_000_000,
    });
    await expect(
      denied.beginPasswordChallenge({
        correlationId: flowCorrelationId,
        idempotencyKey: challengeIntentId,
        identifier: 'admin',
        password: 'secret',
      }),
    ).resolves.toMatchObject({ rotateIntent: true });
    await expect(
      uncertain.beginPasswordChallenge({
        correlationId: flowCorrelationId,
        idempotencyKey: challengeIntentId,
        identifier: 'admin',
        password: 'secret',
      }),
    ).resolves.not.toHaveProperty('rotateIntent');
  });

  it.each([
    ['accepted challenge extra', 200, { ...passwordBody(), secret: 'tainted' }],
    [
      'rejected challenge extra',
      401,
      { kind: 'REJECTED', reason: 'INVALID_CREDENTIALS', password: 'tainted' },
    ],
  ])('treats %s fields as indeterminate', async (_label, status, body) => {
    const port = createHttpAdminAuthPort(environment, {
      fetchImpl: async () => jsonResponse(body, status),
      now: () => 1_000_000,
    });
    await expect(
      port.beginPasswordChallenge({
        correlationId: flowCorrelationId,
        idempotencyKey: challengeIntentId,
        identifier: 'admin',
        password: 'secret',
      }),
    ).resolves.toMatchObject({ indeterminate: true });
  });

  it('keeps the command key for a malformed strict password rejection', async () => {
    const headers: Headers[] = [];
    const port = createHttpAdminAuthPort(environment, {
      fetchImpl: async (_input, init) => {
        headers.push(new Headers(init?.headers));
        return jsonResponse(
          { kind: 'REJECTED', reason: 'INVALID_CREDENTIALS', secret: 'tainted' },
          401,
        );
      },
      now: () => 1_000_000,
    });
    const input = {
      correlationId: flowCorrelationId,
      idempotencyKey: challengeIntentId,
      identifier: 'admin',
      password: 'secret',
    };
    await expect(port.beginPasswordChallenge(input)).resolves.toMatchObject({
      indeterminate: true,
    });
    await expect(port.beginPasswordChallenge(input)).resolves.toMatchObject({
      indeterminate: true,
    });
    expect(headers.map((header) => header.get('Idempotency-Key'))).toEqual([
      challengeIntentId,
      challengeIntentId,
    ]);
  });

  it.each([
    ['500', () => jsonResponse({}, 500)],
    ['429', () => jsonResponse({}, 429)],
    ['malformed 2xx', () => jsonResponse({ challengeId: 'bad' })],
    ['invalid JSON', () => new Response('{', { status: 200 })],
    ['network', () => Promise.reject(new Error('lost'))],
  ])(
    'keeps %s password outcomes indeterminate and the caller key retryable',
    async (_label, response) => {
      const headers: Headers[] = [];
      const port = createHttpAdminAuthPort(environment, {
        fetchImpl: async (_input, init) => {
          headers.push(new Headers(init?.headers));
          return response();
        },
        now: () => 1_000_000,
      });
      const input = {
        correlationId: flowCorrelationId,
        idempotencyKey: challengeIntentId,
        identifier: 'admin',
        password: 'secret',
      };
      const first = await port.beginPasswordChallenge(input);
      const second = await port.beginPasswordChallenge(input);
      expect(first).not.toHaveProperty('rotateIntent');
      expect(second).not.toHaveProperty('rotateIntent');
      expect(headers.map((value) => value.get('Idempotency-Key'))).toEqual([
        challengeIntentId,
        challengeIntentId,
      ]);
    },
  );

  it.each([
    [
      'timeout',
      (_url: URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('timed out', 'AbortError'));
          });
        }),
    ],
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
        challengeId: validChallengeId,
        code: '042731',
      }),
    ).resolves.toEqual({ kind: 'CONSUMED' });
  });

  it.each([
    ['consumed top-level extra', { kind: 'CONSUMED', secret: 'tainted' }],
    ['rejected top-level extra', { kind: 'REJECTED', attemptsRemaining: 3, code: 'tainted' }],
    [
      'authenticated top-level extra',
      {
        kind: 'AUTHENTICATED',
        expiresAt: 1_060_000,
        subject: {
          dataScope: 'ALL',
          permissions: ['overview:read'],
          subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        },
        password: 'tainted',
      },
    ],
    [
      'authenticated subject extra',
      {
        kind: 'AUTHENTICATED',
        expiresAt: 1_060_000,
        subject: {
          dataScope: 'ALL',
          permissions: ['overview:read'],
          subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
          secret: 'tainted',
        },
      },
    ],
  ])('rejects %s instead of returning tainted IAM authority', async (_label, body) => {
    const port = createHttpAdminAuthPort(environment, {
      fetchImpl: async () => jsonResponse(body),
      now: () => 1_000_000,
    });
    await expect(
      port.verifyTotp({
        challengeId: validChallengeId,
        code: '042731',
        correlationId: flowCorrelationId,
        idempotencyKey: totpIntentId,
      }),
    ).rejects.toThrow();
  });

  it.each([
    ['unknown permission', ['overview:read', 'root:everything']],
    ['duplicate permission', ['overview:read', 'overview:read']],
    ['too many permissions', Array.from({ length: 20 }, () => 'overview:read')],
    ['overlong permission', ['x'.repeat(5000)]],
  ])(
    'rejects an IAM subject with %s before it can reach session issuance',
    async (_label, permissions) => {
      const body = {
        expiresAt: 1_060_000,
        kind: 'AUTHENTICATED',
        subject: {
          dataScope: 'ALL',
          permissions,
          subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        },
      };
      const port = createHttpAdminAuthPort(environment, {
        fetchImpl: async () => jsonResponse(body),
        now: () => 1_000_000,
      });
      await expect(
        port.verifyTotp({
          challengeId: validChallengeId,
          code: '042731',
          correlationId: flowCorrelationId,
          idempotencyKey: totpIntentId,
        }),
      ).rejects.toThrow();
    },
  );

  it.each([
    [
      401,
      { attemptsRemaining: 3, kind: 'REJECTED', reason: 'INVALID_CODE' },
      { attemptsRemaining: 3, kind: 'REJECTED' },
    ],
    [
      423,
      { attemptsRemaining: 0, kind: 'REJECTED', lockedUntil: 1_060_000, reason: 'LOCKED' },
      { attemptsRemaining: 0, kind: 'REJECTED', lockedUntil: 1_060_000 },
    ],
  ])(
    'accepts only a strict authoritative TOTP rejection schema (%s)',
    async (status, body, expected) => {
      const port = createHttpAdminAuthPort(environment, {
        fetchImpl: async () => jsonResponse(body, status),
        now: () => 1_000_000,
      });
      await expect(
        port.verifyTotp({
          challengeId: validChallengeId,
          code: '042731',
          correlationId: flowCorrelationId,
          idempotencyKey: totpIntentId,
        }),
      ).resolves.toEqual(expected);
    },
  );

  it.each([
    [401, { attemptsRemaining: 3, kind: 'REJECTED', reason: 'INVALID_CODE', code: 'tainted' }],
    [
      423,
      {
        attemptsRemaining: 0,
        kind: 'REJECTED',
        lockedUntil: 1_060_000,
        reason: 'LOCKED',
        secret: 'tainted',
      },
    ],
  ])('rejects an extra field in a non-2xx TOTP authority response (%s)', async (status, body) => {
    const port = createHttpAdminAuthPort(environment, {
      fetchImpl: async () => jsonResponse(body, status),
      now: () => 1_000_000,
    });
    await expect(
      port.verifyTotp({
        challengeId: validChallengeId,
        code: '042731',
        correlationId: flowCorrelationId,
        idempotencyKey: totpIntentId,
      }),
    ).rejects.toThrow();
  });

  it.each([
    ['500', () => jsonResponse({}, 500), 'UPSTREAM_FAILURE'],
    ['429', () => jsonResponse({}, 429), 'UPSTREAM_FAILURE'],
    [
      'malformed 2xx',
      () => jsonResponse({ kind: 'REJECTED', attemptsRemaining: '3' }),
      'MALFORMED_RESPONSE',
    ],
    ['invalid JSON', () => new Response('{', { status: 200 }), 'MALFORMED_RESPONSE'],
    ['network', () => Promise.reject(new Error('lost')), 'NETWORK_FAILURE'],
  ])(
    'keeps %s TOTP outcomes indeterminate with a stable caller key',
    async (_label, response, reason) => {
      const headers: Headers[] = [];
      const capture = telemetryCapture();
      const port = createHttpAdminAuthPort(environment, {
        fetchImpl: async (_input, init) => {
          headers.push(new Headers(init?.headers));
          return response();
        },
        now: () => 1_000_000,
        telemetry: capture.telemetry,
      });
      const input = {
        challengeId: validChallengeId,
        code: '042731',
        correlationId: flowCorrelationId,
        idempotencyKey: totpIntentId,
      };
      await expect(port.verifyTotp(input)).rejects.toThrow();
      await expect(port.verifyTotp(input)).rejects.toThrow();
      expect(headers.map((value) => value.get('Idempotency-Key'))).toEqual([
        totpIntentId,
        totpIntentId,
      ]);
      expect(capture.events).toEqual([
        expect.objectContaining({
          correlationId: flowCorrelationId,
          operation: 'iam.totp.verify',
          reason,
          traceId: expect.stringMatching(traceIdPattern),
        }),
        expect.objectContaining({
          correlationId: flowCorrelationId,
          operation: 'iam.totp.verify',
          reason,
          traceId: expect.stringMatching(traceIdPattern),
        }),
      ]);
      expect(capture.events).toEqual(
        headers.map((value) =>
          expect.objectContaining({
            correlationId: value.get('X-Correlation-Id'),
            traceId: value.get('X-Trace-Id'),
          }),
        ),
      );
    },
  );

  it('never includes credentials, codes, or challenge ids in failure telemetry', async () => {
    const capture = telemetryCapture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    const port = createHttpAdminAuthPort(environment, {
      telemetry: capture.telemetry,
    });

    await expect(
      port.verifyTotp({
        challengeId: validChallengeId,
        code: '123456',
      }),
    ).rejects.toThrow();
    expect(capture.events).toContainEqual(
      expect.objectContaining({
        correlationId: expect.stringMatching(uuidV7Pattern),
        operation: 'iam.totp.verify',
        reason: 'NETWORK_FAILURE',
        traceId: expect.stringMatching(traceIdPattern),
      }),
    );
    expect(JSON.stringify(capture.events)).not.toMatch(/123456/);
  });

  it('does not classify strict business rejections as upstream failures', async () => {
    const capture = telemetryCapture();
    const password = createHttpAdminAuthPort(environment, {
      fetchImpl: async () => jsonResponse({ kind: 'REJECTED', reason: 'INVALID_CREDENTIALS' }, 401),
      now: () => 1_000_000,
      telemetry: capture.telemetry,
    });
    const invalidCode = createHttpAdminAuthPort(environment, {
      fetchImpl: async () =>
        jsonResponse({ attemptsRemaining: 2, kind: 'REJECTED', reason: 'INVALID_CODE' }, 401),
      now: () => 1_000_000,
      telemetry: capture.telemetry,
    });
    const locked = createHttpAdminAuthPort(environment, {
      fetchImpl: async () =>
        jsonResponse(
          { attemptsRemaining: 0, kind: 'REJECTED', lockedUntil: 1_060_000, reason: 'LOCKED' },
          423,
        ),
      now: () => 1_000_000,
      telemetry: capture.telemetry,
    });
    await password.beginPasswordChallenge({
      correlationId: flowCorrelationId,
      idempotencyKey: challengeIntentId,
      identifier: 'operator@example.invalid',
      password: 'secret',
    });
    await invalidCode.verifyTotp({
      challengeId: validChallengeId,
      code: '123456',
      correlationId: flowCorrelationId,
      idempotencyKey: totpIntentId,
    });
    await locked.verifyTotp({
      challengeId: validChallengeId,
      code: '123456',
      correlationId: flowCorrelationId,
      idempotencyKey: totpIntentId,
    });
    expect(capture.events).toEqual([]);
    expect(JSON.stringify(capture.events)).not.toMatch(/operator@example\.invalid|secret|123456/u);
  });

  it.each([
    ['500', () => jsonResponse({}, 500), 'UPSTREAM_FAILURE'],
    ['429', () => jsonResponse({}, 429), 'UPSTREAM_FAILURE'],
    ['network', () => Promise.reject(new Error('offline')), 'NETWORK_FAILURE'],
    ['malformed 2xx', () => jsonResponse({ challengeId: 'bad' }), 'MALFORMED_RESPONSE'],
    [
      'malformed 401',
      () => jsonResponse({ kind: 'REJECTED', reason: 'INVALID_CREDENTIALS', extra: true }, 401),
      'MALFORMED_RESPONSE',
    ],
  ])(
    'classifies %s password telemetry without sensitive values',
    async (_label, response, reason) => {
      const capture = telemetryCapture();
      const port = createHttpAdminAuthPort(environment, {
        fetchImpl: async () => response(),
        now: () => 1_000_000,
        telemetry: capture.telemetry,
      });
      await port.beginPasswordChallenge({
        correlationId: flowCorrelationId,
        idempotencyKey: challengeIntentId,
        identifier: 'operator@example.invalid',
        password: 'secret',
      });
      expect(capture.events).toContainEqual(
        expect.objectContaining({
          correlationId: flowCorrelationId,
          operation: 'iam.password.begin',
          reason,
          traceId: expect.stringMatching(traceIdPattern),
        }),
      );
      expect(JSON.stringify(capture.events)).not.toMatch(/operator@example\.invalid|secret/u);
    },
  );

  it.each([
    ['500', () => jsonResponse({}, 500), 'UPSTREAM_FAILURE'],
    ['429', () => jsonResponse({}, 429), 'UPSTREAM_FAILURE'],
    ['network', () => Promise.reject(new Error('offline')), 'NETWORK_FAILURE'],
    ['malformed 2xx', () => jsonResponse({ kind: 'CONSUMED', extra: true }), 'MALFORMED_RESPONSE'],
    [
      'malformed 401',
      () =>
        jsonResponse(
          { attemptsRemaining: 2, kind: 'REJECTED', reason: 'INVALID_CODE', extra: true },
          401,
        ),
      'MALFORMED_RESPONSE',
    ],
  ])('classifies %s TOTP telemetry without sensitive values', async (_label, response, reason) => {
    const capture = telemetryCapture();
    const port = createHttpAdminAuthPort(environment, {
      fetchImpl: async () => response(),
      now: () => 1_000_000,
      telemetry: capture.telemetry,
    });
    await expect(
      port.verifyTotp({
        challengeId: validChallengeId,
        code: '123456',
        correlationId: flowCorrelationId,
        idempotencyKey: totpIntentId,
      }),
    ).rejects.toMatchObject({
      name: 'ClassifiedAdminAuthFailure',
      reason,
    });
    expect(capture.events).toContainEqual(
      expect.objectContaining({
        correlationId: flowCorrelationId,
        operation: 'iam.totp.verify',
        reason,
        traceId: expect.stringMatching(traceIdPattern),
      }),
    );
    expect(JSON.stringify(capture.events)).not.toMatch(/123456/u);
  });
});
