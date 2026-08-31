/* eslint-disable @typescript-eslint/require-await -- stateful fake models the external IAM contract. */

import { describe, expect, it } from 'vitest';

import {
  type AdminAuthPort,
  type ServerCookiePort,
  createLoginActionHandlers,
} from '../lib/admin-auth-actions';
import {
  ADMIN_MFA_CHALLENGE_TTL_MS,
  ADMIN_MFA_CHALLENGE_COOKIE,
  signAdminMfaChallenge,
} from '../lib/session-auth';

const validKey = 'conformance-signing-key-at-least-32-bytes';

function cookiePort(): ServerCookiePort {
  return {
    get() {
      return undefined;
    },
    set() {},
    delete() {},
  };
}

describe('AdminAuthPort contract', () => {
  it('requires successful challenges to become consumed after one verification', async () => {
    const consumed = new Set<string>();
    const port: AdminAuthPort = {
      async beginPasswordChallenge() {
        return {
          challengeId: 'A'.repeat(43),
          expiresAt: Date.now() + 600_000,
        };
      },
      async verifyTotp({ challengeId }) {
        if (consumed.has(challengeId)) {
          return { kind: 'CONSUMED' };
        }
        consumed.add(challengeId);
        return {
          kind: 'AUTHENTICATED',
          subject: {
            subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
            permissions: ['overview:read'],
            dataScope: 'OWN',
          },
          expiresAt: Date.now() + 60_000,
        };
      },
    };
    const challenge = await port.beginPasswordChallenge({
      identifier: 'operator',
      password: 'password',
    });
    expect(challenge.challengeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge.expiresAt).toBeGreaterThan(Date.now());
    expect(challenge.expiresAt - Date.now()).toBeLessThanOrEqual(
      ADMIN_MFA_CHALLENGE_TTL_MS,
    );

    await expect(
      port.verifyTotp({ challengeId: challenge.challengeId, code: '042731' }),
    ).resolves.toMatchObject({ kind: 'AUTHENTICATED' });
    await expect(
      port.verifyTotp({ challengeId: challenge.challengeId, code: '042731' }),
    ).resolves.toEqual({ kind: 'CONSUMED' });
  });

  it('validates signing-key configuration at handler construction with safe telemetry', () => {
    const events: unknown[] = [];
    const authPort: AdminAuthPort = {
      async beginPasswordChallenge() {
        return {
          challengeId: '11111111-1111-4111-8111-111111111111',
          expiresAt: Date.now() + 60_000,
        };
      },
      async verifyTotp() {
        return { kind: 'REJECTED', attemptsRemaining: 4 };
      },
    };

    expect(() =>
      createLoginActionHandlers({
        authPort,
        cookies: cookiePort(),
        challengeSigningKey: 'short',
        sessionSigningKey: validKey,
        telemetry: {
          record(event: unknown) {
            events.push(event);
          },
        },
      }),
    ).toThrow();
    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual(['correlationId', 'operation', 'reason', 'traceId']);
    expect(event.operation).toBe('login.config');
    expect(event.reason).toBe('INVALID_CONFIG');
    expect(event.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    expect(event.traceId).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('deletes the local challenge cookie when IAM reports it consumed', async () => {
    const values = new Map<string, string>();
    values.set(
      ADMIN_MFA_CHALLENGE_COOKIE,
      await signAdminMfaChallenge(
        { audience: 'admin-mfa', challengeId: 'A'.repeat(43), correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f', expiresAt: Date.now() + 600_000, identifierBinding: 'A'.repeat(43), seed: 'A'.repeat(43), stage: 'TOTP', version: 1 },
        validKey,
      ),
    );
    const cookies: ServerCookiePort = {
      get(name) {
        return values.get(name);
      },
      set(name, value) {
        values.set(name, value);
      },
      delete(name) {
        values.delete(name);
      },
    };
    const authPort: AdminAuthPort = {
      async beginPasswordChallenge() {
        throw new Error('not used');
      },
      async verifyTotp() {
        return { kind: 'CONSUMED' };
      },
    };
    const actions = createLoginActionHandlers({
      authPort,
      cookies,
      challengeSigningKey: validKey,
      sessionSigningKey: validKey,
    });
    const formData = new FormData();
    formData.set('totp', '042731');

    await expect(actions.submitTotp(formData)).resolves.toMatchObject({
      status: 'INVALID_TOTP',
    });
    expect(values.has(ADMIN_MFA_CHALLENGE_COOKIE)).toBe(false);
  });
});
