import { describe, expect, it } from 'vitest';
import {
  EventEnvelopeSchema,
  MinorAmountSchema,
  PointsStringSchema,
  UtcDateTimeSchema,
  UuidSchema,
} from '../src/common/index.js';

describe('common contracts', () => {
  it('accepts integer points and rejects floating points', () => {
    expect(PointsStringSchema.parse('1200')).toBe('1200');
    expect(() => PointsStringSchema.parse('12.5')).toThrow();
    expect(MinorAmountSchema.parse('1200')).toBe('1200');
    expect(() => MinorAmountSchema.parse('12.5')).toThrow();
  });

  it('accepts only UUID v7 identifiers', () => {
    expect(UuidSchema.parse('0198f4d4-21c2-7b7d-8a03-08a0da2a51a2')).toBe(
      '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
    );
    expect(() => UuidSchema.parse('550e8400-e29b-41d4-a716-446655440000')).toThrow();
  });

  it('accepts only UTC timestamps ending in Z', () => {
    expect(UtcDateTimeSchema.parse('2026-08-28T00:00:00.000Z')).toBe(
      '2026-08-28T00:00:00.000Z',
    );
    expect(() => UtcDateTimeSchema.parse('2026-08-28T08:00:00.000+08:00')).toThrow();
  });

  it('requires event identity and trace metadata', () => {
    const event = EventEnvelopeSchema.parse({
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
      type: 'test.created.v1',
      version: 1,
      occurredAt: '2026-08-28T00:00:00.000Z',
      traceId: '3f6c12cc4fc74f7ca4a81e2f2c9d56ad',
      correlationId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
      producer: 'test-service',
      data: { ok: true },
    });
    expect(UuidSchema.parse(event.id)).toBe(event.id);
  });
});
