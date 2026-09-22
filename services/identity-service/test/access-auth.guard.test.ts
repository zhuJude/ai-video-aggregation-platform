import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { JoseAccessTokenIssuer } from '../src/adapters/jose-access-token.issuer.js';
import {
  JoseAccessTokenVerifier,
  type AccessSessionStatusRepository,
} from '../src/adapters/jose-access-token.verifier.js';
import { JwtAccessGuard } from '../src/http/jwt-access.guard.js';
import { AuthenticatedUser } from '../src/http/authenticated-user.js';

const userId = '0198fabc-1234-7abc-8abc-111111111111';
const sessionId = '0198fabc-1234-7abc-8abc-222222222222';

function executionContext(request: { headers: Record<string, string>; user?: AuthenticatedUser }) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

async function fixture(active = true) {
  const { privateKey, publicKey } = await globalThis.crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ]);
  const statusRepository: AccessSessionStatusRepository = {
    isActive: (candidateUserId, candidateSessionId) =>
      Promise.resolve(active && candidateUserId === userId && candidateSessionId === sessionId),
  };
  const verifier = new JoseAccessTokenVerifier({
    keyProvider: {
      resolve: (keyId) => Promise.resolve(keyId === 'identity-signing-v1' ? publicKey : null),
    },
    statusRepository,
    now: () => new Date(Date.UTC(2026, 8, 1, 0, 0, 0)),
  });
  const issuer = new JoseAccessTokenIssuer({
    keyId: 'identity-signing-v1',
    signingKey: privateKey,
  });
  const token = await issuer.issue({
    userId,
    sessionId,
    issuedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, 0)),
  });
  return { privateKey, publicKey, token, verifier };
}

