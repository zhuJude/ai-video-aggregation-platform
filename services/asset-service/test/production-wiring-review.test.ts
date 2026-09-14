import { describe, expect, it, vi } from 'vitest';
import { AssetHttpModule } from '../src/http/asset-http.module.js';

const USER = '01990f24-2ba2-7000-8000-000000000001';
const ASSET = '01990f24-2ba2-7000-8000-000000000002';
const SESSION = '01990f24-2ba2-7000-8000-000000000003';

describe('asset production HTTP wiring', () => {
  it('mounts create, complete and download upload-session routes', async () => {
    const uploadSessions = {
      create: vi.fn().mockResolvedValue({ sessionId: SESSION, assetId: ASSET }),
      complete: vi.fn().mockResolvedValue({ assetId: ASSET, status: 'AVAILABLE' }),
      createDownload: vi.fn().mockResolvedValue('https://cdn.example/download'),
    };
    const http = makeHttp({ uploadSessions });

    await expect(
      http.handle({
        method: 'POST',
        path: '/v1/upload-sessions',
        headers: { authorization: 'Bearer user' },
        body: { kind: 'UPLOAD', fileName: 'proof.png', mimeType: 'image/png', sizeBytes: '8' },
      }),
    ).resolves.toMatchObject({ status: 201, body: { sessionId: SESSION } });
    await expect(
      http.handle({
        method: 'POST',
        path: `/v1/upload-sessions/${SESSION}/complete`,
        headers: { authorization: 'Bearer user' },
        body: { objectKey: `uploads/${USER}/${ASSET}`, mimeType: 'image/png', sizeBytes: '8' },
      }),
    ).resolves.toMatchObject({ status: 200, body: { status: 'AVAILABLE' } });
    await expect(
      http.handle({
        method: 'POST',
        path: `/v1/assets/${ASSET}/downloads`,
        headers: { authorization: 'Bearer user' },
        body: { expiresInSeconds: 60 },
      }),
    ).resolves.toEqual({ status: 200, body: { url: 'https://cdn.example/download' } });
  });

  it('protects the internal asset and support-upload lifecycle with service identity', async () => {
    const internalAssets = {
      findAvailableAsset: vi.fn().mockResolvedValue({ id: ASSET, ownerId: USER }),
      reserve: vi.fn().mockResolvedValue({
        outcome: 'RESERVED',
        reservation: {
          id: SESSION,
          operationId: 'local-op',
          remoteOperationId: 'remote-op',
          generation: 0,
          fence: 'fence',
          requestHash: 'a'.repeat(64),
          ownershipToken: 'token',
          sessionId: SESSION,
          assetId: ASSET,
          ownerId: USER,
          purpose: 'SUPPORT_TICKET',
          expiresAt: new Date('2026-09-14T01:00:00.000Z'),
        },
      }),
      finalize: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockResolvedValue(null),
    };
    const http = makeHttp({ internalAssets });
    await expect(
      http.handle({ method: 'GET', path: `/internal/assets/${ASSET}` }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      http.handle({
        method: 'GET',
        path: `/internal/assets/${ASSET}`,
        headers: { authorization: 'Bearer service' },
      }),
    ).resolves.toEqual({ status: 200, body: { id: ASSET, ownerId: USER } });
    await expect(
      http.handle({
        method: 'POST',
        path: '/internal/support-uploads/reserve',
        headers: { authorization: 'Bearer service' },
        body: {
          operationId: 'local-op',
          remoteOperationId: 'remote-op',
          generation: 0,
          fence: 'fence',
          requestHash: 'a'.repeat(64),
          idempotencyKey: 'idem',
          sessionId: SESSION,
          assetId: ASSET,
          ownerId: USER,
          purpose: 'SUPPORT_TICKET',
        },
      }),
    ).resolves.toMatchObject({ status: 200, body: { outcome: 'RESERVED' } });
  });
});

function makeHttp(overrides: Record<string, unknown>): AssetHttpModule {
  return new AssetHttpModule({
    resultImport: { import: vi.fn() },
    lifecycle: { requestUserDeletion: vi.fn(), restoreUserDeletion: vi.fn() },
    uploadSessions: {
      create: vi.fn(),
      complete: vi.fn(),
      createDownload: vi.fn(),
    },
    internalAssets: {
      findAvailableAsset: vi.fn(),
      reserve: vi.fn(),
      finalize: vi.fn(),
      release: vi.fn(),
      lookup: vi.fn(),
    },
    userAuthenticator: {
      authenticate: ({ authorization }) =>
        Promise.resolve(authorization === 'Bearer user' ? { userId: USER } : null),
    },
    serviceAuthenticator: {
      authenticate: ({ authorization }) =>
        Promise.resolve(
          authorization === 'Bearer service' ? { userId: 'operations-service' } : null,
        ),
    },
    providerCallbackAuthenticator: { authenticate: vi.fn() },
    providerTaskAuthorization: { authorize: vi.fn() },
    ...overrides,
  });
}
