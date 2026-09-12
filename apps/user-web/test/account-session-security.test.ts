import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  closeAccountAction,
  listSecuritySessionsAction,
  requestAccountDeletionCodeAction,
} from '../app/account-actions';
import { accountGateway } from '../lib/account/gateway';
import { resolveExistingMockSubjectForVerifiedPhone } from '../lib/auth/mock-subject-store';
import {
  establishAuthenticatedServerSession,
  readAuthenticatedServerSession,
  refreshAuthenticatedServerSession,
  requireMutableAuthenticatedServerSessionIdentity,
} from '../lib/auth/server-session';
import { createUuidV7 } from '../lib/tasks/identifiers';
import type { SecuritySessionView } from '../lib/account/types';
import { createMockStoreTestScope } from './mock-store-scope';

const refreshToken = 'R'.repeat(43);
const mockStoreScope = createMockStoreTestScope();

function accessToken(sessionId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'ES256', typ: 'JWT' })}.${encode({ aud: 'user-web', exp: Math.floor(Date.now() / 1_000) + 900, iss: 'identity-service', sid: sessionId, sub: 'untrusted-jwt-subject' })}.gateway-signature`;
}

function signedAccessToken(
  ownerId: string,
  sessionId: string,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1_000);
  const protectedHeader = encode({ alg: 'EdDSA', kid: 'identity-primary', typ: 'JWT' });
  const payload = encode({
    aud: 'user-web',
    exp: now + 900,
    iat: now,
    iss: 'identity-service',
    nbf: now - 1,
    sid: sessionId,
    sub: ownerId,
  });
  const signingInput = `${protectedHeader}.${payload}`;
  const signature = sign(null, Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

beforeEach(() => {
  mockStoreScope.install();
  sessionCookies.clear();
  process.env.USER_WEB_SESSION_ENCRYPTION_KEY = randomBytes(32).toString('base64url');
  process.env.USER_WEB_MOCK_IDENTITY_KEY = randomBytes(32).toString('base64url');
  process.env.USER_WEB_SUPPORT_MODE = 'mock';
  process.env.USER_WEB_COMMERCE_MODE = 'mock';
  process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY = randomBytes(32).toString('base64url');
});

afterEach(() => {
  sessionCookies.clear();
  vi.unstubAllGlobals();
  delete process.env.USER_WEB_SESSION_ENCRYPTION_KEY;
  delete process.env.USER_WEB_MOCK_IDENTITY_KEY;
  delete process.env.USER_WEB_SUPPORT_MODE;
  delete process.env.USER_WEB_COMMERCE_MODE;
  delete process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY;
  delete process.env.USER_WEB_COMMERCE_MOCK_TEST_NAMESPACE;
  delete process.env.USER_WEB_IDENTITY_VERIFY_KEYS_JSON;
  delete process.env.GATEWAY_URL;
});

afterAll(async () => {
  await mockStoreScope.cleanup();
});

describe('account session security', () => {
  it('establishes a live session from a verified WS10 EdDSA subject and accepts the bare session array', async () => {
    delete process.env.USER_WEB_SUPPORT_MODE;
    delete process.env.USER_WEB_MOCK_IDENTITY_KEY;
    process.env.GATEWAY_URL = 'https://gateway.example.test';
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.USER_WEB_IDENTITY_VERIFY_KEYS_JSON = JSON.stringify([
      {
        kid: 'identity-primary',
        spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      },
    ]);
    const ownerId = createUuidV7();
    const sessionId = createUuidV7();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json([
          {
            id: sessionId,
            deviceName: 'Chrome on Windows',
            createdAt: new Date(Date.now() - 60_000).toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ]),
      ),
    );

    await expect(
      establishAuthenticatedServerSession(
        signedAccessToken(ownerId, sessionId, privateKey),
        sessionId,
        refreshToken,
        '+8618811122222',
      ),
    ).resolves.toBeUndefined();
    await expect(readAuthenticatedServerSession()).resolves.toEqual({ ownerId });
  });

  it('fails closed when a live token subject is not signed by the configured WS10 key', async () => {
    delete process.env.USER_WEB_SUPPORT_MODE;
    delete process.env.USER_WEB_MOCK_IDENTITY_KEY;
    const configured = generateKeyPairSync('ed25519');
    const attacker = generateKeyPairSync('ed25519');
    process.env.USER_WEB_IDENTITY_VERIFY_KEYS_JSON = JSON.stringify([
      {
        kid: 'identity-primary',
        spki: configured.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      },
    ]);
    const sessionId = createUuidV7();

    await expect(
      establishAuthenticatedServerSession(
        signedAccessToken(createUuidV7(), sessionId, attacker.privateKey),
        sessionId,
        refreshToken,
        '+8618811122222',
      ),
    ).rejects.toThrow('INVALID_GATEWAY_ACCESS_TOKEN');
  });

  it('fails closed for a missing, duplicate, oversized, or non-Ed25519 live keyring', async () => {
    delete process.env.USER_WEB_SUPPORT_MODE;
    delete process.env.USER_WEB_MOCK_IDENTITY_KEY;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const sessionId = createUuidV7();
    const token = signedAccessToken(createUuidV7(), sessionId, privateKey);
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');

    delete process.env.USER_WEB_IDENTITY_VERIFY_KEYS_JSON;
    await expect(
      establishAuthenticatedServerSession(token, sessionId, refreshToken, '+8618811122222'),
    ).rejects.toThrow('IDENTITY_VERIFY_KEYS_UNAVAILABLE');

    process.env.USER_WEB_IDENTITY_VERIFY_KEYS_JSON = JSON.stringify([
      { kid: 'identity-primary', spki },
      { kid: 'identity-primary', spki },
    ]);
    await expect(
      establishAuthenticatedServerSession(token, sessionId, refreshToken, '+8618811122222'),
    ).rejects.toThrow('IDENTITY_VERIFY_KEYS_UNAVAILABLE');

    process.env.USER_WEB_IDENTITY_VERIFY_KEYS_JSON = JSON.stringify(
      Array.from({ length: 6 }, (_, index) => ({ kid: `key-${String(index)}`, spki })),
    );
    await expect(
      establishAuthenticatedServerSession(token, sessionId, refreshToken, '+8618811122222'),
    ).rejects.toThrow('IDENTITY_VERIFY_KEYS_UNAVAILABLE');

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    process.env.USER_WEB_IDENTITY_VERIFY_KEYS_JSON = JSON.stringify([
      {
        kid: 'identity-primary',
        spki: rsa.export({ format: 'der', type: 'spki' }).toString('base64url'),
      },
    ]);
    await expect(
      establishAuthenticatedServerSession(token, sessionId, refreshToken, '+8618811122222'),
    ).rejects.toThrow('IDENTITY_VERIFY_KEYS_UNAVAILABLE');
  });
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
    const firstCookie = sessionCookies.get('__Host-user-session') ?? '';
    const secondSessionId = createUuidV7();
    await establishAuthenticatedServerSession(
      accessToken(secondSessionId),
      secondSessionId,
      refreshToken,
      phone,
    );
    const secondCookie = sessionCookies.get('__Host-user-session') ?? '';
    await expect(requestAccountDeletionCodeAction(createUuidV7())).resolves.toMatchObject({
      ok: true,
    });

    await expect(closeAccountAction('123456', createUuidV7())).resolves.toEqual({
      ok: true,
      data: { closed: true },
    });
    for (const cookie of [firstCookie, secondCookie]) {
      sessionCookies.set('__Host-user-session', cookie);
      await expect(readAuthenticatedServerSession()).resolves.toBeUndefined();
    }
    await expect(resolveExistingMockSubjectForVerifiedPhone(phone)).resolves.toBeUndefined();
  });

  it('rejects an AEAD cookie immediately after another device revokes its durable session', async () => {
    const phone = '+8618812345678';
    const firstSessionId = createUuidV7();
    await establishAuthenticatedServerSession(
      accessToken(firstSessionId),
      firstSessionId,
      refreshToken,
      phone,
    );
    const firstCookie = sessionCookies.get('__Host-user-session');
    expect(firstCookie).toBeDefined();
    const firstIdentity = await readAuthenticatedServerSession();
    const secondSessionId = createUuidV7();
    await establishAuthenticatedServerSession(
      accessToken(secondSessionId),
      secondSessionId,
      refreshToken,
      phone,
    );
    const context = {
      ownerId: firstIdentity?.ownerId ?? '',
      currentSessionId: secondSessionId,
      verifiedPhone: phone,
    };
    const sessions = (await accountGateway.listSessions(context)) as readonly SecuritySessionView[];
    const first = sessions.find(
      (session) => !session.current && session.deviceName === '当前浏览器',
    );
    expect(first).toBeDefined();
    await accountGateway.revokeSession(first?.handle ?? '', {
      ...context,
      idempotencyKey: createUuidV7(),
    });

    sessionCookies.set('__Host-user-session', firstCookie ?? '');
    await expect(readAuthenticatedServerSession()).resolves.toBeUndefined();
  });

  it('invalidates every saved cookie after exit-all and does not auto-register it again', async () => {
    const phone = '+8618712345678';
    const sessionId = createUuidV7();
    await establishAuthenticatedServerSession(
      accessToken(sessionId),
      sessionId,
      refreshToken,
      phone,
    );
    const firstCookie = sessionCookies.get('__Host-user-session') ?? '';
    const identity = await readAuthenticatedServerSession();
    const secondSessionId = createUuidV7();
    await establishAuthenticatedServerSession(
      accessToken(secondSessionId),
      secondSessionId,
      refreshToken,
      phone,
    );
    const secondCookie = sessionCookies.get('__Host-user-session') ?? '';
    await accountGateway.exitAll({
      ownerId: identity?.ownerId ?? '',
      currentSessionId: secondSessionId,
      verifiedPhone: phone,
      idempotencyKey: createUuidV7(),
    });

    for (const cookie of [firstCookie, secondCookie]) {
      sessionCookies.set('__Host-user-session', cookie);
      await expect(readAuthenticatedServerSession()).resolves.toBeUndefined();
      await expect(readAuthenticatedServerSession()).resolves.toBeUndefined();
    }
  });

  it('fails closed when durable session state cannot be queried', async () => {
    const phone = '+8618612345678';
    const sessionId = createUuidV7();
    await establishAuthenticatedServerSession(
      accessToken(sessionId),
      sessionId,
      refreshToken,
      phone,
    );
    delete process.env.USER_WEB_SUPPORT_MODE;

    await expect(readAuthenticatedServerSession()).resolves.toBeUndefined();
  });

  it('does not call refresh after the durable session was revoked', async () => {
    const phone = '+8618512345678';
    const firstSessionId = createUuidV7();
    await establishAuthenticatedServerSession(
      accessToken(firstSessionId),
      firstSessionId,
      refreshToken,
      phone,
    );
    const firstCookie = sessionCookies.get('__Host-user-session');
    const identity = await readAuthenticatedServerSession();
    const secondSessionId = createUuidV7();
    await establishAuthenticatedServerSession(
      accessToken(secondSessionId),
      secondSessionId,
      refreshToken,
      phone,
    );
    const context = {
      ownerId: identity?.ownerId ?? '',
      currentSessionId: secondSessionId,
      verifiedPhone: phone,
    };
    const sessions = (await accountGateway.listSessions(context)) as readonly SecuritySessionView[];
    const first = sessions.find(
      (session) => !session.current && session.deviceName === '当前浏览器',
    );
    await accountGateway.revokeSession(first?.handle ?? '', {
      ...context,
      idempotencyKey: createUuidV7(),
    });
    sessionCookies.set('__Host-user-session', firstCookie ?? '');
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', upstream);

    await expect(refreshAuthenticatedServerSession()).resolves.toBe(false);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('cannot resurrect a session revoked while an upstream refresh is in flight', async () => {
    const phone = '+8618212345678';
    const sessionId = createUuidV7();
    await establishAuthenticatedServerSession(
      accessToken(sessionId),
      sessionId,
      refreshToken,
      phone,
    );
    const identity = await requireMutableAuthenticatedServerSessionIdentity();
    const rotatedSessionId = createUuidV7();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await accountGateway.exitAll({
          ownerId: identity.ownerId,
          currentSessionId: sessionId,
          verifiedPhone: phone,
          idempotencyKey: createUuidV7(),
        });
        return Response.json(
          { accessToken: accessToken(rotatedSessionId), sessionId: rotatedSessionId },
          {
            headers: {
              'set-cookie': `refresh_token=${'S'.repeat(43)}; Path=/auth/refresh; HttpOnly; Secure; SameSite=Lax`,
            },
          },
        );
      }),
    );

    await expect(refreshAuthenticatedServerSession()).resolves.toBe(false);
    await expect(readAuthenticatedServerSession()).resolves.toBeUndefined();
  });

  it('resolves the current phone by stable subject for a second device after rebind', async () => {
    const oldPhone = '+8618412345678';
    const newPhone = '+8618312345678';
    const firstSessionId = createUuidV7();
    await establishAuthenticatedServerSession(
      accessToken(firstSessionId),
      firstSessionId,
      refreshToken,
      oldPhone,
    );
    const firstCookie = sessionCookies.get('__Host-user-session');
    const firstIdentity = await requireMutableAuthenticatedServerSessionIdentity();
    const secondSessionId = createUuidV7();
    await establishAuthenticatedServerSession(
      accessToken(secondSessionId),
      secondSessionId,
      refreshToken,
      oldPhone,
    );
    const second = {
      ownerId: firstIdentity.ownerId,
      currentSessionId: secondSessionId,
      verifiedPhone: oldPhone,
    };
    await accountGateway.requestPhoneChangeCodes(
      { newPhoneE164: newPhone, deviceId: 'second-device' },
      { ...second, idempotencyKey: createUuidV7() },
    );
    const operationId = createUuidV7();
    await accountGateway.verifyPhoneChange(
      {
        currentPhoneCode: '123456',
        newPhoneE164: newPhone,
        newPhoneCode: '123456',
        operationId,
      },
      { ...second, idempotencyKey: operationId },
    );

    sessionCookies.set('__Host-user-session', firstCookie ?? '');
    await expect(requireMutableAuthenticatedServerSessionIdentity()).resolves.toMatchObject({
      ownerId: firstIdentity.ownerId,
      verifiedPhone: newPhone,
    });
    await expect(requestAccountDeletionCodeAction(createUuidV7())).resolves.toMatchObject({
      ok: true,
    });
    await expect(closeAccountAction('123456', createUuidV7())).resolves.toEqual({
      ok: true,
      data: { closed: true },
    });
    await expect(resolveExistingMockSubjectForVerifiedPhone(oldPhone)).resolves.toBeUndefined();
    await expect(resolveExistingMockSubjectForVerifiedPhone(newPhone)).resolves.toBeUndefined();
  });
});
