/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- narrow Prisma structural boundary. */
import { randomUUID } from 'node:crypto';
import type { AssetLifecycleRepository } from '../application/lifecycle.job.js';

const CLAIM_LEASE_MS = 60_000;

/** Production transaction adapter. Every state transition includes status and lease guards. */
export class PrismaAssetLifecycleRepository implements AssetLifecycleRepository {
  constructor(
    private readonly client: { $transaction<T>(work: (tx: any) => Promise<T>): Promise<T> },
    private readonly token: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async requestDeletion(ownerId: string, assetId: string, scheduledAt: Date): Promise<boolean> {
    return this.client.$transaction(async (tx) => {
      const asset = await tx.asset.findUnique?.({ where: { id: assetId }, select: { objectKey: true } });
      const changed = await tx.asset.updateMany({ where: { id: assetId, ownerId, status: 'AVAILABLE' }, data: { status: 'DELETED' } });
      if (changed.count === 1) {
        await tx.assetDeletion.upsert({
          where: { assetId },
          create: { id: randomUUID(), assetId, objectKey: asset?.objectKey ?? '', scheduledAt },
          update: { scheduledAt, deletedAt: null, attempts: 0, lastError: null, claimToken: null, leaseUntil: null },
        });
        return true;
      }
      return false;
    });
  }

  async restoreDeletion(ownerId: string, assetId: string): Promise<boolean> {
    return this.client.$transaction(async (tx) => {
      const restoredAt = this.now();
      const changed = await tx.asset.updateMany({
        where: {
          id: assetId, ownerId, status: 'DELETED',
          deletions: { some: { deletedAt: null, scheduledAt: { gt: restoredAt } } },
        },
        data: { status: 'AVAILABLE' },
      });
      if (changed.count !== 1) return false;
      await tx.assetDeletion.updateMany({
        where: { assetId, deletedAt: null, scheduledAt: { gt: restoredAt } },
        data: { deletedAt: restoredAt, lastError: 'RESTORED', claimToken: null, leaseUntil: null },
      });
      return true;
    });
  }

  async claimDue(now: Date): Promise<Array<{ assetId: string; objectKey: string; claimToken: string }>> {
    return this.client.$transaction(async (tx) => {
      const due = await tx.assetDeletion.findMany({
        where: { deletedAt: null, scheduledAt: { lte: now }, asset: { status: 'DELETED' }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        take: 100,
      });
      const claims: Array<{ assetId: string; objectKey: string; claimToken: string }> = [];
      for (const row of due as Array<{ id: string; assetId: string; objectKey: string }>) {
        const claimToken = this.token();
        const updated = await tx.assetDeletion.updateMany({
          where: { id: row.id, deletedAt: null, asset: { status: 'DELETED' }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
          data: { claimToken, leaseUntil: new Date(now.getTime() + CLAIM_LEASE_MS) },
        });
        if (updated.count === 1) claims.push({ assetId: row.assetId, objectKey: row.objectKey, claimToken });
      }
      return claims;
    });
  }

  async completeDelete(assetId: string, claimToken?: string): Promise<boolean> {
    return this.client.$transaction(async (tx) => (await tx.assetDeletion.updateMany({
      where: { assetId, deletedAt: null, ...(claimToken === undefined ? {} : { claimToken }), asset: { status: 'DELETED' } },
      data: { deletedAt: this.now(), claimToken: null, leaseUntil: null },
    })).count === 1);
  }

  async recordDeleteFailure(assetId: string, error: 'OBJECT_DELETE_FAILED', claimToken?: string): Promise<void> {
    await this.client.$transaction((tx) => tx.assetDeletion.updateMany({
      where: { assetId, deletedAt: null, ...(claimToken === undefined ? {} : { claimToken }), asset: { status: 'DELETED' } },
      data: { attempts: { increment: 1 }, lastError: error, claimToken: null, leaseUntil: null },
    }));
  }

  async scheduleExpiredTemporary(now: Date): Promise<number> {
    return this.client.$transaction(async (tx) => {
      const assets = await tx.asset.findMany({
        where: {
          OR: [
            { status: 'AVAILABLE', temporaryExpiresAt: { lte: now } },
            { status: { in: ['PENDING', 'DELETING'] }, failedTemporaryExpiresAt: { lte: now } },
          ],
        },
        select: { id: true, objectKey: true, status: true },
        take: 100,
      });
      let scheduled = 0;
      for (const asset of assets as Array<{ id: string; objectKey: string; status: string }>) {
        const expiryGuard = asset.status === 'AVAILABLE'
          ? { status: 'AVAILABLE', temporaryExpiresAt: { lte: now } }
          : { status: asset.status, failedTemporaryExpiresAt: { lte: now } };
        const changed = await tx.asset.updateMany({ where: { id: asset.id, ...expiryGuard }, data: { status: 'DELETED' } });
        if (changed.count !== 1) continue;
        await tx.assetDeletion.upsert({
          where: { assetId: asset.id },
          create: { id: randomUUID(), assetId: asset.id, objectKey: asset.objectKey, scheduledAt: now },
          update: { scheduledAt: now, deletedAt: null, claimToken: null, leaseUntil: null },
        });
        scheduled += 1;
      }
      return scheduled;
    });
  }

  /** Rebuilds cleanup work from reservations whose object key was durably stored before streaming began. */
  async recoverImportOrphans(now: Date): Promise<number> {
    return this.client.$transaction(async (tx) => {
      const rows = await tx.resultImport.findMany({
        where: {
          reservedObjectKey: { not: null },
          OR: [{ status: 'FAILED' }, { status: 'RESERVED', OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }],
        },
        select: { reservedObjectKey: true, status: true, failedAt: true },
        take: 100,
      });
      let recovered = 0;
      for (const row of rows as Array<{ reservedObjectKey: string; status: string; failedAt: Date | null }>) {
        const scheduledAt = row.status === 'FAILED' && row.failedAt !== null
          ? new Date(row.failedAt.getTime() + 7 * 24 * 60 * 60 * 1_000)
          : now;
        await tx.assetCleanup.upsert({
          where: { objectKey: row.reservedObjectKey },
          create: { id: randomUUID(), objectKey: row.reservedObjectKey, reason: 'IMPORT_ORPHAN_RECOVERY', scheduledAt },
          update: { reason: 'IMPORT_ORPHAN_RECOVERY', scheduledAt, deletedAt: null, claimToken: null, leaseUntil: null, lastError: null },
        });
        recovered += 1;
      }
      return recovered;
    });
  }

  async claimCleanupDue(now: Date): Promise<Array<{ cleanupId: string; objectKey: string; claimToken: string }>> {
    return this.client.$transaction(async (tx) => {
      const due = await tx.assetCleanup.findMany({
        where: { deletedAt: null, scheduledAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        take: 100,
      });
      const claims: Array<{ cleanupId: string; objectKey: string; claimToken: string }> = [];
      for (const row of due as Array<{ id: string; objectKey: string }>) {
        const claimToken = this.token();
        const changed = await tx.assetCleanup.updateMany({
          where: { id: row.id, deletedAt: null, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
          data: { claimToken, leaseUntil: new Date(now.getTime() + CLAIM_LEASE_MS) },
        });
        if (changed.count === 1) claims.push({ cleanupId: row.id, objectKey: row.objectKey, claimToken });
      }
      return claims;
    });
  }

  async completeCleanup(cleanupId: string, claimToken: string): Promise<boolean> {
    return this.client.$transaction(async (tx) => {
      const cleanup = await tx.assetCleanup.findFirst({
        where: { id: cleanupId, deletedAt: null, claimToken },
        select: { objectKey: true },
      });
      if (cleanup === null) return false;
      const completedAt = this.now();
      const completed = await tx.assetCleanup.updateMany({
        where: { id: cleanupId, objectKey: cleanup.objectKey, deletedAt: null, claimToken },
        data: { deletedAt: completedAt, claimToken: null, leaseUntil: null },
      });
      if (completed.count !== 1) return false;
      await tx.resultImport.updateMany({
        where: {
          reservedObjectKey: cleanup.objectKey,
          OR: [
            { status: 'FAILED' },
            { status: 'RESERVED', OR: [{ leaseUntil: null }, { leaseUntil: { lte: completedAt } }] },
          ],
        },
        data: { reservedObjectKey: null },
      });
      return true;
    });
  }

  async recordCleanupFailure(cleanupId: string, error: 'OBJECT_DELETE_FAILED', claimToken: string): Promise<void> {
    await this.client.$transaction((tx) => tx.assetCleanup.updateMany({
      where: { id: cleanupId, deletedAt: null, claimToken },
      data: { attempts: { increment: 1 }, lastError: error, claimToken: null, leaseUntil: null },
    }));
  }
}
