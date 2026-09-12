import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionCookies = vi.hoisted(() => new Map<string, string>());
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = sessionCookies.get(name);
        return value ? { value } : undefined;
      },
      set: (name: string, value: string) => {
        sessionCookies.set(name, value);
      },
      delete: (name: string) => sessionCookies.delete(name),
    }),
}));

import { closeAccountAction, listSecuritySessionsAction } from '../app/account-actions';
import { resolveExistingMockSubjectForVerifiedPhone } from '../lib/auth/mock-subject-store';
import {
  establishAuthenticatedServerSession,
  readAuthenticatedServerSession,
} from '../lib/auth/server-session';
import { createUuidV7 } from '../lib/tasks/identifiers';

const refreshToken = 'R'.repeat(43);

function accessToken(sessionId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'ES256', typ: 'JWT' })}.${encode({ aud: 'user-web', exp: Math.floor(Date.now() / 1_000) + 900, iss: 'identity-service', sid: sessionId, sub: 'untrusted-jwt-subject' })}.gateway-signature`;
}

beforeEach(() => {
  sessionCookies.clear();
  process.env.USER_WEB_SESSION_ENCRYPTION_KEY = randomBytes(32).toString('base64url');
  process.env.USER_WEB_MOCK_IDENTITY_KEY = randomBytes(32).toString('base64url');
  process.env.USER_WEB_SUPPORT_MODE = 'mock';
  process.env.USER_WEB_COMMERCE_MODE = 'mock';
  process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY = randomBytes(32).toString('base64url');
});

afterEach(() => {
  sessionCookies.clear();
  delete process.env.USER_WEB_SESSION_ENCRYPTION_KEY;
  delete process.env.USER_WEB_MOCK_IDENTITY_KEY;
  delete process.env.USER_WEB_SUPPORT_MODE;
  delete process.env.USER_WEB_COMMERCE_MODE;
  delete process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY;
});

describe('account session security', () => {
  it('fails closed for an unauthenticated security action', async () => {
    await expect(listSecuritySessionsAction()).resolves.toEqual({
      ok: false,
      outcome: 'DEFINITIVE_FAILURE',
    });
  });

  it('clears the current session and closes the phone mapping after account deletion', async () => {
    const suffix = String(Date.now()).slice(-8);
    const phone = `+86188${suffix}`;
    const sessionId = createUuidV7();
    await establishAuthenticatedServerSession(
      accessToken(sessionId),
      sessionId,
      refreshToken,
      phone,
    );
    const subject = await readAuthenticatedServerSession();
    expect(subject?.ownerId).toMatch(/^[0-9a-f-]{36}$/);

    await expect(closeAccountAction('123456', createUuidV7())).resolves.toEqual({
      ok: true,
      data: { closed: true },
    });
    await expect(readAuthenticatedServerSession()).resolves.toBeUndefined();
    await expect(resolveExistingMockSubjectForVerifiedPhone(phone)).resolves.toBeUndefined();
  });
});
