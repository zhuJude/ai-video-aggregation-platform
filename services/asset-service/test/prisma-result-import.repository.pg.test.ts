/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- integration harness mirrors the injected Prisma surface. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PrismaResultImportRepository } from '../src/adapters/prisma-result-import.repository.js';

const execute = promisify(execFile);
const pgContainer = process.env.ASSET_PG_CONTAINER;

describe.skipIf(pgContainer === undefined)('PrismaResultImportRepository PostgreSQL concurrency', () => {
  it('lets exactly one of two simultaneous insert-on-conflict reservations claim the key', async () => {
    const key = 'provider-a:018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7e:018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7a:pg-race';
    await psql(`DELETE FROM "ResultImport" WHERE "idempotencyKey" = ${literal(key)}`);
    const makeRepository = (token: string) => new PrismaResultImportRepository(pgClient(), () => token);
    const input = {
      idempotencyKey: key,
      ownerId: '018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7a',
      providerId: 'provider-a',
      authorizationId: '018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7e',
      objectKey: 'results/018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7a/pg-race',
      now: new Date('2026-08-31T00:00:00.000Z'),
    };
    const outcomes = await Promise.all([makeRepository('claim-a').reserveImport(input), makeRepository('claim-b').reserveImport(input)]);
    expect(outcomes.filter((outcome) => outcome.kind === 'claimed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'busy')).toHaveLength(1);
  });
});

function pgClient(): any {
  return {
    $transaction: async (work: (tx: any) => Promise<unknown>) => work({
      resultImport: {
        createMany: async ({ data }: { data: any[] }) => {
          const row = data[0];
          const output = await psql(`WITH inserted AS (
            INSERT INTO "ResultImport" ("id", "idempotencyKey", "ownerId", "providerId", "authorizationId", "reservedObjectKey", "status", "claimToken", "leaseUntil", "attempts")
            VALUES (${literal(row.id)}, ${literal(row.idempotencyKey)}, ${literal(row.ownerId)}, ${literal(row.providerId)}, ${literal(row.authorizationId)}, ${literal(row.reservedObjectKey)}, 'RESERVED', ${literal(row.claimToken)}, ${literal(row.leaseUntil.toISOString())}, 1)
            ON CONFLICT ("idempotencyKey") DO NOTHING RETURNING 1
          ) SELECT count(*) FROM inserted`);
          return { count: Number(output) };
        },
        findUnique: async ({ where }: { where: { idempotencyKey: string } }) => {
          const output = await psql(`SELECT "id" || '|' || "status" || '|' || COALESCE("claimToken", '') || '|' || COALESCE("leaseUntil"::text, '') FROM "ResultImport" WHERE "idempotencyKey" = ${literal(where.idempotencyKey)}`);
          if (output.length === 0) return null;
          const [id, status, claimToken, leaseUntil] = output.split('|');
          return { id, status, claimToken, leaseUntil: leaseUntil === '' ? null : new Date(leaseUntil ?? ''), asset: null, reservedObjectKey: null };
        },
      },
    }),
  };
}

async function psql(sql: string): Promise<string> {
  if (pgContainer === undefined) throw new Error('ASSET_PG_CONTAINER is required');
  const { stdout } = await execute('docker', ['exec', pgContainer, 'psql', '-U', 'postgres', '-d', 'asset_ws14', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  return stdout.trim();
}

function literal(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
