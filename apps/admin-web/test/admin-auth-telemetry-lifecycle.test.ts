/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await -- Vitest asymmetric matchers are typed as any; focused fakes model the external IAM boundary. */

import { describe, expect, it } from 'vitest';

import {
  type AdminAuthPort,
  type ServerCookiePort,
  createLoginActionHandlers,
} from '../lib/admin-auth-actions';
import { createHttpAdminAuthPort } from '../lib/http-admin-auth-port';
import { ADMIN_MFA_CHALLENGE_COOKIE, signAdminMfaChallenge } from '../lib/session-auth';

const signingKey = 'b21-admin-auth-signing-key-at-least-32-bytes';
const challengeId = 'A'.repeat(43);
const correlationId = '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f';
const idempotencyKey = '0198f7a4-c6db-7b39-8a4e-73af0c1d2e3f';
const environment = {
  apiUrl: 'https://iam.example.invalid',
  kmsIdentityReference: 'kms://service/admin-web',
};

function captureTelemetry() {
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

async function totpCookies(now: number): Promise<ServerCookiePort> {
  const token = await signAdminMfaChallenge(
    {
      audience: 'admin-mfa',
      challengeId,
      correlationId,
      expiresAt: now + 600_000,
      identifierBinding: 'A'.repeat(43),
      seed: 'A'.repeat(43),
      stage: 'TOTP',
      version: 1,
    },
    signingKey,
  );
  const values = new Map([[ADMIN_MFA_CHALLENGE_COOKIE, token]]);
  return {
    delete(name) {
      values.delete(name);
    },
    get(name) {
      return values.get(name);
    },
    set(name, value) {
      values.set(name, value);
    },
  };
}

function totpForm(): FormData {
  const form = new FormData();
  form.set('totp', '123456');
  return form;
}

describe('admin authentication telemetry lifecycle', () => {
  it('binds password and TOTP technical events to the exact outbound attempt context', async () => {
    const requests: Headers[] = [];
    const capture = captureTelemetry();
    const port = createHttpAdminAuthPort(environment, {
      fetchImpl: async (_input, init) => {
        requests.push(new Headers(init?.headers));
        return requests.length === 1
          ? Response.json({ challengeId: 'bad', expiresInSeconds: 600 })
          : Response.json({ kind: 'CONSUMED', extra: true });
      },
      now: () => 1_000_000,
      telemetry: capture.telemetry,
    });

    await port.beginPasswordChallenge({
      correlationId,
      idempotencyKey,
      identifier: 'operator@example.invalid',
      password: 'password-must-never-be-logged',
    });
    await expect(
      port.verifyTotp({
        challengeId,
        code: '123456',
        correlationId,
        idempotencyKey,
      }),
    ).rejects.toThrow();

    expect(capture.events).toHaveLength(2);
    for (const [index, event] of capture.events.entries()) {
      expect(event).toMatchObject({
        correlationId: requests[index]?.get('X-Correlation-Id'),
        reason: 'MALFORMED_RESPONSE',
        traceId: requests[index]?.get('X-Trace-Id'),
      });
      expect(event).toMatchObject({ correlationId });
      expect(event).toMatchObject({ traceId: expect.stringMatching(/^[0-9a-f]{32}$/u) });
    }
    expect(JSON.stringify(capture.events)).not.toMatch(
      /operator@example\.invalid|password-must-never-be-logged|123456|A{16}/u,
    );
  });

  it('uses a fresh trace for each retry while preserving flow correlation and command idempotency', async () => {
    const requests: Headers[] = [];
    const capture = captureTelemetry();
    const port = createHttpAdminAuthPort(environment, {
      fetchImpl: async (_input, init) => {
        requests.push(new Headers(init?.headers));
        throw new Error('offline');
      },
      telemetry: capture.telemetry,
    });
    const input = { challengeId, code: '123456', correlationId, idempotencyKey };

    await expect(port.verifyTotp(input)).rejects.toThrow();
    await expect(port.verifyTotp(input)).rejects.toThrow();

    expect(requests.map((headers) => headers.get('Idempotency-Key'))).toEqual([
      idempotencyKey,
      idempotencyKey,
    ]);
    expect(requests.map((headers) => headers.get('X-Correlation-Id'))).toEqual([
      correlationId,
      correlationId,
    ]);
    expect(new Set(requests.map((headers) => headers.get('X-Trace-Id'))).size).toBe(2);
    expect(capture.events).toEqual(
      requests.map((headers) => ({
        correlationId,
        operation: 'iam.totp.verify',
        reason: 'NETWORK_FAILURE',
        traceId: headers.get('X-Trace-Id'),
      })),
    );
  });

  it('consumes a trusted classified cause once across wrappers, then records a replay as unclassified', async () => {
    const adapterCapture = captureTelemetry();
    const adapter = createHttpAdminAuthPort(environment, {
      fetchImpl: async () => Response.json({}, { status: 500 }),
      telemetry: adapterCapture.telemetry,
    });
    let classified: unknown;
    try {
      await adapter.verifyTotp({ challengeId, code: '123456', correlationId, idempotencyKey });
    } catch (error) {
      classified = error;
    }
    const wrapped = new Error('outer', {
      cause: new Error('middle', { cause: classified }),
    });
    const authPort: AdminAuthPort = {
      async beginPasswordChallenge() {
        throw new Error('not used');
      },
      async verifyTotp() {
        throw wrapped;
      },
    };
    const actionCapture = captureTelemetry();
    const handlers = createLoginActionHandlers({
      authPort,
      challengeSigningKey: signingKey,
      cookies: await totpCookies(1_000_000),
      now: () => 1_000_000,
      sessionSigningKey: signingKey,
      telemetry: actionCapture.telemetry,
    });

    await handlers.submitTotp(totpForm());
    expect(actionCapture.events).toEqual([]);
    await handlers.submitTotp(totpForm());
    expect(actionCapture.events).toEqual([
      expect.objectContaining({
        correlationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        ),
        operation: 'login.totp',
        reason: 'UPSTREAM_FAILURE',
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/u),
      }),
    ]);
    expect(adapterCapture.events).toHaveLength(1);
  });

  it.each(['forged classification', 'cyclic cause', 'throwing cause getter'])(
    'records one action event for an untrusted %s',
    async (variant) => {
      const error = Object.assign(new Error('Admin authentication dependency failed'), {
        reason: 'TIMEOUT',
      });
      if (variant === 'cyclic cause') {
        Object.defineProperty(error, 'cause', { value: error });
      } else if (variant === 'throwing cause getter') {
        Object.defineProperty(error, 'cause', {
          get() {
            throw new Error('unsafe getter');
          },
        });
      } else {
        Object.defineProperty(error, 'cause', {
          value: { name: 'ClassifiedAdminAuthFailure', reason: 'TIMEOUT' },
        });
      }
      const capture = captureTelemetry();
      const handlers = createLoginActionHandlers({
        authPort: {
          async beginPasswordChallenge() {
            throw new Error('not used');
          },
          async verifyTotp() {
            throw error;
          },
        },
        challengeSigningKey: signingKey,
        cookies: await totpCookies(1_000_000),
        now: () => 1_000_000,
        sessionSigningKey: signingKey,
        telemetry: capture.telemetry,
      });

      await handlers.submitTotp(totpForm());

      expect(capture.events).toEqual([
        expect.objectContaining({
          operation: 'login.totp',
          reason: 'UPSTREAM_FAILURE',
          traceId: expect.stringMatching(/^[0-9a-f]{32}$/u),
        }),
      ]);
    },
  );

  it('bounds trusted-cause traversal and classifies an over-depth wrapper at the action layer', async () => {
    const adapter = createHttpAdminAuthPort(environment, {
      fetchImpl: async () => Response.json({}, { status: 500 }),
    });
    let failure: unknown;
    try {
      await adapter.verifyTotp({ challengeId, code: '123456', correlationId, idempotencyKey });
    } catch (error) {
      failure = error;
    }
    for (let depth = 0; depth < 8; depth += 1) {
      failure = new Error(`wrapper-${String(depth)}`, { cause: failure });
    }
    const capture = captureTelemetry();
    const handlers = createLoginActionHandlers({
      authPort: {
        async beginPasswordChallenge() {
          throw new Error('not used');
        },
        async verifyTotp() {
          throw failure;
        },
      },
      challengeSigningKey: signingKey,
      cookies: await totpCookies(1_000_000),
      now: () => 1_000_000,
      sessionSigningKey: signingKey,
      telemetry: capture.telemetry,
    });

    await handlers.submitTotp(totpForm());

    expect(capture.events).toEqual([
      expect.objectContaining({
        correlationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        ),
        operation: 'login.totp',
        reason: 'UPSTREAM_FAILURE',
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/u),
      }),
    ]);
  });
});
