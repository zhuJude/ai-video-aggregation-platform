import { generate } from 'otplib';
import { jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';

import { JoseAdminAccessTokenIssuer } from '../src/adapters/jose-admin-access-token.issuer.js';
import { KmsAdminAccessTokenIssuer } from '../src/adapters/kms-admin-access-token.issuer.js';
import { OtplibTotpProvider } from '../src/adapters/otplib-totp.provider.js';
import { adminRefreshCookie } from '../src/http/admin-refresh-cookie.js';

describe('administrator TOTP and token boundaries', () => {
  it('accepts a bounded TOTP window and returns the exact time-step for replay prevention', async () => {
    const provider = new OtplibTotpProvider();
    const secret = provider.generateSecret();
    const now = new Date(Date.UTC(2026, 8, 1, 8, 0, 0));
    const token = await generate({ secret, epoch: now.getTime() / 1_000 });

    const step = await provider.verify(secret, token, now, null);
    expect(step).toBe(Math.floor(now.getTime() / 1_000 / 30));
    await expect(provider.verify(secret, token, now, step)).resolves.toBeNull();
  });

  it('issues a 10-minute EdDSA admin JWT with isolated issuer and audience', async () => {
    const { privateKey, publicKey } = await globalThis.crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ]);
    const issuer = new JoseAdminAccessTokenIssuer({
      getCurrentSigningKey: () =>
        Promise.resolve({ keyId: 'kms-admin-signing-v3', signingKey: privateKey }),
    });
    const now = new Date(Date.UTC(2026, 8, 1, 8, 0, 0));
    const token = await issuer.issue({
      adminId: '0198fabc-1234-7abc-8abc-000000000001',
      sessionId: '0198fabc-1234-7abc-8abc-000000000002',
      issuedAt: now,
    });

    const verified = await jwtVerify(token, publicKey, {
      issuer: 'iam-service',
      audience: 'admin-web',
      currentDate: now,
    });
    expect(verified.protectedHeader).toMatchObject({ alg: 'EdDSA', kid: 'kms-admin-signing-v3' });
    expect(verified.payload).toMatchObject({
      sub: '0198fabc-1234-7abc-8abc-000000000001',
      sid: '0198fabc-1234-7abc-8abc-000000000002',
      iss: 'iam-service',
      aud: 'admin-web',
    });
    expect(Number(verified.payload.exp) - Number(verified.payload.iat)).toBe(600);
  });

  it('uses an isolated strict administrator refresh cookie', () => {
    const cookie = adminRefreshCookie('A'.repeat(43));
    expect(cookie).toContain('admin_refresh=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/v1/admin/auth/refresh');
    expect(cookie).not.toContain('SameSite=Lax');
    expect(() => adminRefreshCookie('plaintext')).toThrow('INVALID_REFRESH_TOKEN');
  });

  it('signs production JWTs through a versioned KMS EdDSA port using workload identity only', async () => {
    const { privateKey, publicKey } = await globalThis.crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ]);
    const seen: unknown[] = [];
    const issuer = new KmsAdminAccessTokenIssuer(
      {
        sign: async (input) => {
          seen.push(input);
          const signingBytes = new Uint8Array(input.data.byteLength);
          signingBytes.set(input.data);
          return new Uint8Array(
            await globalThis.crypto.subtle.sign('Ed25519', privateKey, signingBytes),
          );
        },
        verify: async (input) =>
          globalThis.crypto.subtle.verify(
            'Ed25519',
            publicKey,
            new Uint8Array(input.signature),
            new Uint8Array(input.data),
          ),
      },
      {
        keyReference: 'acs:kms:cn-hangzhou:123:key/admin-signing:version/v3',
        identity: { mode: 'ecs_ram_role', roleName: 'iam-service' },
      },
    );
    const now = new Date(Date.UTC(2026, 8, 1, 8, 0, 0));
    const token = await issuer.issue({
      adminId: '0198fabc-1234-7abc-8abc-000000000001',
      sessionId: '0198fabc-1234-7abc-8abc-000000000002',
      issuedAt: now,
    });
    await expect(
      jwtVerify(token, publicKey, {
        issuer: 'iam-service',
        audience: 'admin-web',
        currentDate: now,
      }),
    ).resolves.toMatchObject({ payload: { sub: '0198fabc-1234-7abc-8abc-000000000001' } });
    expect(seen).toEqual([
      expect.objectContaining({
        algorithm: 'EdDSA',
        keyReference: 'acs:kms:cn-hangzhou:123:key/admin-signing:version/v3',
        identity: { mode: 'ecs_ram_role', roleName: 'iam-service' },
      }),
    ]);
  });

  it('rejects incomplete or malformed KMS signing workload identities', () => {
    const signer = {
      sign: () => Promise.resolve(new Uint8Array(64)),
      verify: () => Promise.resolve(true),
    };
    const keyReference = 'acs:kms:cn-hangzhou:123:key/admin-signing:version/v3';
    expect(
      () =>
        new KmsAdminAccessTokenIssuer(signer, {
          keyReference: 'not-an-aliyun-key:version/v3',
          identity: { mode: 'ecs_ram_role', roleName: 'iam-service' },
        }),
    ).toThrow('UNVERSIONED_KMS_SIGNING_KEY_REFERENCE');
    expect(
      () =>
        new KmsAdminAccessTokenIssuer(signer, {
          keyReference,
          identity: { mode: 'ecs_ram_role', roleName: ' ' },
        }),
    ).toThrow('INVALID_KMS_IDENTITY');
    expect(
      () =>
        new KmsAdminAccessTokenIssuer(signer, {
          keyReference,
          identity: {
            mode: 'oidc_role_arn',
            roleArn: 'not-an-arn',
            oidcProviderArn: 'acs:ram::123:oidc-provider/ack',
            clientId: 'iam-service',
          },
        }),
    ).toThrow('INVALID_KMS_IDENTITY');
    expect(
      () =>
        new KmsAdminAccessTokenIssuer(signer, {
          keyReference,
          identity: {
            mode: 'oidc_role_arn',
            roleArn: 'acs:ram::123:role/iam-service',
            oidcProviderArn: 'acs:ram::123:oidc-provider/ack',
            clientId: 'contains whitespace',
          },
        }),
    ).toThrow('INVALID_KMS_IDENTITY');
  });

  it('rejects unverified KMS signatures and snapshots mutable configuration', async () => {
    const identity: { mode: 'ecs_ram_role'; roleName: string } = {
      mode: 'ecs_ram_role',
      roleName: 'iam-service',
    };
    const options = { keyReference: 'acs:kms:cn-test:123:key/admin-signing:version/v1', identity };
    const seen: unknown[] = [];
    const issuer = new KmsAdminAccessTokenIssuer(
      {
        sign: () => Promise.resolve(new Uint8Array(64)),
        verify: (input) => {
          seen.push(input);
          return Promise.resolve(false);
        },
      },
      options,
    );
    identity.roleName = 'attacker';
    options.keyReference = 'acs:kms:cn-test:123:key/admin-signing:version/evil';
    await expect(
      issuer.issue({
        adminId: '0198fabc-1234-7abc-8abc-000000000001',
        sessionId: '0198fabc-1234-7abc-8abc-000000000002',
        issuedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_KMS_SIGNATURE' });
    expect(seen).toEqual([
      expect.objectContaining({
        keyReference: 'acs:kms:cn-test:123:key/admin-signing:version/v1',
        identity: { mode: 'ecs_ram_role', roleName: 'iam-service' },
        signature: new Uint8Array(64),
      }),
    ]);
  });
});
