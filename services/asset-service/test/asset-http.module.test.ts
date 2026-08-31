/* eslint-disable @typescript-eslint/require-await -- focused handler seams deliberately resolve synchronously. */
import { describe, expect, it, vi } from 'vitest';
import { AssetHttpModule } from '../src/http/asset-http.module.js';
import { ResultImportError } from '../src/application/result-import.service.js';
import { createAssetSupportingServices } from '../src/application/asset-service.factory.js';
import { AssetLifecycleJob } from '../src/application/lifecycle.job.js';
import { AssetOutboxJob } from '../src/adapters/prisma-outbox.dispatcher.js';
import { ProviderNonceCleanupJob } from '../src/http/http-auth.adapters.js';

const ownerId = '018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7a';
const assetId = '018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7d';
const authorizationId = '018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7e';
const callbackBody = { providerTaskId: 'task-42', sourceUrl: 'https://cdn.provider.cn/final.mp4' };

function makeModule() {
  const resultImport = { import: vi.fn(async () => ({ assetId, objectKey: `results/${ownerId}/${assetId}`, status: 'AVAILABLE' as const })) };
  const lifecycleRepository = {
    requestDeletion: vi.fn(async () => true),
    restoreDeletion: vi.fn(async () => true),
  };
  const lifecycle = new AssetLifecycleJob({ repository: lifecycleRepository as never, objectStore: { delete: vi.fn() } as never });
  const userAuthenticator = {
    authenticate: vi.fn(async (headers: Record<string, string | undefined>) => headers.authorization === 'Bearer valid-user' ? { userId: ownerId } : null),
  };
  const providerCallbackAuthenticator = {
    authenticate: vi.fn(async (request: { headers: Record<string, string | string[] | undefined> }) => request.headers['x-provider-signature'] === 'valid-signature' ? { providerId: 'provider-a' } : null),
  };
  const providerTaskAuthorization = {
    authorize: vi.fn(async (providerId: string, providerTaskId: string) => providerId === 'provider-a' && providerTaskId === 'task-42' ? {
      authorizationId,
      ownerId,
      providerTaskId,
      allowedHosts: ['cdn.provider.cn'],
      expectedMimeType: 'video/mp4',
      expectedSizeBytes: 200n,
      expectedChecksum: 'sha256:expected',
      originalFileName: 'final.mp4',
    } : null),
  };
  const module = new AssetHttpModule({ resultImport: resultImport as never, lifecycle: lifecycle as never, userAuthenticator, providerCallbackAuthenticator, providerTaskAuthorization });
  return { module, resultImport, lifecycleRepository, userAuthenticator, providerCallbackAuthenticator, providerTaskAuthorization };
}

function validCallbackRequest() {
  return {
    method: 'POST',
    path: '/internal/provider-results/import',
    headers: { 'x-provider-signature': 'valid-signature' },
    rawBody: Buffer.from(JSON.stringify(callbackBody)),
    body: callbackBody,
  };
}

