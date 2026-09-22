import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EventEnvelopeSchema,
  PointsStringSchema,
  UtcDateTimeSchema,
  UuidSchema,
} from '../../packages/contracts/src/common/index.js';

const fixtureDirectory = join(import.meta.dirname, 'fixtures', 'events');

function visit(value: unknown, path: readonly string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, [...path, String(index)]));
    return;
  }

  if (value === null || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    const location = [...path, key].join('.');
    if ((key === 'id' || /Id$/.test(key)) && key !== 'traceId') {
      expect(() => UuidSchema.parse(child), `${location} must be UUIDv7`).not.toThrow();
    }
    if (/(?:points|amountMinor)$/i.test(key)) {
      expect(() => PointsStringSchema.parse(child), `${location} must be a decimal string`).not.toThrow();
    }
    if (/(?:At|Timestamp)$/.test(key)) {
      expect(() => UtcDateTimeSchema.parse(child), `${location} must be UTC ISO-8601`).not.toThrow();
    }
    visit(child, [...path, key]);
  }
}

describe('frozen cross-service event fixtures', () => {
  const fixtureNames = readdirSync(fixtureDirectory)
    .filter((name) => name.endsWith('.json'))
    .sort();

  it('has a deterministic producer fixture inventory', () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
  });

  it.each(fixtureNames)('%s conforms to the v1 envelope and scalar rules', (fixtureName) => {
    const raw: unknown = JSON.parse(readFileSync(join(fixtureDirectory, fixtureName), 'utf8'));
    const event = EventEnvelopeSchema.parse(raw);
    const versionSuffix = event.type.match(/\.v(\d+)$/);

    expect(event.type).toMatch(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\.v\d+$/);
    expect(versionSuffix).not.toBeNull();
    expect(Number(versionSuffix?.[1])).toBe(event.version);
    visit(event);
  });
});
