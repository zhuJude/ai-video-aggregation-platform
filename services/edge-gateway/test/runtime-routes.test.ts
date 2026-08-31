import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PublicApiError } from '@repo/service-kit';
import { createGatewayApp } from '../src/app.js';
import type { AdminSubject, UserSubject } from '../src/auth/subject.js';
import { ServiceClient, type ServiceTransport } from '../src/clients/service-client.js';
import { registerGatewayRoutes } from '../src/runtime/gateway-routes.js';

const user: UserSubject = { kind: 'user', sessionId: 'session-1', subjectId: 'user-1' };
const admin: AdminSubject = {
  dataScope: 'ALL',
  kind: 'admin',
  permissions: ['users:read'],
  sessionId: 'session-2',
  subjectId: 'admin-1',
};

describe('production route wiring', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('serves documented routes through authentication, limits and internal clients', async () => {
    const transport: ServiceTransport = vi.fn().mockResolvedValue({
      body: { models: [{ id: 'model-1' }] },
      statusCode: 200,
    });
    const catalog = new ServiceClient({ baseUrl: 'http://catalog.internal', transport });
    app = await createGatewayApp({
      configure: (instance) => {
        registerGatewayRoutes(instance, {
          adminBff: { overview: vi.fn() },
          authenticateAdmin: vi.fn().mockResolvedValue({
            context: {
              correlationId: 'b'.repeat(32),
              subjectAssertion: 'admin-assertion',
              traceId: 'a'.repeat(32),
            },
            subject: admin,
          }),
          authenticateUser: vi.fn().mockResolvedValue({
            context: {
              correlationId: 'b'.repeat(32),
              subjectAssertion: 'user-assertion',
              traceId: 'a'.repeat(32),
            },
            subject: user,
          }),
          catalog,
          generation: new ServiceClient({ baseUrl: 'http://generation.internal', transport }),
          idempotency: { claim: vi.fn().mockResolvedValue({ replay: false }) },
          rateLimiter: {
            consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
          },
          taskEvents: { open: vi.fn() },
          userBff: { dashboard: vi.fn() },
          wallet: new ServiceClient({ baseUrl: 'http://wallet.internal', transport }),
        });
      },
    });

    const response = await app.inject({
      headers: { authorization: 'Bearer browser-token' },
      method: 'GET',
      url: '/v1/models',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ models: [{ id: 'model-1' }] });
  });

  it('returns stable policy errors from real command routes', async () => {
    const transport: ServiceTransport = vi.fn().mockResolvedValue({ body: {}, statusCode: 202 });
    const client = new ServiceClient({ baseUrl: 'http://service.internal', transport });
    app = await createGatewayApp({
      configure: (instance) => {
        registerGatewayRoutes(instance, {
          adminBff: { overview: vi.fn() },
          authenticateAdmin: vi.fn().mockResolvedValue({
            context: {
              correlationId: 'b'.repeat(32),
              subjectAssertion: 'admin-assertion',
              traceId: 'a'.repeat(32),
            },
            subject: admin,
          }),
          authenticateUser: vi.fn().mockResolvedValue({
            context: {
              correlationId: 'b'.repeat(32),
              subjectAssertion: 'user-assertion',
              traceId: 'a'.repeat(32),
            },
            subject: user,
          }),
          catalog: client,
          generation: client,
          idempotency: {
            claim: vi
              .fn()
              .mockRejectedValue(new PublicApiError('IDEMPOTENCY_REQUIRED', '缺少幂等键', false)),
          },
          rateLimiter: {
            consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
          },
          taskEvents: { open: vi.fn() },
          userBff: { dashboard: vi.fn() },
          wallet: client,
        });
      },
    });

    const task = await app.inject({
      headers: { authorization: 'Bearer browser-token' },
      method: 'POST',
      payload: {},
      url: '/v1/tasks',
    });
    const adjustment = await app.inject({
      headers: {
        authorization: 'Bearer admin-token',
        'idempotency-key': 'request-key-1234567890',
      },
      method: 'POST',
      payload: {},
      url: '/admin/v1/wallet/adjustments',
    });

    expect(task.statusCode).toBe(400);
    expect(task.json()).toMatchObject({ code: 'IDEMPOTENCY_REQUIRED' });
    expect(adjustment.statusCode).toBe(403);
    expect(adjustment.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('forwards an accepted idempotency key to the command service', async () => {
    const transport: ServiceTransport = vi.fn().mockResolvedValue({
      body: { taskId: 'task-1' },
      statusCode: 202,
    });
    const client = new ServiceClient({ baseUrl: 'http://service.internal', transport });
    app = await createGatewayApp({
      configure: (instance) => {
        registerGatewayRoutes(instance, {
          adminBff: { overview: vi.fn() },
          authenticateAdmin: vi.fn(),
          authenticateUser: vi.fn().mockResolvedValue({
            context: {
              correlationId: 'b'.repeat(32),
              subjectAssertion: 'user-assertion',
              traceId: 'a'.repeat(32),
            },
            subject: user,
          }),
          catalog: client,
          generation: client,
          idempotency: { claim: vi.fn().mockResolvedValue({ replay: false }) },
          rateLimiter: {
            consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
          },
          taskEvents: { open: vi.fn() },
          userBff: { dashboard: vi.fn() },
          wallet: client,
        });
      },
    });

    const response = await app.inject({
      headers: {
        authorization: 'Bearer browser-token',
        'idempotency-key': 'request-key-1234567890',
      },
      method: 'POST',
      payload: { prompt: 'hello' },
      url: '/v1/tasks',
    });

    expect(response.statusCode).toBe(202);
    expect(vi.mocked(transport).mock.calls[0]?.[0].headers['idempotency-key']).toBe(
      'request-key-1234567890',
    );
  });
});
