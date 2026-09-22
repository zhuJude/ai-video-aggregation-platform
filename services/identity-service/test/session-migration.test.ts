import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('rotating session migration', () => {
  const migration = readFileSync(
    new URL('../prisma/migrations/20260901000000_rotating_sessions/migration.sql', import.meta.url),
    'utf8',
  );

  it('backfills refresh families as UUIDv7 rather than UUIDv4', () => {
    expect(migration).toContain('extract(epoch FROM clock_timestamp()) * 1000');
    expect(migration).toContain("'7' || substr");
    expect(migration).not.toMatch(/SET "family_id"\s*=\s*gen_random_uuid\(\)/);
    expect(migration).toContain('sessions_family_id_uuid_v7_check');
  });

  it('keeps old writers compatible with a database UUIDv7 family default', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION identity_uuid_v7()');
    expect(migration).toMatch(
      /ADD COLUMN "family_id" UUID DEFAULT identity_uuid_v7\(\)/,
    );
    expect(migration).toContain('SET "family_id" = identity_uuid_v7()');
    expect(migration).toContain('ALTER COLUMN "family_id" SET DEFAULT identity_uuid_v7()');
  });

  it('persists the complete event envelope structure', () => {
    for (const column of [
      '"version"',
      '"occurred_at"',
      '"trace_id"',
      '"correlation_id"',
      '"causation_id"',
      '"producer"',
      '"data"',
      '"dedupe_key"',
    ]) {
      expect(migration).toContain(column);
    }
    expect(migration).not.toContain('"payload" JSONB');
    expect(migration).toContain('outbox_events_id_uuid_v7_check');
    expect(migration).toContain('outbox_events_correlation_uuid_v7_check');
    expect(migration).toContain('outbox_events_trace_id_check');
  });
});
