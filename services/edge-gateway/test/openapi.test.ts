import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createGatewayApp } from '../src/app.js';

describe('production gateway contract', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('publishes complete OpenAPI 3.1 operations and edge policies', async () => {
    app = await createGatewayApp();
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    const document = response.json<{
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
      openapi: string;
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            parameters?: unknown[];
            responses?: Record<string, { content?: Record<string, unknown> }>;
          }
        >
      >;
    }>();
    const operationIds = Object.values(document.paths)
      .flatMap((path) => Object.values(path))
      .map((operation) => operation.operationId)
      .filter((value): value is string => value !== undefined)
      .sort();

    expect(response.statusCode).toBe(200);
    expect(document.openapi).toBe('3.1.0');
    expect(document.components.schemas.ApiError).toBeDefined();
    expect(document.components.securitySchemes).toMatchObject({
      AdminBearer: { bearerFormat: 'JWT', scheme: 'bearer', type: 'http' },
      UserBearer: { bearerFormat: 'JWT', scheme: 'bearer', type: 'http' },
    });
    expect(document.paths['/v1/tasks']?.post?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'idempotency-key', required: true }),
      ]),
    );
    expect(document.paths['/v1/tasks/{taskId}/events']?.get).toMatchObject({
      operationId: 'streamTaskEvents',
    });
    expect(
      document.paths['/v1/tasks/{taskId}/events']?.get?.responses?.['200']?.content?.[
        'text/event-stream'
      ],
    ).toBeDefined();
    expect(operationIds).toMatchInlineSnapshot(`
      [
        "createTask",
        "createWalletAdjustment",
        "getAdminOverview",
        "getUserDashboard",
        "listModels",
        "streamTaskEvents",
      ]
    `);
  });

  it('rejects oversized JSON without leaking parser details', async () => {
    app = await createGatewayApp({ exposeTestRoutes: true });
    const response = await app.inject({
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      payload: JSON.stringify({ value: 'x'.repeat(1024 * 1024) }),
      url: '/test/body',
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', retryable: false });
    expect(response.body).not.toContain('FST_ERR');
  });

  it('does not trust forwarded client addresses by default', async () => {
    app = await createGatewayApp({ exposeTestRoutes: true });
    const response = await app.inject({
      headers: { 'x-forwarded-for': '198.51.100.44' },
      method: 'GET',
      url: '/test/request-ip',
    });

    expect(response.json()).not.toEqual({ ip: '198.51.100.44' });
  });

  it('reports readiness failures and low-cardinality Prometheus metrics', async () => {
    app = await createGatewayApp({
      readiness: () =>
        Promise.resolve({
          checks: { redis: false, serviceDns: true, signingKeys: true },
          ok: false,
        }),
    });

    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('gateway_http_requests_total');
    expect(metrics.body).toContain('gateway_active_sse_streams');
    expect(metrics.body).not.toContain('user_id');
  });
});
