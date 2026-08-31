import { describe, expect, it } from 'vitest';
import { traceMiddleware } from '../src/index.js';

describe('traceMiddleware', () => {
  it('preserves a valid incoming trace ID and returns it to the client', async () => {
    const incomingTraceId = 'b'.repeat(32);
    const request = { headers: { 'x-trace-id': incomingTraceId } };
    const responseHeaders = new Map<string, string>();
    const reply = {
      header(name: string, value: string) {
        responseHeaders.set(name, value);
        return this;
      },
    };

    await traceMiddleware(request as never, reply as never);

    expect(request.headers['x-trace-id']).toBe(incomingTraceId);
    expect(responseHeaders.get('x-trace-id')).toBe(incomingTraceId);
  });
});
