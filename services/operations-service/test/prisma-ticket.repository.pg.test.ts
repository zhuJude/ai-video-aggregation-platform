import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaTicketRepository, type PrismaTicketClient } from '../src/adapters/prisma-ticket.repository.js';
import { TicketService } from '../src/application/ticket.service.js';
import type { AttachmentReservation } from '../src/application/ticket.service.js';

const executeFile = promisify(execFile);
const databaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
const operationsRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const task3MigrationPath = join(operationsRoot, 'prisma', 'migrations', '20260831204500_versioned_packages_cms', 'migration.sql');
const task4MigrationPath = join(operationsRoot, 'prisma', 'migrations', '20260914110000_secure_support_tickets', 'migration.sql');
const USER = '01990f24-2ba2-7000-8000-000000000001';
const ADMIN = '01990f24-2ba2-7000-8000-000000000003';
const TRACE = '0123456789abcdef0123456789abcdef';
const context = { traceId: TRACE, correlationId: '01990f24-2ba2-7000-8000-000000000004' };
let prisma: PrismaClient | null = null;
let service: TicketService;

describe.skipIf(databaseUrl === undefined)('PrismaTicketRepository PostgreSQL integration', () => {
  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error('OPERATIONS_TEST_DATABASE_URL is required');
    const adapter = new PrismaPg({ connectionString: databaseUrl });
    prisma = new PrismaClient({ adapter });

    await resetDatabase();
    await applyMigration(task3MigrationPath);
    await applyMigration(task4MigrationPath);
    const fromEmpty = await client().$queryRawUnsafe<Array<{ tableName: string | null }>>(`SELECT to_regclass('"TicketInternalNote"')::text AS "tableName"`);
    expect(fromEmpty).toEqual([{ tableName: '"TicketInternalNote"' }]);

    await resetDatabase();
    await applyMigration(task3MigrationPath);
    await client().$executeRawUnsafe(`INSERT INTO "Ticket" ("id", "userId", "subject", "status", "revision", "updatedAt") VALUES ('01990f24-2ba2-7000-8000-000000000030', '${USER}', 'pre-upgrade', 'OPEN', 0, clock_timestamp())`);
    await applyMigration(task4MigrationPath);
    const upgraded = await client().$queryRawUnsafe<Array<{ subject: string }>>(`SELECT "subject" FROM "Ticket" WHERE "id" = '01990f24-2ba2-7000-8000-000000000030'`);
    expect(upgraded).toEqual([{ subject: 'pre-upgrade' }]);

    const reservations = new Map<string, AttachmentReservation>();
    service = new TicketService({
      repository: new PrismaTicketRepository(client() as unknown as PrismaTicketClient),
      attachmentAuthorization: {
        reserve: (input) => { if (input.supportUploadSessionId === undefined) return Promise.resolve(null); const reservation = reservations.get(input.remoteOperationId) ?? { id: input.supportUploadSessionId, operationId: input.operationId, remoteOperationId: input.remoteOperationId, generation: input.generation, fence: input.fence, requestHash: input.requestHash, ownershipToken: `ownership-${input.remoteOperationId}`, sessionId: input.supportUploadSessionId, assetId: input.assetId, ownerId: input.ownerId, purpose: 'SUPPORT_TICKET', expiresAt: new Date(Date.now() + 60_000) }; reservations.set(input.remoteOperationId, reservation); return Promise.resolve(reservation); },
        finalize: () => Promise.resolve(), release: () => Promise.resolve(), lookup: (operationId) => Promise.resolve(reservations.get(operationId) ?? null),
      },
      feedbackSubjectAuthorization: { assertTaskOwned: () => Promise.resolve() },
    });
  }, 60_000);

  afterAll(async () => {
    if (prisma !== null) {
      await resetDatabase();
      await prisma.$disconnect();
    }
  }, 30_000);

  it('enforces trigger state, agent reply, seven-day reopen and UUIDv7 checks', async () => {
    const open = await service.create({ subject: 'guard', body: 'initial' }, USER, context);
    const claimed = await service.claim(open.id, open.revision, ADMIN, context);
    await expect(client().$executeRawUnsafe(`UPDATE "Ticket" SET "status" = 'RESOLVED', "revision" = ${String(claimed.revision + 1)}, "resolvedAt" = clock_timestamp() WHERE "id" = '${open.id}'`)).rejects.toThrow(/TICKET_REPLY_REQUIRED/);
    const replied = await service.reply(open.id, { body: 'public reply', expectedRevision: claimed.revision }, ADMIN, 'pg-agent-reply', context);
    await service.resolve(open.id, replied.ticket.revision, ADMIN, context);

    await insertResolvedTicket('01990f24-2ba2-7000-8000-000000000031', '6 days');
    await client().$executeRawUnsafe(`UPDATE "Ticket" SET "status" = 'IN_PROGRESS', "resolutionCycle" = 1, "responseRequiredSince" = clock_timestamp(), "revision" = 1, "resolvedAt" = NULL WHERE "id" = '01990f24-2ba2-7000-8000-000000000031'`);
    await insertResolvedTicket('01990f24-2ba2-7000-8000-000000000032', '8 days');
    await expect(client().$executeRawUnsafe(`UPDATE "Ticket" SET "status" = 'IN_PROGRESS', "resolutionCycle" = 1, "responseRequiredSince" = clock_timestamp(), "revision" = 1, "resolvedAt" = NULL WHERE "id" = '01990f24-2ba2-7000-8000-000000000032'`)).rejects.toThrow(/TICKET_REOPEN_WINDOW_EXPIRED/);
    await expect(client().$executeRawUnsafe(`INSERT INTO "Ticket" ("id", "userId", "subject", "status", "revision", "updatedAt") VALUES ('550e8400-e29b-41d4-a716-446655440000', '${USER}', 'invalid uuid', 'OPEN', 0, clock_timestamp())`)).rejects.toThrow();
  });

  it('lets exactly one production repository claimant win a revision CAS', async () => {
    const ticket = await service.create({ subject: 'concurrent claim', body: 'initial' }, USER, context);
    const outcomes = await Promise.allSettled([
      service.claim(ticket.id, ticket.revision, ADMIN, context),
      service.claim(ticket.id, ticket.revision, ADMIN, context),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'TICKET_REVISION_CONFLICT' } });
  });

  it('keeps internal notes out of production user reads', async () => {
    const ticket = await service.create({ subject: 'private note', body: 'initial' }, USER, context);
    const claimed = await service.claim(ticket.id, ticket.revision, ADMIN, context);
    await service.addInternalNote(ticket.id, { body: 'database-only-secret-note', expectedRevision: claimed.revision }, ADMIN);
    const noteCount = await client().$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*) AS count FROM "TicketInternalNote" WHERE "ticketId" = '${ticket.id}'`);
    expect(noteCount[0]?.count).toBe(1n);
    expect(JSON.stringify(await service.get(ticket.id, USER))).not.toContain('database-only-secret-note');
  });

  it('enforces one-use support upload sessions through the production repository', async () => {
    const sessionId = '01990f24-2ba2-7000-8000-000000000040';
    await service.create({ subject: 'first attachment', body: 'initial', attachments: [{ assetId: '01990f24-2ba2-7000-8000-000000000041', supportUploadSessionId: sessionId }] }, USER, context);
    await expect(service.create({ subject: 'replayed attachment', body: 'initial', attachments: [{ assetId: '01990f24-2ba2-7000-8000-000000000042', supportUploadSessionId: sessionId }] }, USER, context)).rejects.toMatchObject({ code: 'SUPPORT_UPLOAD_SESSION_USED' });
  });
});

async function resetDatabase(): Promise<void> {
  await client().$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public');
}

async function applyMigration(path: string): Promise<void> {
  if (databaseUrl === undefined) throw new Error('OPERATIONS_TEST_DATABASE_URL is required');
  const executable = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
  await executeFile(executable, ['pnpm', 'exec', 'prisma', 'db', 'execute', '--file', path], { cwd: operationsRoot, env: { ...process.env, DATABASE_URL: databaseUrl } });
}

async function insertResolvedTicket(id: string, age: string): Promise<void> {
  await client().$executeRawUnsafe(`INSERT INTO "Ticket" ("id", "userId", "subject", "status", "revision", "resolvedAt", "updatedAt") VALUES ('${id}', '${USER}', 'resolved', 'RESOLVED', 0, clock_timestamp() - INTERVAL '${age}', clock_timestamp())`);
}

function client(): PrismaClient {
  if (prisma === null) throw new Error('PostgreSQL Prisma client is not initialized');
  return prisma;
}
