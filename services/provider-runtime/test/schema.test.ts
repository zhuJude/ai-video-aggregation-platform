import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('provider runtime persistence schema', () => {
  it('owns durable execution, attempts, inboxes, circuit and outbox models', async () => {
    const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    for (const model of [
      'ProviderExecution',
      'ProviderAttempt',
      'InboxMessage',
      'CallbackInbox',
      'CircuitState',
      'CircuitObservation',
      'OutboxEvent',
    ]) {
      expect(schema).toContain(`model ${model}`);
    }
  });

  it('enforces task/message/attempt/callback/outbox idempotency in PostgreSQL', async () => {
    const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    expect(schema).toContain('taskId');
    expect(schema).toMatch(/taskId\s+String\s+@db\.Uuid/);
    expect(schema).toMatch(/routeEpoch\s+Int\s+@default\(0\)/);
    expect(schema).toContain('@@unique([taskId, routeEpoch])');
    expect(schema).toContain('@@unique([consumer, messageId])');
    expect(schema).toContain('@@unique([executionId, attemptNumber])');
    expect(schema).not.toMatch(/providerEventId\s+String\s+@unique/);
    expect(schema).toContain('@@unique([providerId, providerEventId])');
    expect(schema).toMatch(/deduplicationKey\s+String\?\s+@unique/);
  });

  it('has indexes required for retry, callback, circuit and outbox workers', async () => {
    const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    expect(schema).toContain('@@index([status, nextAttemptAt])');
    expect(schema).toContain('@@index([providerId, modelCode, status])');
    expect(schema).toContain('@@index([executionId, sequence])');
    expect(schema).toContain('@@index([publishedAt, availableAt])');
    expect(schema).toMatch(/leaseToken\s+String\?\s+@db\.Char\(64\)/);
    expect(schema).toMatch(/leaseExpiresAt\s+DateTime\?\s+@db\.Timestamptz\(3\)/);
    expect(schema).toContain('@@index([status, nextPollAt])');
    expect(schema).toContain('@@index([circuitId, observedAt])');
    expect(schema).toMatch(/lastProviderSequence\s+Int\s+@default\(-1\)/);
    expect(schema).toMatch(/halfOpenProbeToken\s+String\?\s+@db\.VarChar\(160\)/);
    expect(schema).toMatch(/halfOpenProbeExpiresAt\s+DateTime\?\s+@db\.Timestamptz\(3\)/);
  });

  it('ships an initial PostgreSQL migration for empty databases', async () => {
    const migration = await readFile(
      new URL('../prisma/migrations/20260831120000_init/migration.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain('CREATE TABLE "ProviderExecution"');
    expect(migration).toContain('CREATE TABLE "ProviderAttempt"');
    expect(migration).toContain('CREATE TABLE "InboxMessage"');
    expect(migration).toContain('CREATE TABLE "OutboxEvent"');
    expect(migration).toContain('ProviderAttempt_executionId_fkey');
  });

  it('ships the callback, polling and rolling-circuit migration', async () => {
    const migration = await readFile(
      new URL(
        '../prisma/migrations/20260916090000_callback_polling_circuit/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    expect(migration).toContain('ADD COLUMN "lastProviderSequence"');
    expect(migration).toContain('ADD COLUMN "nextPollAt"');
    expect(migration).toContain('CREATE TABLE "CircuitObservation"');
    expect(migration).toContain('CircuitObservation_circuitId_fkey');
    expect(migration).toContain('CallbackInbox_providerId_providerEventId_key');
    expect(migration).toContain('halfOpenProbeExpiresAt');
  });
});
