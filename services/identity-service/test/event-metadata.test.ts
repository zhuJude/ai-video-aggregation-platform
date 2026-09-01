import { describe, expect, it } from 'vitest';

import { EventMetadata } from '../src/domain/event-metadata.js';

describe('EventMetadata', () => {
  it('preserves valid ingress trace and v7 correlation/causation identifiers', () => {
    const metadata = EventMetadata.fromIngress({
      traceId: '0123456789abcdef0123456789abcdef',
      correlationId: '0198fabc-1234-7abc-8abc-111111111111',
      causationId: '0198fabc-1234-7abc-8abc-222222222222',
    });
    expect(metadata).toEqual({
      traceId: '0123456789abcdef0123456789abcdef',
      correlationId: '0198fabc-1234-7abc-8abc-111111111111',
      causationId: '0198fabc-1234-7abc-8abc-222222222222',
    });
    expect(Object.isFrozen(metadata)).toBe(true);
  });

  it('replaces invalid untrusted metadata without rejecting authentication', () => {
    const metadata = EventMetadata.fromIngress({
      traceId: 'attacker',
      correlationId: 'v4-or-invalid',
      causationId: 'also-invalid',
    });
    expect(metadata.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(metadata.correlationId).toMatch(/-7[0-9a-f]{3}-[89ab]/);
    expect(metadata.causationId).toBeUndefined();
  });

  it('rejects a plain object that bypassed the ingress factory', () => {
    expect(() =>
      EventMetadata.assertTrusted({
        traceId: '0123456789abcdef0123456789abcdef',
        correlationId: '0198fabc-1234-7abc-8abc-111111111111',
      } as EventMetadata),
    ).toThrow('UNTRUSTED_EVENT_METADATA');
  });
});
