import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('operations migration frozen UUID contract', () => {
  it('adds secure ticket storage, idempotency, one-use support sessions and database state guards', () => {
    const migration = readFileSync(fileURLToPath(new URL('../prisma/migrations/20260914110000_secure_support_tickets/migration.sql', import.meta.url)), 'utf8');
    expect(migration).toContain('CREATE TABLE "TicketInternalNote"');
    expect(migration).toContain('CREATE TABLE "TicketMessageAttachment"');
    expect(migration).toContain('CREATE TABLE "FeedbackAttachment"');
    expect(migration).toContain('CREATE TABLE "SupportUploadConsumption"');
    expect(migration).toContain('"TicketMessage_idempotency_key"');
    expect(migration).toContain('"SupportUploadConsumption_sessionId_key"');
    expect(migration).toContain('OPEN -> IN_PROGRESS -> RESOLVED -> CLOSED');
    expect(migration).toContain('TICKET_INVALID_TRANSITION');
    expect(migration).toContain('TICKET_REVISION_CONFLICT');
    expect(migration).toContain('"Ticket_subject_check"');
    expect(migration).toContain('"Feedback_content_check"');
    expect(migration).toContain('"Feedback_task_subject_check"');
  });

  it('enforces UUIDv7 version and RFC variant through one helper, including claim tokens', () => {
    const migration = readFileSync(fileURLToPath(new URL('../prisma/migrations/20260831204500_versioned_packages_cms/migration.sql', import.meta.url)), 'utf8');
    expect(migration).toContain("substring(value::text from 15 for 1) = '7'");
    expect(migration).toContain("substring(value::text from 20 for 1) ~ '^[89ab]$'");
    expect(migration).toContain('("claimToken" IS NULL OR "uuid_is_v7"("claimToken"))');
    expect(migration.match(/substring\("[^"]+"::text/g)).toBeNull();
    expect(migration).toContain('"uuid_is_v7"("id")');
    expect(migration).toContain('"uuid_is_v7"("buyerId")');
    expect(migration).toContain('"uuid_is_v7"("createdBy")');
  });

  it('allows retiredAt only on a single published-to-retired transition', () => {
    const migration = readFileSync(fileURLToPath(new URL('../prisma/migrations/20260831204500_versioned_packages_cms/migration.sql', import.meta.url)), 'utf8');
    expect(migration).toContain(`OLD."status" = 'RETIRED' THEN`);
    expect(migration).toContain(`NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt" AND NOT (`);
    expect(migration).toContain(`OLD."status" = 'PUBLISHED' AND NEW."status" = 'RETIRED' AND OLD."retiredAt" IS NULL AND NEW."retiredAt" IS NOT NULL`);
    expect(migration).toContain(`OLD."status" = 'DRAFT' AND NEW."status" NOT IN ('DRAFT', 'PUBLISHED')`);
    expect(migration).toContain(`OLD."status" = 'PUBLISHED' AND NEW."status" NOT IN ('PUBLISHED', 'RETIRED')`);
    expect(migration).toContain(`OLD."status" = 'RETIRED' THEN`);
  });
});
