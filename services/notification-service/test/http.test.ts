import { describe, expect, it } from 'vitest';
import {
  InMemoryNotificationRepository,
  NotificationService,
} from '../src/application/notification.consumer.js';
import { NotificationHttpModule } from '../src/http/notification-http.module.js';

const USER = '01990f24-2ba2-7000-8000-000000000001';

describe('notification HTTP boundary', () => {
  it('requires verified user authentication and never accepts a body user', async () => {
    const http = new NotificationHttpModule({
      service: new NotificationService(new InMemoryNotificationRepository()),
      userAuthenticator: {
        authenticate: (request) =>
          Promise.resolve(
            request.headers.authorization === 'Bearer valid' ? { userId: USER } : null,
          ),
      },
    });
    expect(await http.handle({ method: 'GET', path: '/v1/inbox', headers: {} })).toMatchObject({
      status: 401,
      body: { code: 'UNAUTHENTICATED', retryable: false },
    });
    expect(
      await http.handle({
        method: 'GET',
        path: '/v1/inbox',
        headers: { authorization: 'Bearer valid' },
        query: { limit: '20' },
      }),
    ).toMatchObject({ status: 200, body: { items: [] } });
  });

  it('publishes OpenAPI and health routes through the Nest runtime document', async () => {
    const { NOTIFICATION_OPENAPI } = await import('../src/runtime/notification.runtime.js');
    expect(NOTIFICATION_OPENAPI.openapi).toBe('3.1.0');
    expect(NOTIFICATION_OPENAPI.paths).toHaveProperty('/health/ready');
    expect(NOTIFICATION_OPENAPI.paths).toHaveProperty('/v1/inbox');
    expect(NOTIFICATION_OPENAPI.components.schemas).toHaveProperty('ApiError');
    for (const responses of [
      NOTIFICATION_OPENAPI.paths['/v1/inbox'].get.responses,
      NOTIFICATION_OPENAPI.paths['/v1/inbox/{id}/read'].post.responses,
    ]) {
      expect(Object.keys(responses)).toEqual(['200', '400', '401', '404']);
      for (const response of Object.values(responses)) {
        expect(response.content['application/json'].schema.$ref).toMatch(
          /^#\/components\/schemas\//,
        );
      }
    }
  });
});
