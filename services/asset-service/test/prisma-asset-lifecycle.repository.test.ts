/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment -- focused in-memory Prisma seams deliberately resolve synchronously. */
import { describe, expect, it } from 'vitest';
import { PrismaAssetLifecycleRepository } from '../src/adapters/prisma-asset-lifecycle.repository.js';
import { PrismaResultImportRepository } from '../src/adapters/prisma-result-import.repository.js';
import { AssetLifecycleJob } from '../src/application/lifecycle.job.js';

describe('PrismaAssetLifecycleRepository', () => {
  it('claims cleanup work with a lease and requires its token to complete or fail', async () => {
    const updates: Array<{ where: { claimToken?: string }; data: unknown }> = [];
    const repository = new PrismaAssetLifecycleRepository(
      {
        $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
          work({
            assetCleanup: {
              findMany: async () => [{ id: 'cleanup-1', objectKey: 'results/orphan' }],
              findFirst: async () => null,
              updateMany: async (input: { where: { claimToken?: string }; data: unknown }) => {
                updates.push(input);
                return { count: input.where.claimToken === 'stale' ? 0 : 1 };
              },
            },
          }),
      } as never,
      () => 'cleanup-token',
    );
    await expect(repository.claimCleanupDue(new Date('2026-08-31T00:00:00.000Z'))).resolves.toEqual(
      [{ cleanupId: 'cleanup-1', objectKey: 'results/orphan', claimToken: 'cleanup-token' }],
    );
    await expect(repository.completeCleanup('cleanup-1', 'stale')).resolves.toBe(false);
    await repository.recordCleanupFailure('cleanup-1', 'OBJECT_DELETE_FAILED', 'cleanup-token');
    expect(updates.at(-1)).toMatchObject({
      where: { id: 'cleanup-1', claimToken: 'cleanup-token', deletedAt: null },
      data: { attempts: { increment: 1 }, claimToken: null, leaseUntil: null },
    });
  });

  it('turns each due temporary or failed asset into one guarded deletion', async () => {
    const assetUpdates: unknown[] = [];
    const upserts: unknown[] = [];
    const repository = new PrismaAssetLifecycleRepository({
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          asset: {
            findMany: async () => [
              { id: 'temporary', objectKey: 'uploads/temp', status: 'AVAILABLE' },
              { id: 'failed', objectKey: 'uploads/failed', status: 'DELETING' },
            ],
            updateMany: async (input: unknown) => {
              assetUpdates.push(input);
              return { count: 1 };
            },
          },
          assetDeletion: {
            upsert: async (input: unknown) => {
              upserts.push(input);
            },
          },
        }),
    } as never);
    await expect(
      repository.scheduleExpiredTemporary(new Date('2026-08-31T00:00:00.000Z')),
    ).resolves.toBe(2);
    expect(assetUpdates).toHaveLength(2);
    expect(upserts).toHaveLength(2);
  });

  it('allows only one worker per live lease, then reclaims after expiry with a new token', async () => {
    const row: {
      id: string;
      assetId: string;
      objectKey: string;
      claimToken: string | null;
      leaseUntil: Date | null;
    } = { id: 'd', assetId: 'asset', objectKey: 'results/a', claimToken: null, leaseUntil: null };
    let token = 0;
    const repository = new PrismaAssetLifecycleRepository(
      {
        $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
          work({
            assetDeletion: {
              findMany: async ({
                where,
              }: {
                where: { OR: Array<{ leaseUntil: null } | { leaseUntil: { lte: Date } }> };
              }) =>
                row.leaseUntil === null ||
                row.leaseUntil <= (where.OR[1] as { leaseUntil: { lte: Date } }).leaseUntil.lte
                  ? [row]
                  : [],
              updateMany: async ({
                where,
                data,
              }: {
                where: { OR: Array<{ leaseUntil: null } | { leaseUntil: { lte: Date } }> };
                data: { claimToken: string; leaseUntil: Date };
              }) => {
                const cutoff = (where.OR[1] as { leaseUntil: { lte: Date } }).leaseUntil.lte;
                if (row.leaseUntil !== null && row.leaseUntil > cutoff) return { count: 0 };
                row.claimToken = data.claimToken;
                row.leaseUntil = data.leaseUntil;
                return { count: 1 };
              },
            },
          }),
      } as never,
      () => `t${String(++token)}`,
    );
    const now = new Date('2026-08-31T00:00:00.000Z');
    await expect(repository.claimDue(now)).resolves.toEqual([
      { assetId: 'asset', objectKey: 'results/a', claimToken: 't1' },
    ]);
    await expect(repository.claimDue(now)).resolves.toEqual([]);
    await expect(repository.claimDue(new Date('2026-08-31T00:01:01.000Z'))).resolves.toEqual([
      { assetId: 'asset', objectKey: 'results/a', claimToken: 't2' },
    ]);
  });
  it('claims a due deletion once and returns a fresh lease token', async () => {
    const repository = new PrismaAssetLifecycleRepository(
      {
        $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
          work({
            assetDeletion: {
              findMany: async () => [{ id: 'delete-1', assetId: 'asset', objectKey: 'results/a' }],
              updateMany: async () => ({ count: 1 }),
            },
          }),
      } as never,
      () => 'lease-token',
    );
    await expect(repository.claimDue(new Date('2026-08-31T00:00:00.000Z'))).resolves.toEqual([
      { assetId: 'asset', objectKey: 'results/a', claimToken: 'lease-token' },
    ]);
  });
  it('requires the current lease token to complete a deletion', async () => {
    const repository = new PrismaAssetLifecycleRepository({
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          assetDeletion: {
            updateMany: async (input: { where: { claimToken?: string } }) => ({
              count: input.where.claimToken === 'current' ? 1 : 0,
            }),
          },
        }),
    } as never);
    await expect(repository.completeDelete('asset', 'old')).resolves.toBe(false);
    await expect(repository.completeDelete('asset', 'current')).resolves.toBe(true);
  });
  it('uses a guarded transaction to request then restore a single asset deletion', async () => {
    const calls: string[] = [];
    const repository = new PrismaAssetLifecycleRepository({
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          asset: {
            updateMany: async () => {
              calls.push('asset.updateMany');
              return { count: 1 };
            },
          },
          assetDeletion: {
            upsert: async () => {
              calls.push('deletion.upsert');
            },
            updateMany: async () => {
              calls.push('deletion.updateMany');
              return { count: 1 };
            },
          },
        }),
    } as never);
    await expect(
      repository.requestDeletion('owner', 'asset', new Date('2026-09-07T00:00:00.000Z')),
    ).resolves.toBe(true);
    await expect(repository.restoreDeletion('owner', 'asset')).resolves.toBe(true);
    expect(calls).toEqual([
      'asset.updateMany',
      'deletion.upsert',
      'asset.updateMany',
      'deletion.updateMany',
    ]);
  });

  it('returns false when the owner/status guarded delete transition does not match', async () => {
    const repository = new PrismaAssetLifecycleRepository({
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          asset: {
            findUnique: async () => ({ objectKey: 'results/a' }),
            updateMany: async () => ({ count: 0 }),
          },
          assetDeletion: {
            upsert: async () => {
              throw new Error('must not persist');
            },
          },
        }),
    } as never);
    await expect(
      repository.requestDeletion('wrong-owner', 'asset', new Date('2026-09-07T00:00:00.000Z')),
    ).resolves.toBe(false);
  });

  it('rebuilds durable cleanup work from failed and expired import reservations', async () => {
    const upserts: unknown[] = [];
    const repository = new PrismaAssetLifecycleRepository({
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          resultImport: {
            findMany: async () => [
              {
                reservedObjectKey: 'results/o/failed',
                status: 'FAILED',
                failedAt: new Date('2026-08-31T00:00:00.000Z'),
              },
              { reservedObjectKey: 'results/o/stale', status: 'RESERVED', failedAt: null },
            ],
          },
          assetCleanup: {
            upsert: async (input: unknown) => {
              upserts.push(input);
            },
          },
        }),
    } as never);
    await expect(
      repository.recoverImportOrphans(new Date('2026-09-01T00:00:00.000Z')),
    ).resolves.toBe(2);
    expect(upserts).toEqual([
      expect.objectContaining({
        create: expect.objectContaining({
          objectKey: 'results/o/failed',
          scheduledAt: new Date('2026-09-07T00:00:00.000Z'),
        }),
        update: expect.objectContaining({
          deletedAt: null,
          scheduledAt: new Date('2026-09-07T00:00:00.000Z'),
        }),
      }),
      expect.objectContaining({
        create: expect.objectContaining({
          objectKey: 'results/o/stale',
          scheduledAt: new Date('2026-09-01T00:00:00.000Z'),
        }),
        update: expect.objectContaining({
          deletedAt: null,
          scheduledAt: new Date('2026-09-01T00:00:00.000Z'),
        }),
      }),
    ]);
  });

  it('reactivates and deletes a completed cleanup when a stale import writes after the old generation completed', async () => {
    const now = new Date('2026-08-31T00:10:00.000Z');
    const cleanup = {
      id: 'cleanup-1',
      objectKey: 'results/o/late',
      reason: 'OLD',
      scheduledAt: new Date('2026-08-31T00:00:00.000Z'),
      deletedAt: new Date('2026-08-31T00:01:00.000Z') as Date | null,
      claimToken: null as string | null,
      leaseUntil: null as Date | null,
      lastError: null as string | null,
    };
    let objectExists = true; // the stale stream rewrote the key after the old cleanup completed
    let deletes = 0;
    const client = {
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          resultImport: {
            findUnique: async () => ({
              id: 'import-1',
              status: 'RESERVED',
              claimToken: 'new-token',
              asset: null,
            }),
            updateMany: async () => ({ count: 0 }),
            findMany: async () => [],
          },
          asset: {
            create: async () => {
              throw new Error('stale token must not persist an asset');
            },
            findMany: async () => [],
          },
          assetDeletion: { findMany: async () => [] },
          assetCleanup: {
            upsert: async ({ update }: { update: Record<string, unknown> }) => {
              Object.assign(cleanup, update);
            },
            findMany: async () =>
              cleanup.deletedAt === null && cleanup.scheduledAt <= now ? [cleanup] : [],
            findFirst: async () => cleanup,
            updateMany: async ({
              where,
              data,
            }: {
              where: { claimToken?: string };
              data: Record<string, unknown>;
            }) => {
              if (where.claimToken !== undefined && cleanup.claimToken !== where.claimToken)
                return { count: 0 };
              Object.assign(cleanup, data);
              return { count: 1 };
            },
          },
        }),
    };
    const imports = new PrismaResultImportRepository(client as never, undefined, () => now);
    await expect(
      imports.persistImported({
        idempotencyKey: 'provider:auth:owner:task',
        claimToken: 'old-token',
        asset: {
          assetId: 'asset-late',
          objectKey: cleanup.objectKey,
          ownerId: 'owner',
          mimeType: 'video/mp4',
          sizeBytes: 1n,
          originalFileName: 'late.mp4',
        },
      }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(cleanup).toMatchObject({
      deletedAt: null,
      scheduledAt: now,
      claimToken: null,
      leaseUntil: null,
    });

    const lifecycle = new AssetLifecycleJob({
      repository: new PrismaAssetLifecycleRepository(
        client as never,
        () => 'cleanup-token',
        () => now,
      ),
      objectStore: {
        delete: async () => {
          objectExists = false;
          deletes += 1;
        },
      },
      now: () => now,
    });
    await lifecycle.run();
    await lifecycle.run();
    expect(objectExists).toBe(false);
    expect(deletes).toBe(1);
    expect(cleanup.deletedAt).toEqual(now);
  });

  it('clears the recovered import object key on completion so consecutive lifecycle runs do not reactivate it', async () => {
    const now = new Date('2026-08-31T00:10:00.000Z');
    const objectKey = 'results/o/orphan';
    const importRow: {
      status: string;
      reservedObjectKey: string | null;
      failedAt: Date;
      leaseUntil: Date | null;
    } = {
      status: 'FAILED',
      reservedObjectKey: objectKey,
      failedAt: new Date('2026-08-24T00:00:00.000Z'),
      leaseUntil: null,
    };
    const cleanup = {
      id: 'cleanup-1',
      objectKey,
      scheduledAt: now,
      deletedAt: null as Date | null,
      claimToken: null as string | null,
      leaseUntil: null as Date | null,
    };
    const client = {
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          resultImport: {
            findMany: async () => (importRow.reservedObjectKey === null ? [] : [importRow]),
            updateMany: async ({
              where,
              data,
            }: {
              where: { reservedObjectKey?: string };
              data: { reservedObjectKey?: null };
            }) => {
              if (where.reservedObjectKey !== cleanup.objectKey || data.reservedObjectKey !== null)
                return { count: 0 };
              importRow.reservedObjectKey = null;
              return { count: 1 };
            },
          },
          asset: { findMany: async () => [] },
          assetDeletion: { findMany: async () => [] },
          assetCleanup: {
            upsert: async ({ update }: { update: Record<string, unknown> }) => {
              Object.assign(cleanup, update);
            },
            findMany: async () => (cleanup.deletedAt === null ? [cleanup] : []),
            findFirst: async ({ where }: { where: { claimToken: string } }) =>
              cleanup.claimToken === where.claimToken ? cleanup : null,
            updateMany: async ({
              where,
              data,
            }: {
              where: { claimToken?: string };
              data: Record<string, unknown>;
            }) => {
              if (where.claimToken !== undefined && cleanup.claimToken !== where.claimToken)
                return { count: 0 };
              Object.assign(cleanup, data);
              return { count: 1 };
            },
          },
        }),
    };
    let deletes = 0;
    const lifecycle = new AssetLifecycleJob({
      repository: new PrismaAssetLifecycleRepository(
        client as never,
        () => 'cleanup-token',
        () => now,
      ),
      objectStore: {
        delete: async () => {
          deletes += 1;
        },
      },
      now: () => now,
    });
    await lifecycle.run();
    await lifecycle.run();
    expect(deletes).toBe(1);
    expect(importRow.reservedObjectKey).toBeNull();
  });
});
