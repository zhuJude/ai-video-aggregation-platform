import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryNotificationRepository,
  NotificationService,
} from '../src/application/notification.consumer.js';
import { NotificationHttpModule } from '../src/http/notification-http.module.js';
import { bootstrapNotificationRuntime } from '../src/runtime/notification.runtime.js';

const runtimes: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe('Nest notification runtime', () => {
  it('serves liveness, readiness, OpenAPI and authenticated inbox routes', async () => {
    const http = new NotificationHttpModule({
      service: new NotificationService(new InMemoryNotificationRepository()),
      userAuthenticator: {
        authenticate: (request) =>
          Promise.resolve(
            request.headers.authorization === 'Bearer valid'
              ? { userId: '01990f24-2ba2-7000-8000-000000000001' }
              : null,
          ),
      },
    });
    const workerRunner = { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };
    const runtime = await bootstrapNotificationRuntime({
      http,
      readiness: () => Promise.resolve(true),
      metrics: () => Promise.resolve('support_notification_consumer_lag_seconds 0\n'),
      workerRunner: workerRunner as never,
    });
    runtimes.push(runtime);
    expect((await runtime.server.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(
      200,
    );
    expect(workerRunner.start).toHaveBeenCalledOnce();
    expect((await runtime.server.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(
      200,
    );
    expect(
      (await runtime.server.inject({ method: 'GET', url: '/openapi.json' })).json(),
    ).toMatchObject({ openapi: '3.1.0' });
    expect((await runtime.server.inject({ method: 'GET', url: '/metrics' })).body).toContain(
      'support_notification_consumer_lag_seconds',
    );
    expect((await runtime.server.inject({ method: 'GET', url: '/v1/inbox' })).statusCode).toBe(401);
    expect(
      (
        await runtime.server.inject({
          method: 'GET',
          url: '/v1/inbox',
          headers: { authorization: 'Bearer valid' },
        })
      ).statusCode,
    ).toBe(200);
  }, 15_000);
});
