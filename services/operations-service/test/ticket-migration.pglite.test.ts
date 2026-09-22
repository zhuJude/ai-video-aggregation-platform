import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const migrationsRoot = join(
  workspaceRoot,
  'services',
  'operations-service',
  'prisma',
  'migrations',
);
const task3Migration = readFileSync(
  join(migrationsRoot, '20260831204500_versioned_packages_cms', 'migration.sql'),
  'utf8',
);
const task4Migration = readFileSync(
  join(migrationsRoot, '20260914110000_secure_support_tickets', 'migration.sql'),
  'utf8',
);

describe('secure ticket migrations on embedded PostgreSQL', () => {
  it('applies Task 3 and Task 4 from empty and upgrades a deployed Task 3 schema without data loss', async () => {
    const fromEmpty = await createDatabase();
    await fromEmpty.exec(task3Migration);
    await fromEmpty.exec(task4Migration);
    const tables = await fromEmpty.query<{ name: string }>(
      `SELECT to_regclass('"TicketInternalNote"')::text AS name`,
    );
    expect(tables.rows).toEqual([{ name: '"TicketInternalNote"' }]);
    await fromEmpty.close();

    const upgraded = await createDatabase();
    await upgraded.exec(task3Migration);
    await upgraded.exec(
      `INSERT INTO "Ticket" ("id", "userId", "subject", "status", "revision", "updatedAt") VALUES ('01990f24-2ba2-7000-8000-000000000010', '01990f24-2ba2-7000-8000-000000000001', 'existing', 'OPEN', 0, clock_timestamp())`,
    );
    await upgraded.exec(task4Migration);
    const preserved = await upgraded.query<{ subject: string; idempotencyKey: string | null }>(
      `SELECT ticket."subject", message."idempotencyKey" FROM "Ticket" ticket LEFT JOIN "TicketMessage" message ON message."ticketId" = ticket."id" WHERE ticket."id" = '01990f24-2ba2-7000-8000-000000000010'`,
    );
    expect(preserved.rows).toEqual([{ subject: 'existing', idempotencyKey: null }]);
    await upgraded.close();
  }, 30_000);

  it('enforces transitions, reply/reopen guards, UUIDv7, revision CAS and one-use support sessions', async () => {
    const db = await createDatabase();
    await db.exec(task3Migration);
    await db.exec(task4Migration);
    const user = '01990f24-2ba2-7000-8000-000000000001';
    const admin = '01990f24-2ba2-7000-8000-000000000003';

    await insertTicket(db, '01990f24-2ba2-7000-8000-000000000011', user, 'OPEN');
    await expect(
      db.exec(
        `UPDATE "Ticket" SET "resolutionCycle" = 1, "revision" = 1 WHERE "id" = '01990f24-2ba2-7000-8000-000000000011'`,
      ),
    ).rejects.toThrow(/TICKET_INVALID_TRANSITION/);
    await expect(
      db.exec(
        `UPDATE "Ticket" SET "status" = 'RESOLVED', "revision" = 1, "resolvedAt" = clock_timestamp() WHERE "id" = '01990f24-2ba2-7000-8000-000000000011'`,
      ),
    ).rejects.toThrow(/TICKET_INVALID_TRANSITION/);

    await insertTicket(db, '01990f24-2ba2-7000-8000-000000000012', user, 'IN_PROGRESS', admin);
    await expect(
      db.exec(
        `UPDATE "Ticket" SET "status" = 'RESOLVED', "revision" = 1, "resolvedAt" = clock_timestamp() WHERE "id" = '01990f24-2ba2-7000-8000-000000000012'`,
      ),
    ).rejects.toThrow(/TICKET_REPLY_REQUIRED/);
    await db.exec(
      `INSERT INTO "TicketMessage" ("id", "ticketId", "authorId", "authorType", "body") VALUES ('01990f24-2ba2-7000-8000-000000000013', '01990f24-2ba2-7000-8000-000000000012', '${admin}', 'AGENT', 'public reply')`,
    );
    await db.exec(
      `UPDATE "Ticket" SET "status" = 'RESOLVED', "revision" = 1, "resolvedAt" = clock_timestamp() WHERE "id" = '01990f24-2ba2-7000-8000-000000000012'`,
    );
    await db.exec(
      `UPDATE "Ticket" SET "status" = 'IN_PROGRESS', "resolutionCycle" = 1, "responseRequiredSince" = clock_timestamp(), "revision" = 2, "resolvedAt" = NULL WHERE "id" = '01990f24-2ba2-7000-8000-000000000012'`,
    );
    await expect(
      db.exec(
        `UPDATE "Ticket" SET "status" = 'RESOLVED', "revision" = 3, "resolvedAt" = clock_timestamp() WHERE "id" = '01990f24-2ba2-7000-8000-000000000012'`,
      ),
    ).rejects.toThrow(/TICKET_REPLY_REQUIRED/);
    await db.exec(
      `INSERT INTO "TicketMessage" ("id", "ticketId", "authorId", "authorType", "resolutionCycle", "body") VALUES ('01990f24-2ba2-7000-8000-000000000017', '01990f24-2ba2-7000-8000-000000000012', '${admin}', 'AGENT', 1, 'new cycle reply')`,
    );
    await db.exec(
      `UPDATE "Ticket" SET "status" = 'RESOLVED', "revision" = 3, "resolvedAt" = clock_timestamp() WHERE "id" = '01990f24-2ba2-7000-8000-000000000012'`,
    );

    await insertResolvedTicket(db, '01990f24-2ba2-7000-8000-000000000014', user, '6 days');
    await db.exec(
      `UPDATE "Ticket" SET "status" = 'IN_PROGRESS', "resolutionCycle" = 1, "responseRequiredSince" = clock_timestamp(), "revision" = 1, "resolvedAt" = NULL WHERE "id" = '01990f24-2ba2-7000-8000-000000000014'`,
    );
    await insertResolvedTicket(db, '01990f24-2ba2-7000-8000-000000000015', user, '8 days');
    await expect(
      db.exec(
        `UPDATE "Ticket" SET "status" = 'IN_PROGRESS', "resolutionCycle" = 1, "responseRequiredSince" = clock_timestamp(), "revision" = 1, "resolvedAt" = NULL WHERE "id" = '01990f24-2ba2-7000-8000-000000000015'`,
      ),
    ).rejects.toThrow(/TICKET_REOPEN_WINDOW_EXPIRED/);

    await expect(
      db.exec(
        `INSERT INTO "Ticket" ("id", "userId", "subject", "status", "revision", "updatedAt") VALUES ('550e8400-e29b-41d4-a716-446655440000', '${user}', 'invalid id', 'OPEN', 0, clock_timestamp())`,
      ),
    ).rejects.toThrow();

    await insertTicket(db, '01990f24-2ba2-7000-8000-000000000016', user, 'OPEN');
    const claim = `UPDATE "Ticket" SET "status" = 'IN_PROGRESS', "assigneeId" = '${admin}', "revision" = "revision" + 1 WHERE "id" = '01990f24-2ba2-7000-8000-000000000016' AND "revision" = 0 RETURNING "id"`;
    const claims = await Promise.all([
      db.query<{ id: string }>(claim),
      db.query<{ id: string }>(claim),
    ]);
    expect(claims.map((result) => result.rows.length).sort()).toEqual([0, 1]);

    const consumption = (id: string) =>
      `INSERT INTO "SupportUploadConsumption" ("id", "sessionId", "ownerId", "assetId", "sourceType", "sourceId", "consumedAt") VALUES ('${id}', '01990f24-2ba2-7000-8000-000000000020', '${user}', '01990f24-2ba2-7000-8000-000000000021', 'FEEDBACK', '01990f24-2ba2-7000-8000-000000000022', clock_timestamp())`;
    await db.exec(consumption('01990f24-2ba2-7000-8000-000000000023'));
    await expect(db.exec(consumption('01990f24-2ba2-7000-8000-000000000024'))).rejects.toThrow();
    const binding = (id: string, operationId: string, remoteOperationId: string, fence: string) =>
      `INSERT INTO "SupportUploadBinding" ("id", "operationId", "generation", "remoteOperationId", "fence", "requestHash", "idempotencyKey", "reservationId", "ownershipToken", "sessionId", "ownerId", "assetId", "sourceType", "sourceId", "status", "nextAttemptAt") VALUES ('${id}', '${operationId}', 0, '${remoteOperationId}', '${fence}', '${'a'.repeat(64)}', 'migration-test', 'reservation', 'ownership-token-0001', '01990f24-2ba2-7000-8000-000000000025', '${user}', '01990f24-2ba2-7000-8000-000000000021', 'FEEDBACK', '01990f24-2ba2-7000-8000-000000000022', 'FINALIZE_PENDING', clock_timestamp())`;
    await db.exec(
      binding(
        '01990f24-2ba2-7000-8000-000000000026',
        'operation-one',
        '01990f24-2ba2-7000-8000-000000000028',
        '01990f24-2ba2-7000-8000-000000000029',
      ),
    );
    await expect(
      db.exec(
        binding(
          '01990f24-2ba2-7000-8000-000000000027',
          'operation-two',
          '01990f24-2ba2-7000-8000-000000000030',
          '01990f24-2ba2-7000-8000-000000000031',
        ),
      ),
    ).rejects.toThrow();
    await expect(
      db.exec(
        `UPDATE "SupportUploadBinding" SET "generation" = -1 WHERE "id" = '01990f24-2ba2-7000-8000-000000000026'`,
      ),
    ).rejects.toThrow();
    await expect(
      db.exec(
        `UPDATE "SupportUploadBinding" SET "fence" = '550e8400-e29b-41d4-a716-446655440000' WHERE "id" = '01990f24-2ba2-7000-8000-000000000026'`,
      ),
    ).rejects.toThrow();
    await db.exec(
      `UPDATE "SupportUploadBinding" SET "status" = 'RELEASED', "sourceType" = NULL, "sourceId" = NULL WHERE "id" = '01990f24-2ba2-7000-8000-000000000026'`,
    );
    await db.exec(
      `UPDATE "SupportUploadBinding" SET "generation" = 1, "remoteOperationId" = '01990f24-2ba2-7000-8000-000000000032', "fence" = '01990f24-2ba2-7000-8000-000000000033', "reservationId" = NULL, "ownershipToken" = NULL, "status" = 'RESERVING' WHERE "id" = '01990f24-2ba2-7000-8000-000000000026'`,
    );
    expect(
      (
        await db.query<{ generation: number; status: string }>(
          `SELECT "generation", "status" FROM "SupportUploadBinding" WHERE "id" = '01990f24-2ba2-7000-8000-000000000026'`,
        )
      ).rows,
    ).toEqual([{ generation: 1, status: 'RESERVING' }]);
    await db.close();
  }, 30_000);
});

function createDatabase(): Promise<PGlite> {
  return Promise.resolve(new PGlite());
}

async function insertTicket(
  db: PGlite,
  id: string,
  userId: string,
  status: 'OPEN' | 'IN_PROGRESS',
  assigneeId?: string,
): Promise<void> {
  await db.exec(
    `INSERT INTO "Ticket" ("id", "userId", "subject", "status", "assigneeId", "revision", "updatedAt") VALUES ('${id}', '${userId}', 'ticket', '${status}', ${assigneeId === undefined ? 'NULL' : `'${assigneeId}'`}, 0, clock_timestamp())`,
  );
}

async function insertResolvedTicket(
  db: PGlite,
  id: string,
  userId: string,
  age: string,
): Promise<void> {
  await db.exec(
    `INSERT INTO "Ticket" ("id", "userId", "subject", "status", "revision", "resolvedAt", "updatedAt") VALUES ('${id}', '${userId}', 'resolved', 'RESOLVED', 0, clock_timestamp() - INTERVAL '${age}', clock_timestamp())`,
  );
}
