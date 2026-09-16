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
      'OutboxEvent',
    ]) {
      expect(schema).toContain(`model ${model}`);
    }
  });

  it('enforces task/message/attempt/callback/outbox idempotency in PostgreSQL', async () => {
    const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    expect(schema).toContain('taskId');
    expect(schema).toMatch(/taskId\s+String\s+@unique\s+@db\.Uuid/);
    expect(schema).toContain('@@unique([consumer, messageId])');
    expect(schema).toContain('@@unique([executionId, attemptNumber])');
    expect(schema).toMatch(/providerEventId\s+String\s+@unique/);
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
});
