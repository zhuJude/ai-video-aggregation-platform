/* eslint-disable @typescript-eslint/require-await -- focused in-memory Prisma seams deliberately resolve synchronously. */
import { describe, expect, it } from 'vitest';
import { PrismaResultImportRepository } from '../src/adapters/prisma-result-import.repository.js';

describe('PrismaResultImportRepository reservations', () => {
  it('reactivates an already-completed cleanup when a late write emits a new cleanup signal', async () => {
    const upserts: Array<{ update: Record<string, unknown> }> = [];
    const repository = new PrismaResultImportRepository({
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        assetCleanup: { upsert: async (input: { update: Record<string, unknown> }) => { upserts.push(input); } },
      }),
    } as never);
    const scheduledAt = new Date('2026-08-31T00:10:00.000Z');
    await repository.scheduleCleanup({ objectKey: 'results/o/late', reason: 'DUPLICATE_RACE', scheduledAt });
    expect(upserts[0]?.update).toEqual({
      reason: 'DUPLICATE_RACE', scheduledAt, deletedAt: null, claimToken: null, leaseUntil: null, lastError: null,
    });
  });
  it('uses insert-on-conflict before rereading instead of catching a poisoned transaction', async () => {
    const calls: string[] = [];
    const repository = new PrismaResultImportRepository({
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        resultImport: {
          createMany: async () => { calls.push('createMany'); return { count: 1 }; },
          findUnique: async () => { calls.push('findUnique'); return null; },
        },
      }),
    } as never, () => 'claim');
    await expect(repository.reserveImport({ idempotencyKey: 'provider:auth:owner:task', ownerId: 'owner', providerId: 'provider', authorizationId: 'auth', objectKey: 'results/owner/new', now: new Date('2026-08-31T00:00:00.000Z') })).resolves.toEqual({ kind: 'claimed', claimToken: 'claim' });
    expect(calls).toEqual(['createMany']);
  });
  it('leaves a live reservation busy without copying and reclaims it after lease expiry', async () => {
    const row = {
      id: 'import-1', idempotencyKey: 'owner:task', ownerId: 'owner', status: 'RESERVED',
      claimToken: 'old', leaseUntil: new Date('2026-08-31T00:05:00.000Z'), attempts: 1, asset: null,
    };
    const repository = new PrismaResultImportRepository({
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        resultImport: {
          createMany: async () => ({ count: 0 }),
          findUnique: async () => row,
          updateMany: async ({ data }: { data: { claimToken: string; leaseUntil: Date } }) => {
            row.claimToken = data.claimToken; row.leaseUntil = data.leaseUntil; row.attempts += 1; return { count: 1 };
          },
        },
      }),
    } as never, () => 'new-token');

    await expect(repository.reserveImport({ idempotencyKey: 'owner:task', ownerId: 'owner', providerId: 'provider', authorizationId: 'auth', objectKey: 'results/owner/new', now: new Date('2026-08-31T00:00:00.000Z') })).resolves.toEqual({ kind: 'busy' });
    await expect(repository.reserveImport({ idempotencyKey: 'owner:task', ownerId: 'owner', providerId: 'provider', authorizationId: 'auth', objectKey: 'results/owner/new', now: new Date('2026-08-31T00:06:00.000Z') })).resolves.toEqual({ kind: 'claimed', claimToken: 'new-token' });
    expect(row.attempts).toBe(2);
  });

  it('reclaims FAILED and clears its previous error', async () => {
    const updates: unknown[] = [];
    const repository = new PrismaResultImportRepository({
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        resultImport: {
          createMany: async () => ({ count: 0 }),
          findUnique: async () => ({ id: 'i', status: 'FAILED', asset: null }),
          updateMany: async (input: unknown) => { updates.push(input); return { count: 1 }; },
        },
      }),
    } as never, () => 'retry-token');
    await expect(repository.reserveImport({ idempotencyKey: 'owner:task', ownerId: 'owner', providerId: 'provider', authorizationId: 'auth', objectKey: 'results/owner/new', now: new Date('2026-08-31T00:00:00.000Z') })).resolves.toEqual({ kind: 'claimed', claimToken: 'retry-token' });
    expect(updates[0]).toMatchObject({ data: { status: 'RESERVED', claimToken: 'retry-token', lastError: null, failedAt: null, attempts: { increment: 1 } } });
  });

  it('marks failure only for the current reservation token', async () => {
    const wheres: unknown[] = [];
    const cleanups: unknown[] = [];
    const repository = new PrismaResultImportRepository({
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        resultImport: { updateMany: async ({ where }: { where: unknown }) => { wheres.push(where); return { count: 1 }; } },
        assetCleanup: { upsert: async (input: unknown) => { cleanups.push(input); } },
      }),
    } as never);
    await repository.failAndScheduleCleanup({ idempotencyKey: 'owner:task', claimToken: 'current', failedAt: new Date('2026-08-31T00:00:00.000Z'), error: 'RESULT_IMPORT_FAILED', objectKey: 'results/owner/a', scheduledAt: new Date('2026-09-07T00:00:00.000Z') });
    expect(wheres[0]).toEqual({ idempotencyKey: 'owner:task', status: 'RESERVED', claimToken: 'current' });
    expect(cleanups[0]).toMatchObject({ create: { objectKey: 'results/owner/a', reason: 'IMPORT_FAILED' } });
  });
});
