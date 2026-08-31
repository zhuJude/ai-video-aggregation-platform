import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');

function schemaBlock(kind: 'enum' | 'model', name: string): string {
  const match = new RegExp(`${kind} ${name} \\{([\\s\\S]*?)\\r?\\n\\}`).exec(schema);

  if (match?.[1] === undefined) {
    throw new Error(`Missing ${kind} ${name}`);
  }

  return match[1];
}

describe('generation persistence schema', () => {
  it('gives outbox commands a durable deduplication key', () => {
    const outbox = schemaBlock('model', 'OutboxEvent');

    expect(outbox).toMatch(/\bdeduplicationKey\s+String\?\s+@unique\s+@db\.VarChar\(240\)/);
  });

  it('supports an idempotency row before task creation and records its lifecycle', () => {
    const status = schemaBlock('enum', 'TaskIdempotencyStatus');
    const idempotency = schemaBlock('model', 'TaskIdempotency');

    expect(status).toMatch(/\bIN_PROGRESS\b/);
    expect(status).toMatch(/\bSUCCEEDED\b/);
    expect(status).toMatch(/\bFAILED\b/);
    expect(idempotency).toMatch(/\bstatus\s+TaskIdempotencyStatus\s+@default\(IN_PROGRESS\)/);
    expect(idempotency).toMatch(/\btaskId\s+String\?\s+@db\.Uuid/);
    expect(idempotency).toMatch(/\btask\s+GenerationTask\?\s+@relation\(/);
    expect(idempotency).toMatch(/\bproposedTaskId\s+String\s+@db\.Uuid/);
    expect(idempotency).toMatch(/\bquotedPoints\s+String\s+@db\.VarChar\(40\)/);
    expect(idempotency).toMatch(/\breserveBusinessKey\s+String\s+@db\.VarChar\(120\)/);
    expect(idempotency).toMatch(/\bcompensationBusinessKey\s+String\s+@db\.VarChar\(120\)/);
    expect(idempotency).toMatch(/\btraceId\s+String\s+@db\.Char\(32\)/);
    expect(idempotency).toMatch(/\bleaseToken\s+String\s+@unique\s+@db\.Char\(64\)/);
    expect(idempotency).toMatch(/\bphase\s+TaskCreationPhase\s+@default\(CLAIMED\)/);
  });

  it('supports actionable repair cases before a generation task exists', () => {
    const repair = schemaBlock('model', 'TaskRepairCase');
    const idempotency = schemaBlock('model', 'TaskIdempotency');

    expect(repair).toMatch(/\btaskId\s+String\?\s+@db\.Uuid/);
    expect(repair).toMatch(/\bidempotencyId\s+String\?\s+@unique\s+@db\.Uuid/);
    expect(repair).toMatch(/\bidempotency\s+TaskIdempotency\?\s+@relation\(/);
    expect(idempotency).toMatch(/\brepairCases\s+TaskRepairCase\[\]/);
  });

  it('requires the application to supply a UUIDv7 task-transition ID', () => {
    const transition = schemaBlock('model', 'TaskTransition');
    const idField = transition.split(/\r?\n/).find((line) => /^\s*id\s+/.test(line));

    expect(idField).toMatch(/\bid\s+String\s+@id\s+@db\.Uuid\s*$/);
    expect(idField).not.toContain('@default(');
  });

  it('requires complete audit metadata for every task transition', () => {
    const source = schemaBlock('enum', 'TaskTransitionSource');
    const actorType = schemaBlock('enum', 'TaskTransitionActorType');
    const transition = schemaBlock('model', 'TaskTransition');

    expect(source).toMatch(/\bAPI\b/);
    expect(source).toMatch(/\bWORKER\b/);
    expect(source).toMatch(/\bCALLBACK\b/);
    expect(source).toMatch(/\bPOLLER\b/);
    expect(source).toMatch(/\bREPAIR\b/);
    expect(actorType).toMatch(/\bUSER\b/);
    expect(actorType).toMatch(/\bOPERATOR\b/);
    expect(actorType).toMatch(/\bSERVICE\b/);
    expect(actorType).toMatch(/\bPROVIDER\b/);
    expect(transition).toMatch(/\breasonCode\s+String\s+@db\.VarChar\(80\)/);
    expect(transition).toMatch(/\bsource\s+TaskTransitionSource\b/);
    expect(transition).toMatch(/\bactorType\s+TaskTransitionActorType\b/);
    expect(transition).toMatch(/\bactorId\s+String\s+@db\.VarChar\(160\)/);
    expect(transition).toMatch(/\btraceId\s+String\s+@db\.Char\(32\)/);
  });

  it('indexes the complete deterministic user task pagination order', () => {
    const task = schemaBlock('model', 'GenerationTask');

    expect(task).toContain('@@index([userId, createdAt, id])');
  });
});
