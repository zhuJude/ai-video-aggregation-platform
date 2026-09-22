import type { INestApplication } from '@nestjs/common';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCatalogApplication } from '../src/app.js';
import type { CatalogStore } from '../src/domain/catalog-store.js';

const providerId = '01999d31-f7a3-7c50-98ae-04a08e875401';
const modelId = '01999d31-f7a3-7c50-98ae-04a08e875402';
const capabilityVersionId = '01999d31-f7a3-7c50-98ae-04a08e875403';

describe('catalog API', () => {
  let app: INestApplication;
  let server: FastifyInstance;
  let store: CatalogStore;

  beforeEach(async () => {
    ({ app, store } = await createCatalogApplication({
      internalServiceToken: 'service-token',
    }));
    await app.init();
    server = app.getHttpAdapter().getInstance() as FastifyInstance;
    await server.ready();
  }, 60_000);

  afterEach(async () => {
    await app.close();
  });

  it('never exposes disabled models to the public endpoint', async () => {
    store.seedProvider({
      id: providerId,
      code: 'mock-provider',
      displayName: 'Mock Provider',
      status: 'ACTIVE',
      credentialRefs: ['kms://providers/mock'],
    });
    store.seedModel({
      id: modelId,
      providerId,
      code: 'hidden',
      providerModelId: 'provider-secret-model-name',
      displayName: 'Hidden model',
      modes: ['TEXT_TO_VIDEO'],
      status: 'DISABLED',
      sortOrder: 0,
      capabilityVersionId,
      capabilityStatus: 'PUBLISHED',
    });

    const response = await server.inject({ method: 'GET', url: '/v1/models' });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('returns only active models with published capabilities and strips provider internals', async () => {
    store.seedProvider({
      id: providerId,
      code: 'mock-provider',
      displayName: 'Mock Provider',
      status: 'ACTIVE',
      credentialRefs: ['kms://providers/mock'],
    });
    store.seedModel({
      id: modelId,
      providerId,
      code: 'public-model',
      providerModelId: 'provider-secret-model-name',
      displayName: 'Public model',
      modes: ['IMAGE_TO_VIDEO'],
      status: 'ACTIVE',
      sortOrder: 2,
      capabilityVersionId,
      capabilityStatus: 'PUBLISHED',
    });

    const response = await server.inject({ method: 'GET', url: '/v1/models' });
    const model = response.json<{ items: Array<Record<string, unknown>> }>().items[0];

    expect(response.statusCode).toBe(200);
    expect(model).toMatchObject({ id: modelId, code: 'public-model' });
    expect(model).not.toHaveProperty('providerModelId');
    expect(model).not.toHaveProperty('credentialRefs');
  });

  it('supports provider and model administration including ordering and maintenance', async () => {
    const providerResponse = await server.inject({
      method: 'POST',
      url: '/internal/admin/catalog/providers',
      payload: {
        id: providerId,
        code: 'mock-provider',
        displayName: 'Mock Provider',
        status: 'ACTIVE',
        credentialRefs: ['kms://providers/mock'],
      },
    });
    const modelResponse = await server.inject({
      method: 'POST',
      url: '/internal/admin/catalog/models',
      payload: {
        id: modelId,
        providerId,
        code: 'managed-model',
        providerModelId: 'mock-v1',
        displayName: 'Managed model',
        modes: ['TEXT_TO_VIDEO'],
        status: 'ACTIVE',
        sortOrder: 10,
      },
    });
    const updateResponse = await server.inject({
      method: 'PATCH',
      url: `/internal/admin/catalog/models/${modelId}`,
      payload: {
        sortOrder: 1,
        status: 'MAINTENANCE',
        maintenanceStartsAt: '2026-08-31T01:00:00.000Z',
        maintenanceEndsAt: '2026-08-31T02:00:00.000Z',
      },
    });

    expect(providerResponse.statusCode).toBe(201);
    expect(modelResponse.statusCode).toBe(201);
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      id: modelId,
      sortOrder: 1,
      status: 'MAINTENANCE',
    });
  });

  it('publishes and retires a valid draft capability through admin endpoints', async () => {
    store.seedProvider({
      id: providerId,
      code: 'mock-provider',
      displayName: 'Mock Provider',
      status: 'ACTIVE',
      credentialRefs: [],
    });
    store.seedModel({
      id: modelId,
      providerId,
      code: 'draft-capability-model',
      providerModelId: 'mock-v1',
      displayName: 'Draft model',
      modes: ['TEXT_TO_VIDEO'],
      status: 'DRAFT',
      sortOrder: 0,
      capabilityVersionId: null,
      capabilityStatus: null,
    });
    const draftResponse = await server.inject({
      method: 'POST',
      url: `/internal/admin/catalog/models/${modelId}/capabilities`,
      payload: {
        id: capabilityVersionId,
        version: 1,
        document: {
          schemaVersion: 1,
          mode: 'TEXT_TO_VIDEO',
          jsonSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
          uiSchema: {
            order: ['prompt'],
            groups: [{ key: 'basic', title: '基础', fields: ['prompt'] }],
          },
          costDimensions: [],
        },
      },
    });
    const publishResponse = await server.inject({
      method: 'POST',
      url: `/internal/admin/catalog/capabilities/${capabilityVersionId}/publish`,
      payload: { publishedBy: '01999d31-f7a3-7c50-98ae-04a08e875404' },
    });
    const retireResponse = await server.inject({
      method: 'POST',
      url: `/internal/admin/catalog/capabilities/${capabilityVersionId}/retire`,
      payload: { retiredBy: '01999d31-f7a3-7c50-98ae-04a08e875404' },
    });

    expect(draftResponse.statusCode).toBe(201);
    expect(publishResponse.statusCode).toBe(201);
    expect(publishResponse.json()).toMatchObject({ status: 'PUBLISHED' });
    expect(retireResponse.statusCode).toBe(201);
    expect(retireResponse.json()).toMatchObject({ status: 'RETIRED' });
  });

  it('exposes liveness, readiness and Prometheus metrics', async () => {
    const live = await server.inject({ method: 'GET', url: '/health/live' });
    const ready = await server.inject({ method: 'GET', url: '/health/ready' });
    const metrics = await server.inject({ method: 'GET', url: '/metrics' });

    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('service_up{service="catalog-service"} 1');
  });

  it('requires service authentication before margin guard disables a model', async () => {
    store.seedProvider({
      id: providerId,
      code: 'mock-provider',
      displayName: 'Mock Provider',
      status: 'ACTIVE',
      credentialRefs: [],
    });
    store.seedModel({
      id: modelId,
      providerId,
      code: 'margin-risk',
      providerModelId: 'mock-v1',
      displayName: 'Margin risk',
      modes: ['TEXT_TO_VIDEO'],
      status: 'ACTIVE',
      sortOrder: 0,
      capabilityVersionId,
      capabilityStatus: 'PUBLISHED',
    });
    const unauthorized = await server.inject({
      method: 'POST',
      url: `/internal/models/${modelId}/disable`,
      payload: { reason: 'MARGIN_BELOW_MINIMUM' },
    });
    const authorized = await server.inject({
      method: 'POST',
      url: `/internal/models/${modelId}/disable`,
      headers: { authorization: 'Bearer service-token' },
      payload: { reason: 'MARGIN_BELOW_MINIMUM' },
    });

    expect(unauthorized.statusCode).toBe(403);
    expect(authorized.statusCode).toBe(201);
    expect(authorized.json()).toMatchObject({ id: modelId, status: 'DISABLED' });
  });
});
