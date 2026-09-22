import { describe, expect, it } from 'vitest';
import { JwksAdminAuthenticator } from '../src/http/http-auth.adapters.js';

const ADMIN = '01990f24-2ba2-7000-8000-000000000002';

describe('admin authentication adapter', () => {
  it('accepts only an issuer/audience verified admin token with an allowed role', async () => {
    const verifier = {
      verify: () =>
        Promise.resolve({
          sub: ADMIN,
          tokenUse: 'admin',
          role: 'ADMIN',
          permissions: ['operations:write'],
          issuer: 'https://identity.internal',
          audience: 'operations-service',
        }),
    };
    const auth = new JwksAdminAuthenticator(verifier, {
      issuer: 'https://identity.internal',
      audience: 'operations-service',
    });
    await expect(
      auth.authenticate({ headers: { authorization: 'Bearer signed-token' } }),
    ).resolves.toEqual({ adminId: ADMIN, role: 'ADMIN', permissions: ['operations:write'] });
  });

  it('rejects user tokens, wrong audience and malformed authorization without trusting headers', async () => {
    const auth = new JwksAdminAuthenticator(
      {
        verify: () =>
          Promise.resolve({
            sub: ADMIN,
            tokenUse: 'user',
            role: 'OWNER',
            permissions: ['operations:write'],
            issuer: 'https://identity.internal',
            audience: 'another-service',
          }),
      },
      { issuer: 'https://identity.internal', audience: 'operations-service' },
    );
    await expect(
      auth.authenticate({ headers: { authorization: 'Bearer token', 'x-admin-id': ADMIN } }),
    ).resolves.toBeNull();
    await expect(
      auth.authenticate({ headers: { authorization: 'Basic token', 'x-admin-role': 'OWNER' } }),
    ).resolves.toBeNull();
  });

  it('maps ordinary invalid-token verifier errors to unauthenticated', async () => {
    const auth = new JwksAdminAuthenticator(
      {
        verify: () => Promise.reject(Object.assign(new Error('expired'), { code: 'JWT_INVALID' })),
      },
      {
        issuer: 'https://identity.internal',
        audience: 'operations-service',
      },
    );
    await expect(
      auth.authenticate({ headers: { authorization: 'Bearer expired-token' } }),
    ).resolves.toBeNull();
  });

  it('maps standard JOSE verification errors to unauthenticated', async () => {
    const auth = new JwksAdminAuthenticator(
      {
        verify: () =>
          Promise.reject(Object.assign(new Error('expired'), { code: 'ERR_JWT_EXPIRED' })),
      },
      {
        issuer: 'https://identity.internal',
        audience: 'operations-service',
      },
    );
    await expect(
      auth.authenticate({ headers: { authorization: 'Bearer expired-token' } }),
    ).resolves.toBeNull();
  });

  it('rejects a verified principal whose subject is not UUIDv7', async () => {
    const auth = new JwksAdminAuthenticator(
      {
        verify: () =>
          Promise.resolve({
            sub: '01990f24-2ba2-4000-8000-000000000002',
            tokenUse: 'admin',
            role: 'ADMIN',
            permissions: ['operations:write'],
            issuer: 'https://identity.internal',
            audience: 'operations-service',
          }),
      },
      { issuer: 'https://identity.internal', audience: 'operations-service' },
    );
    await expect(
      auth.authenticate({ headers: { authorization: 'Bearer signed-token' } }),
    ).resolves.toBeNull();
  });
});