describe('JWT access authentication', () => {
  it('brands a principal only after signature, claims, and persistent status succeed', async () => {
    const { token, verifier } = await fixture();
    const guard = new JwtAccessGuard(verifier);
    const request: { headers: Record<string, string>; user?: AuthenticatedUser } = {
      headers: {
        authorization: `Bearer ${token}`,
        'x-user-id': '0198fabc-1234-7abc-8abc-aaaaaaaaaaaa',
        'x-session-id': '0198fabc-1234-7abc-8abc-bbbbbbbbbbbb',
      },
    };

    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);
    expect(AuthenticatedUser.assertTrusted(request.user as AuthenticatedUser)).toMatchObject({
      userId,
      sessionId,
    });
  });

  it('throws an actual 401 response for missing bearer credentials', async () => {
    const { verifier } = await fixture();
    const guard = new JwtAccessGuard(verifier);

    await expect(guard.canActivate(executionContext({ headers: {} }))).rejects.toMatchObject({
      code: 'INVALID_ACCESS_TOKEN',
      status: 401,
    });
  });

  it.each([
    ['revoked', false],
    ['consumed', false],
    ['user mismatch', false],
  ])('rejects a %s or otherwise inactive persisted session', async (_case, active) => {
    const { token, verifier } = await fixture(active);
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'ACCESS_SESSION_INACTIVE' });
  });

  it('rejects forged headers, expired tokens, wrong audience/issuer and non-v7 claims', async () => {
    const { privateKey, token, verifier } = await fixture();
    const guard = new JwtAccessGuard(verifier);
    await expect(
      guard.canActivate(
        executionContext({
          headers: {
            authorization: 'Bearer forged',
            'x-user-id': userId,
            'x-session-id': sessionId,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_TOKEN' });

    const variants = [
      { iss: 'identity-service', aud: 'user-web', sub: userId, sid: sessionId, exp: 1 },
      { iss: 'other', aud: 'user-web', sub: userId, sid: sessionId },
      { iss: 'identity-service', aud: 'other', sub: userId, sid: sessionId },
      { iss: 'identity-service', aud: 'user-web', sub: 'v4-user', sid: sessionId },
      { iss: 'identity-service', aud: 'user-web', sub: userId, sid: 'v4-session' },
    ];
    for (const variant of variants) {
      let builder = new SignJWT({ sid: variant.sid })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'identity-signing-v1' })
        .setIssuer(variant.iss)
        .setAudience(variant.aud)
        .setSubject(variant.sub)
        .setIssuedAt(Date.UTC(2026, 8, 1) / 1000);
      builder = builder.setExpirationTime(variant.exp ?? Date.UTC(2026, 8, 1, 0, 15) / 1000);
      await expect(verifier.verify(await builder.sign(privateKey))).rejects.toMatchObject({
        code: 'INVALID_ACCESS_TOKEN',
      });
    }

    await expect(verifier.verify(`${token}tampered`)).rejects.toMatchObject({
      code: 'INVALID_ACCESS_TOKEN',
    });
  });

  it('rejects missing or unsafe JWT time and session claims', async () => {
    const { privateKey, verifier } = await fixture();
    const nowSeconds = Date.UTC(2026, 8, 1) / 1000;
    const base = () =>
      new SignJWT({ sid: sessionId })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'identity-signing-v1' })
        .setIssuer('identity-service')
        .setAudience('user-web')
        .setSubject(userId);
    const unsafeTokens = await Promise.all([
      base().setIssuedAt(nowSeconds).sign(privateKey),
      base()
        .setExpirationTime(nowSeconds + 900)
        .sign(privateKey),
      base()
        .setIssuedAt(nowSeconds)
        .setExpirationTime(nowSeconds + 901)
        .sign(privateKey),
      base()
        .setIssuedAt(nowSeconds + 61)
        .setExpirationTime(nowSeconds + 900)
        .sign(privateKey),
      base()
        .setIssuedAt(nowSeconds + 500)
        .setExpirationTime(nowSeconds + 400)
        .sign(privateKey),
      new SignJWT({})
        .setProtectedHeader({ alg: 'EdDSA', kid: 'identity-signing-v1' })
        .setIssuer('identity-service')
        .setAudience('user-web')
        .setSubject(userId)
        .setIssuedAt(nowSeconds)
        .setExpirationTime(nowSeconds + 900)
        .sign(privateKey),
    ]);

    for (const token of unsafeTokens) {
      await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'INVALID_ACCESS_TOKEN' });
    }
  });

  it('rejects plain objects even if they copy valid claims', () => {
    expect(() =>
      AuthenticatedUser.assertTrusted({ userId, sessionId } as AuthenticatedUser),
    ).toThrow('UNTRUSTED_AUTHENTICATED_USER');
  });

  it('does not misclassify key-provider or session-store outages as invalid credentials', async () => {
    const { publicKey, token } = await fixture();
    const keyFailure = Object.assign(new Error('kms endpoint ECONNRESET secret-detail'), {
      code: 'ECONNRESET',
    });
    const verifierWithKeyOutage = new JoseAccessTokenVerifier({
      keyProvider: { resolve: () => Promise.reject(keyFailure) },
      statusRepository: { isActive: () => Promise.resolve(true) },
      now: () => new Date(Date.UTC(2026, 8, 1, 0, 0, 0)),
    });
    await expect(verifierWithKeyOutage.verify(token)).rejects.toBe(keyFailure);

    const databaseFailure = new Error('postgres password must not leak');
    const verifierWithDatabaseOutage = new JoseAccessTokenVerifier({
      keyProvider: { resolve: () => Promise.resolve(publicKey) },
      statusRepository: { isActive: () => Promise.reject(databaseFailure) },
      now: () => new Date(Date.UTC(2026, 8, 1, 0, 0, 0)),
    });
    await expect(verifierWithDatabaseOutage.verify(token)).rejects.toBe(databaseFailure);
  });

  it('maps only explicit authentication failures to 401 in the guard', async () => {
    const outage = new Error('verification dependency detail');
    const unknownVerifier = {
      verify: vi.fn().mockRejectedValue(outage),
    } as unknown as JoseAccessTokenVerifier;
    const guard = new JwtAccessGuard(unknownVerifier);
    await expect(
      guard.canActivate(
        executionContext({ headers: { authorization: 'Bearer valid.token.value' } }),
      ),
    ).rejects.toBe(outage);

    for (const code of ['INVALID_ACCESS_TOKEN', 'ACCESS_SESSION_INACTIVE'] as const) {
      const knownVerifier = {
        verify: vi.fn().mockRejectedValue(Object.assign(new Error(code), { code })),
      } as unknown as JoseAccessTokenVerifier;
      await expect(
        new JwtAccessGuard(knownVerifier).canActivate(
          executionContext({ headers: { authorization: 'Bearer valid.token.value' } }),
        ),
      ).rejects.toMatchObject({ code, status: 401 });
    }
  });
});
