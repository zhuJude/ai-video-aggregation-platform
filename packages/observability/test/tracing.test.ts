import { describe, expect, it } from 'vitest';
import { extractTraceContext, injectTraceContext } from '../src/tracing.js';

describe('W3C trace propagation', () => {
  it('propagates traceparent and correlation ID through message headers', () => {
    const headers: Record<string, string> = {};
    injectTraceContext(headers, {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      correlationId: '01991f17-2166-7000-8000-000000000001',
    });

    expect(extractTraceContext(headers)).toEqual({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      traceFlags: '01',
      correlationId: '01991f17-2166-7000-8000-000000000001',
    });
  });

  it('rejects malformed traceparent values', () => {
    expect(
      extractTraceContext({ traceparent: 'not-a-traceparent', 'x-correlation-id': 'correlation' }),
    ).toBeUndefined();
  });
});