describe('asset production HTTP module', () => {
  it('wires production authenticators and server-side task authorization without raw secrets', () => {
    const services = createAssetSupportingServices({
      objectStore: {} as never,
      prisma: { $transaction: vi.fn() } as never,
      eventPublisher: { publish: vi.fn() },
      identityTokenVerifier: { verifyBearerToken: vi.fn() },
      providerCallbackAuth: {
        providers: { 'provider-a': { kmsKeyReference: 'kms://asset/provider-a-callback' } },
        macVerifier: { verifyMac: vi.fn() },
      },
    });
    expect(services.http).toBeInstanceOf(AssetHttpModule);
    expect(services.outboxJob).toBeInstanceOf(AssetOutboxJob);
    expect(services.nonceCleanup).toBeInstanceOf(ProviderNonceCleanupJob);
  });

  it.each([
    ['POST', '/internal/provider-results/import'],
    ['DELETE', `/v1/assets/${assetId}`],
    ['POST', `/v1/assets/${assetId}/restore`],
  ] as const)('rejects unauthenticated %s %s', async (method, path) => {
    const { module } = makeModule();
    await expect(module.handle({ method, path, headers: {}, body: {} })).resolves.toEqual({ status: 401, body: { code: 'UNAUTHENTICATED' } });
  });

  it('ignores a forged caller-supplied principal field', async () => {
    const { module, lifecycleRepository } = makeModule();
    await expect(module.handle({ method: 'DELETE', path: `/v1/assets/${assetId}`, headers: {}, principal: { kind: 'user', subject: ownerId } } as never)).resolves.toEqual({ status: 401, body: { code: 'UNAUTHENTICATED' } });
    expect(lifecycleRepository.requestDeletion).not.toHaveBeenCalled();
  });

  it('derives owner, hosts and expected metadata from the server-side task record', async () => {
    const { module, resultImport } = makeModule();
    const response = await module.handle(validCallbackRequest());
    expect(response.status).toBe(201);
    expect(resultImport.import).toHaveBeenCalledWith({
      providerId: 'provider-a',
      authorizationId,
      ownerId,
      providerTaskId: 'task-42',
      sourceUrl: 'https://cdn.provider.cn/final.mp4',
      allowedHosts: ['cdn.provider.cn'],
      expectedMimeType: 'video/mp4',
      expectedSizeBytes: 200n,
      expectedChecksum: 'sha256:expected',
      originalFileName: 'final.mp4',
    });
  });

  it('rejects owner and metadata spoofing in a callback body', async () => {
    const { module, resultImport } = makeModule();
    await expect(module.handle({ ...validCallbackRequest(), body: { ...callbackBody, ownerId: 'spoofed' } })).resolves.toEqual({ status: 400, body: { code: 'INVALID_REQUEST' } });
    expect(resultImport.import).not.toHaveBeenCalled();
  });

  it('rejects a callback without a server-authorized provider task', async () => {
    const { module, providerTaskAuthorization } = makeModule();
    providerTaskAuthorization.authorize.mockResolvedValueOnce(null);
    await expect(module.handle(validCallbackRequest())).resolves.toEqual({ status: 403, body: { code: 'FORBIDDEN' } });
  });

  it.each([
    ['DELETE', `/v1/assets/${assetId}`, 'requestDeletion'],
    ['POST', `/v1/assets/${assetId}/restore`, 'restoreDeletion'],
  ] as const)('returns not found for cross-owner %s and derives owner only from the verified token', async (method, path, operation) => {
    const { module, lifecycleRepository } = makeModule();
    lifecycleRepository[operation].mockResolvedValueOnce(false);
    await expect(module.handle({ method, path, headers: { authorization: 'Bearer valid-user' }, body: { ownerId: 'spoofed' } })).resolves.toEqual({ status: 404, body: { code: 'ASSET_NOT_FOUND' } });
    if (operation === 'requestDeletion') {
      expect(lifecycleRepository.requestDeletion).toHaveBeenCalledWith(ownerId, assetId, expect.any(Date));
    } else {
      expect(lifecycleRepository.restoreDeletion).toHaveBeenCalledWith(ownerId, assetId);
    }
  });

  it('returns accepted for authorized deletion and no-content for restore', async () => {
    const { module } = makeModule();
    await expect(module.handle({ method: 'DELETE', path: `/v1/assets/${assetId}`, headers: { authorization: 'Bearer valid-user' } })).resolves.toEqual({ status: 202 });
    await expect(module.handle({ method: 'POST', path: `/v1/assets/${assetId}/restore`, headers: { authorization: 'Bearer valid-user' } })).resolves.toEqual({ status: 204 });
  });

  it('preserves the real lifecycle boolean contract from owner guard to HTTP 202/404', async () => {
    let owned = true;
    const lifecycle = new AssetLifecycleJob({
      repository: {
        requestDeletion: vi.fn(async (requestedOwner: string) => owned && requestedOwner === ownerId),
      } as never,
      objectStore: { delete: vi.fn() } as never,
    });
    const module = new AssetHttpModule({
      resultImport: { import: vi.fn() } as never,
      lifecycle,
      userAuthenticator: { authenticate: vi.fn(async () => ({ userId: ownerId })) },
      providerCallbackAuthenticator: { authenticate: vi.fn() },
      providerTaskAuthorization: { authorize: vi.fn() },
    });
    const request = { method: 'DELETE', path: `/v1/assets/${assetId}`, headers: { authorization: 'Bearer verified' } };
    await expect(module.handle(request)).resolves.toEqual({ status: 202 });
    owned = false;
    await expect(module.handle(request)).resolves.toEqual({ status: 404, body: { code: 'ASSET_NOT_FOUND' } });
  });

  it('maps import domain failures without exposing internal messages', async () => {
    const { module, resultImport } = makeModule();
    resultImport.import.mockRejectedValueOnce(new ResultImportError('RESULT_URL_PRIVATE_ADDRESS', 'sensitive address detail'));
    await expect(module.handle(validCallbackRequest())).resolves.toEqual({ status: 422, body: { code: 'RESULT_URL_PRIVATE_ADDRESS' } });
  });

  it('maps authentication adapter failures to a stable internal response', async () => {
    const { module, userAuthenticator } = makeModule();
    userAuthenticator.authenticate.mockRejectedValueOnce(new Error('JWKS backend details'));
    await expect(module.handle({ method: 'DELETE', path: `/v1/assets/${assetId}`, headers: { authorization: 'Bearer any' } })).resolves.toEqual({ status: 500, body: { code: 'INTERNAL_ERROR' } });
  });
});
