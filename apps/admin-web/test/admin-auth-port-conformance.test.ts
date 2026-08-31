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
            subjectId: 'admin-1',
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
    expect(events).toEqual([
      { operation: 'login.config', reason: 'INVALID_CONFIG' },
    ]);
  });

  it('deletes the local challenge cookie when IAM reports it consumed', async () => {
    const values = new Map<string, string>();
    values.set(
      ADMIN_MFA_CHALLENGE_COOKIE,
      await signAdminMfaChallenge(
        { challengeId: 'A'.repeat(43), expiresAt: Date.now() + 600_000 },
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
