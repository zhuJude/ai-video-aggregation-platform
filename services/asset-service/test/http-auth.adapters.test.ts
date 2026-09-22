/* eslint-disable @typescript-eslint/require-await -- focused authentication seams deliberately resolve synchronously. */
import { describe, expect, it, vi } from 'vitest';
import {
  JwksUserAuthenticator,
  KmsProviderCallbackAuthenticator,
  PrismaProviderNonceStore,
  PrismaProviderTaskAuthorization,
  ProviderNonceCleanupJob,
} from '../src/http/http-auth.adapters.js';

const ownerId = '018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7a';
const authorizationId = '018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7e';

describe('production HTTP authentication adapters', () => {
  it('rejects missing or forged user bearer tokens and returns only a verified subject', async () => {
    const verify = vi.fn(async (token: string) =>
      token === 'valid' ? { subject: ownerId } : null,
    );
    const authenticator = new JwksUserAuthenticator({ verifyBearerToken: verify });
    await expect(authenticator.authenticate({})).resolves.toBeNull();
    await expect(
      authenticator.authenticate({ authorization: 'Bearer forged' }),
    ).resolves.toBeNull();
    await expect(authenticator.authenticate({ authorization: 'Bearer valid' })).resolves.toEqual({
      userId: ownerId,
    });
  });

  it('requires KMS key references and never accepts raw callback secrets', () => {
    expect(
      () =>
        new KmsProviderCallbackAuthenticator({
          providers: { 'provider-a': { kmsKeyReference: 'raw-secret-value' } },
          macVerifier: { verifyMac: vi.fn() },
          nonceStore: { claim: vi.fn() },
        }),
    ).toThrow(/KMS reference/i);
  });

  it('rejects forged and expired provider callbacks before task authorization', async () => {
    const verifyMac = vi.fn(async ({ mac }: { mac: string }) => mac === 'valid');
    const nonceStore = { claim: vi.fn(async () => true) };
    const authenticator = new KmsProviderCallbackAuthenticator({
      providers: { 'provider-a': { kmsKeyReference: 'kms://asset/provider-a-callback' } },
      macVerifier: { verifyMac },
      nonceStore,
      now: () => new Date('2026-08-31T00:05:00.000Z'),
    });
    const body = Buffer.from('{"providerTaskId":"task-42"}');
    await expect(
      authenticator.authenticate({
        headers: signedHeaders('forged', '2026-08-31T00:05:00.000Z', 'nonce-a'),
        rawBody: body,
      }),
    ).resolves.toBeNull();
    await expect(
      authenticator.authenticate({
        headers: signedHeaders('valid', '2026-08-30T23:00:00.000Z', 'nonce-b'),
        rawBody: body,
      }),
    ).resolves.toBeNull();
    expect(nonceStore.claim).not.toHaveBeenCalled();
  });

  it('verifies the exact raw body through KMS and rejects nonce replay', async () => {
    const verifyMac = vi.fn(async () => true);
    const claimed = new Set<string>();
    const nonceStore = {
      claim: vi.fn(async ({ nonce }: { nonce: string }) => {
        if (claimed.has(nonce)) return false;
        claimed.add(nonce);
        return true;
      }),
    };
    const authenticator = new KmsProviderCallbackAuthenticator({
      providers: { 'provider-a': { kmsKeyReference: 'kms://asset/provider-a-callback' } },
      macVerifier: { verifyMac },
      nonceStore,
      now: () => new Date('2026-08-31T00:05:00.000Z'),
    });
    const rawBody = Buffer.from(
      '{"providerTaskId":"task-42","sourceUrl":"https://cdn.provider.cn/a"}',
    );
    const request = {
      headers: signedHeaders('valid', '2026-08-31T00:05:00.000Z', 'nonce-aaa'),
      rawBody,
    };
    await expect(authenticator.authenticate(request)).resolves.toEqual({
      providerId: 'provider-a',
    });
    await expect(authenticator.authenticate(request)).resolves.toBeNull();
    expect(verifyMac).toHaveBeenCalledWith(
      expect.objectContaining({
        kmsKeyReference: 'kms://asset/provider-a-callback',
        message: expect.any(Uint8Array) as Uint8Array,
        mac: 'valid',
      }),
    );
  });

  it('loads trusted task metadata by verified provider and task id', async () => {
    const authorization = new PrismaProviderTaskAuthorization({
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          providerResultAuthorization: {
            findFirst: async () => ({
              id: authorizationId,
              ownerId,
              providerTaskId: 'task-42',
              allowedHosts: ['cdn.provider.cn'],
              expectedMimeType: 'video/mp4',
              expectedSizeBytes: 200n,
              expectedChecksum: null,
              originalFileName: 'final.mp4',
            }),
          },
        }),
    } as never);
    await expect(authorization.authorize('provider-a', 'task-42')).resolves.toEqual({
      authorizationId,
      ownerId,
      providerTaskId: 'task-42',
      allowedHosts: ['cdn.provider.cn'],
      expectedMimeType: 'video/mp4',
      expectedSizeBytes: 200n,
      originalFileName: 'final.mp4',
    });
  });

  it('atomically persists provider nonces and rejects replay', async () => {
    let exists = false;
    const store = new PrismaProviderNonceStore({
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          providerCallbackNonce: {
            createMany: async ({ skipDuplicates }: { skipDuplicates: boolean }) => {
              expect(skipDuplicates).toBe(true);
              if (exists) return { count: 0 };
              exists = true;
              return { count: 1 };
            },
          },
        }),
    } as never);
    const input = {
      providerId: 'provider-a',
      nonce: 'nonce-aaa',
      expiresAt: new Date('2026-08-31T00:10:00.000Z'),
    };
    await expect(store.claim(input)).resolves.toBe(true);
    await expect(store.claim(input)).resolves.toBe(false);
  });

  it('batch-deletes expired callback nonces through a schedulable production job', async () => {
    const store = new PrismaProviderNonceStore({
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          providerCallbackNonce: {
            findMany: async () => [{ providerId: 'provider-a', nonce: 'old-nonce' }],
            deleteMany: async () => ({ count: 1 }),
          },
        }),
    } as never);
    await expect(
      new ProviderNonceCleanupJob(store, () => new Date('2026-08-31T00:10:00.000Z')).run(),
    ).resolves.toBe(1);
  });
});

function signedHeaders(
  signature: string,
  timestamp: string,
  nonce: string,
): Record<string, string> {
  return {
    'x-provider-id': 'provider-a',
    'x-provider-signature': signature,
    'x-provider-timestamp': timestamp,
    'x-provider-nonce': nonce,
  };
}
