import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createGatewayApp } from '../src/app.js';

describe('gateway error handling', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('returns a stable redacted error with trace id', async () => {
    app = await createGatewayApp({ exposeTestRoutes: true });
    const response = await app.inject({
      method: 'GET',
      url: '/test/error',
      headers: { 'x-trace-id': 'a'.repeat(32) },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      code: 'INTERNAL_ERROR',
      message: '系统暂时不可用',
      retryable: true,
      traceId: 'a'.repeat(32),
    });
    expect(response.headers['x-trace-id']).toBe('a'.repeat(32));
    expect(response.body).not.toContain('secret-upstream-url');
  });
});
