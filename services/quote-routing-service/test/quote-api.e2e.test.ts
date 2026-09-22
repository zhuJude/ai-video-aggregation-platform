import type { INestApplication } from '@nestjs/common';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createQuoteRoutingApplication } from '../src/app.js';
import type { InMemoryQuoteRepository } from '../src/application/quote.service.js';

function requestPayload() {
  return {
    userId: '01999d31-f7a3-7c50-98ae-04a08e875503',
    mode: 'SMART',
    capabilityVersionId: '01999d31-f7a3-7c50-98ae-04a08e875504',
    parameters: { prompt: 'ocean', duration: 5 },
    candidates: [
      {
        modelId: '01999d31-f7a3-7c50-98ae-04a08e875501',
        capabilityMatch: true,
        status: 'ACTIVE',
        inMaintenance: false,
        circuitOpen: false,
        quotaExhausted: false,
        providerBalanceLow: false,
        health: 'HEALTHY',
        costPoints: '60',
        salePoints: '100',
        qualityBasisPoints: 8000,
        latencyMs: 500,
        priority: 10,
      },
    ],
    weights: { quality: 40, speed: 30, price: 30, minimumMarginBps: 2000 },
    pricingRuleVersion: 3,
    routingRuleVersion: 2,
  };
}

describe('quote and routing APIs', () => {
  let app: INestApplication;
  let server: FastifyInstance;
  let repository: InMemoryQuoteRepository;

  beforeEach(async () => {
    ({ app, repository } = await createQuoteRoutingApplication());
    await app.init();
    server = app.getHttpAdapter().getInstance() as FastifyInstance;
    await server.ready();
  }, 60_000);

  afterEach(async () => {
    await app.close();
  });

  it('creates and retrieves a ten-minute quote with decimal point strings', async () => {
    const createResponse = await server.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: requestPayload(),
    });
    const created = createResponse.json<{
      id: string;
      quotedPoints: string;
      costEstimatePoints: string;
      createdAt: string;
      expiresAt: string;
    }>();
    const getResponse = await server.inject({
      method: 'GET',
      url: `/v1/quotes/${created.id}`,
    });

    expect(createResponse.statusCode).toBe(201);
    expect(created.quotedPoints).toBe('100');
    expect(created.costEstimatePoints).toBe('60');
    expect(new Date(created.expiresAt).getTime() - new Date(created.createdAt).getTime()).toBe(
      600_000,
    );
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({ id: created.id, quotedPoints: '100' });
  });

  it('simulates a route without writing a quote', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/internal/admin/routing/simulate',
      payload: requestPayload(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      selected: { modelId: '01999d31-f7a3-7c50-98ae-04a08e875501' },
    });
    expect(repository.size).toBe(0);
  });

  it('publishes immutable rule versions and rolls back by creating a new version', async () => {
    const createResponse = await server.inject({
      method: 'POST',
      url: '/internal/admin/routing/price-rules',
      payload: {
        id: '01999d31-f7a3-7c50-98ae-04a08e875510',
        version: 1,
        effectiveAt: '2026-08-31T00:00:00.000Z',
        payload: { kind: 'COST_PLUS_MARGIN', marginBasisPoints: 2500 },
      },
    });
    const publishResponse = await server.inject({
      method: 'POST',
      url: '/internal/admin/routing/price-rules/1/publish',
      payload: { publishedBy: '01999d31-f7a3-7c50-98ae-04a08e875511' },
    });
    const rollbackResponse = await server.inject({
      method: 'POST',
      url: '/internal/admin/routing/price-rules/1/rollback',
      payload: {
        id: '01999d31-f7a3-7c50-98ae-04a08e875512',
        publishedBy: '01999d31-f7a3-7c50-98ae-04a08e875511',
        effectiveAt: '2026-08-31T01:00:00.000Z',
      },
    });

    const created = createResponse.json<{ payload: Record<string, unknown> }>();
    const published = publishResponse.json<{ version: number; status: string }>();
    const rolledBack = rollbackResponse.json<{
      version: number;
      status: string;
      payload: Record<string, unknown>;
    }>();
    expect(createResponse.statusCode).toBe(201);
    expect(published).toMatchObject({ version: 1, status: 'PUBLISHED' });
    expect(rolledBack).toMatchObject({ version: 2, status: 'PUBLISHED' });
    expect(rolledBack.payload).toEqual(created.payload);
  });

  it('exposes liveness, readiness and Prometheus metrics', async () => {
    const live = await server.inject({ method: 'GET', url: '/health/live' });
    const ready = await server.inject({ method: 'GET', url: '/health/ready' });
    const metrics = await server.inject({ method: 'GET', url: '/metrics' });

    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('service_up{service="quote-routing-service"} 1');
  });
});
