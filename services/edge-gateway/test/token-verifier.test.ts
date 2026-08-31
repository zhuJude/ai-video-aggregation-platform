import { beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair, jwtVerify, SignJWT, type CryptoKey } from 'jose';
import { TokenVerifier } from '../src/auth/token-verifier.js';

const userId = '0198f85b-55cb-7da3-a3c3-6d77ed506a8e';
const sessionId = '0198f85b-6745-7c8f-9302-13e629ef57e0';

describe('TokenVerifier', () => {
  let browserPrivateKey: CryptoKey;
  let browserPublicKey: CryptoKey;
  let internalPrivateKey: CryptoKey;
  let internalPublicKey: CryptoKey;
  let verifier: TokenVerifier;

  beforeAll(async () => {
    ({ privateKey: browserPrivateKey, publicKey: browserPublicKey } = await generateKeyPair(
      'EdDSA',
    ));
    ({ privateKey: internalPrivateKey, publicKey: internalPublicKey } = await generateKeyPair(
      'EdDSA',
    ));
    verifier = new TokenVerifier({
      user: {
        issuer: 'identity-service',
        audience: 'user-web',
        algorithms: ['EdDSA'],
        keys: new Map([['browser-key', browserPublicKey]]),
      },
      admin: {
        issuer: 'iam-service',
        audience: 'admin-web',
        algorithms: ['EdDSA'],
        keys: new Map([['browser-key', browserPublicKey]]),
      },
      internalSigner: {
        algorithm: 'EdDSA',
        audience: 'internal-services',
        issuer: 'edge-gateway',
        kid: 'gateway-key',
        privateKey: internalPrivateKey,
      },
    });
  });

  async function sign(claims: Record<string, unknown>): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid: 'browser-key' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(browserPrivateKey);
  }

  it('does not accept a user token on an admin route', async () => {
    const token = await sign({
      sub: userId,
      sid: sessionId,
      aud: 'user-web',
      iss: 'identity-service',
    });

    await expect(verifier.verifyAdmin(token)).rejects.toMatchObject({
      code: 'INVALID_ADMIN_TOKEN',
    });
  });

  it('rejects an administrator token with the wrong issuer', async () => {
    const token = await sign({
      sub: userId,
      sid: sessionId,
      aud: 'admin-web',
      iss: 'identity-service',
      permissions: ['wallet:adjust'],
      dataScope: 'ALL',
    });

    await expect(verifier.verifyAdmin(token)).rejects.toMatchObject({
      code: 'INVALID_ADMIN_TOKEN',
    });
  });

  it('requires administrator permissions and a valid data scope', async () => {
    const token = await sign({
      sub: userId,
      sid: sessionId,
      aud: 'admin-web',
      iss: 'iam-service',
      permissions: ['wallet:adjust'],
      dataScope: 'ALL',
    });

    await expect(verifier.verifyAdmin(token)).resolves.toMatchObject({
      kind: 'admin',
      subjectId: userId,
      permissions: ['wallet:adjust'],
      dataScope: 'ALL',
    });
  });

  it('rejects tokens signed by an unknown key id', async () => {
    const token = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'unknown-key' })
      .setSubject(userId)
      .setIssuer('identity-service')
      .setAudience('user-web')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(browserPrivateKey);

    await expect(verifier.verifyUser(token)).rejects.toMatchObject({
      code: 'INVALID_USER_TOKEN',
    });
  });

  it('replaces the browser token with a short-lived internal subject assertion', async () => {
    const token = await sign({
      sub: userId,
      sid: sessionId,
      aud: 'user-web',
      iss: 'identity-service',
    });
    const subject = await verifier.verifyUser(token);
    const assertion = await verifier.createInternalSubjectAssertion(subject, {
      correlationId: 'b'.repeat(32),
      traceId: 'a'.repeat(32),
    });
    const verified = await jwtVerify(assertion, internalPublicKey, {
      algorithms: ['EdDSA'],
      audience: 'internal-services',
      issuer: 'edge-gateway',
    });

    expect(assertion).not.toBe(token);
    expect(verified.payload).toMatchObject({
      sub: userId,
      sid: sessionId,
      subjectKind: 'user',
      traceId: 'a'.repeat(32),
      correlationId: 'b'.repeat(32),
    });
    expect(Number(verified.payload.exp) - Number(verified.payload.iat)).toBe(60);
  });
});
