import { describe, expect, it } from 'vitest';
import { JwksUserAuthenticator } from '../src/http/http-auth.adapter.js';

describe('notification auth', () => {
  it('accepts only verified user tokens with exact issuer and audience', async () => {
    const verifier = {
      verify: () =>
        Promise.resolve({
          sub: '01990f24-2ba2-7000-8000-000000000001',
          tokenUse: 'user',
          issuer: 'https://issuer',
          audience: 'notification',
        }),
    };
    const auth = new JwksUserAuthenticator(verifier, {
      issuer: 'https://issuer',
      audience: 'notification',
    });
    expect(
      await auth.authenticate({ headers: { authorization: 'Bearer signed.jwt.token' } }),
    ).toEqual({ userId: '01990f24-2ba2-7000-8000-000000000001' });
    expect(
      await new JwksUserAuthenticator(verifier, {
        issuer: 'https://evil',
        audience: 'notification',
      }).authenticate({ headers: { authorization: 'Bearer signed.jwt.token' } }),
    ).toBeNull();
  });
});
