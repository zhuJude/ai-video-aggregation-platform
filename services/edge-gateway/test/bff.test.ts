import { describe, expect, it, vi } from 'vitest';
import type { AdminSubject, UserSubject } from '../src/auth/subject.js';
import {
  ServiceClient,
  type ServiceTransport,
  type ServiceTransportRequest,
  type ServiceTransportResponse,
} from '../src/clients/service-client.js';
import { AdminBff, requireAdminPermission } from '../src/routes/admin.routes.js';
import { UserBff } from '../src/routes/user.routes.js';

const requestContext = {
  correlationId: 'b'.repeat(32),
  subjectAssertion: 'gateway-subject-assertion',
  traceId: 'a'.repeat(32),
};

const user: UserSubject = {
  kind: 'user',
  sessionId: 'session-1',
  subjectId: 'user-1',
};

const admin: AdminSubject = {
  dataScope: 'OWN',
  kind: 'admin',
  permissions: ['users:read'],
  sessionId: 'session-2',
  subjectId: 'admin-1',
};

describe('ServiceClient', () => {
  it('maps an upstream timeout to retryable SERVICE_TIMEOUT', async () => {
    const transport: ServiceTransport = () => new Promise(() => undefined);
    const client = new ServiceClient({
      baseUrl: 'http://catalog.internal',
      requestTimeoutMs: 10,
      transport,
    });

    await expect(
      client.request({ context: requestContext, method: 'GET', path: '/v1/models' }),
    ).rejects.toMatchObject({ code: 'SERVICE_TIMEOUT', retryable: true });
  });

  it('retries an idempotent read once and forwards only gateway metadata', async () => {
    const requests: ServiceTransportRequest[] = [];
    const transport: ServiceTransport = vi.fn(
      (request: ServiceTransportRequest): Promise<ServiceTransportResponse> => {
        requests.push(request);
        if (requests.length === 1) return Promise.reject(new Error('temporary reset'));
        return Promise.resolve({ body: { models: [] }, statusCode: 200 });
      },
    );
    const client = new ServiceClient({ baseUrl: 'http://catalog.internal', transport });

    await expect(
      client.request({ context: requestContext, method: 'GET', path: '/v1/models' }),
    ).resolves.toEqual({ models: [] });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers).toMatchObject({
      authorization: 'Bearer gateway-subject-assertion',
      'x-correlation-id': 'b'.repeat(32),
      'x-trace-id': 'a'.repeat(32),
    });
  });

  it('never automatically retries writes', async () => {
    const transport: ServiceTransport = vi.fn().mockRejectedValue(new Error('connection reset'));
    const client = new ServiceClient({ baseUrl: 'http://generation.internal', transport });

    await expect(
      client.request({
        body: { quoteId: 'quote-1' },
        context: requestContext,
        method: 'POST',
        path: '/v1/tasks',
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(transport).toHaveBeenCalledOnce();
  });
});

describe('BFF policies', () => {
  it('blocks an admin route without its permission', () => {
    expect(() => {
      requireAdminPermission(admin, 'wallet:adjust');
    }).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('returns successful user dashboard cards with partial-result markers', async () => {
    const bff = new UserBff({
      messages: { get: vi.fn().mockRejectedValue(new Error('notification unavailable')) },
      tasks: { get: vi.fn().mockResolvedValue([{ id: 'task-1' }]) },
      wallet: { get: vi.fn().mockResolvedValue({ available: '1000' }) },
    });

    await expect(bff.dashboard(user, requestContext)).resolves.toEqual({
      messages: null,
      partial: ['messages'],
      recentTasks: [{ id: 'task-1' }],
      wallet: { available: '1000' },
    });
  });

  it('keeps admin overview available when alerts are noncritically unavailable', async () => {
    requireAdminPermission(
      { ...admin, permissions: ['reporting:read', 'alerts:read'] },
      'reporting:read',
    );
    const bff = new AdminBff({
      alerts: { get: vi.fn().mockRejectedValue(new Error('alerts unavailable')) },
      reporting: { get: vi.fn().mockResolvedValue({ taskSuccessRate: 0.99 }) },
    });

    await expect(bff.overview(admin, requestContext)).resolves.toEqual({
      activeAlerts: null,
      partial: ['activeAlerts'],
      reporting: { taskSuccessRate: 0.99 },
    });
  });
});
