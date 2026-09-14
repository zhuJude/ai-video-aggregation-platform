/* eslint-disable @typescript-eslint/require-await -- focused in-memory seams deliberately resolve synchronously. */
import { describe, expect, it, vi } from 'vitest';
import {
  AssetLifecycleJob,
  type AssetLifecycleRepository,
} from '../src/application/lifecycle.job.js';

class MemoryLifecycleRepository implements AssetLifecycleRepository {
  readonly assets = new Map<
    string,
    {
      id: string;
      ownerId: string;
      objectKey: string;
      status: 'AVAILABLE' | 'DELETING';
      temporaryExpiresAt?: Date;
      failedTemporaryExpiresAt?: Date;
    }
  >();
  readonly deletions: Array<{
    assetId: string;
    objectKey: string;
    scheduledAt: Date;
    deletedAt?: Date;
    attempts: number;
    lastError?: string;
  }> = [];
  readonly cleanups: Array<{
    cleanupId: string;
    objectKey: string;
    scheduledAt: Date;
    deletedAt?: Date;
    attempts: number;
    lastError?: string;
    claimToken?: string;
  }> = [];
  failureRecordUnavailable = false;
  async requestDeletion(ownerId: string, assetId: string, scheduledAt: Date) {
    for (const asset of this.assets.values()) {
      if (asset.ownerId === ownerId && asset.id === assetId && asset.status === 'AVAILABLE') {
        asset.status = 'DELETED' as never;
        this.deletions.push({
          assetId: asset.id,
          objectKey: asset.objectKey,
          scheduledAt,
          attempts: 0,
        });
        return true;
      }
    }
    return false;
  }
  async restoreDeletion(ownerId: string, assetId: string) {
    const asset = this.assets.get(assetId);
    if (asset?.ownerId !== ownerId || asset.status !== ('DELETED' as never)) return false;
    asset.status = 'AVAILABLE';
    const deletion = this.deletions.find(
      (record) => record.assetId === assetId && record.deletedAt === undefined,
    );
    if (deletion !== undefined) deletion.deletedAt = new Date();
    return true;
  }
  async claimDue(now: Date) {
    return this.deletions
      .filter((record) => record.deletedAt === undefined && record.scheduledAt <= now)
      .map((record) => ({ ...record, claimToken: 'test-lease' }));
  }
  async completeDelete(assetId: string) {
    const record = this.deletions.find(
      (candidate) => candidate.assetId === assetId && candidate.deletedAt === undefined,
    );
    if (record === undefined) return false;
    record.deletedAt = new Date();
    return true;
  }
  async recordDeleteFailure(assetId: string, error: string) {
    const record = this.deletions.find(
      (candidate) => candidate.assetId === assetId && candidate.deletedAt === undefined,
    );
    if (record !== undefined) {
      record.attempts += 1;
      record.lastError = error;
    }
  }
  async scheduleExpiredTemporary() {
    return 0;
  }
  async claimCleanupDue(now: Date) {
    return this.cleanups
      .filter((record) => record.deletedAt === undefined && record.scheduledAt <= now)
      .map((record) => ({ ...record, claimToken: record.claimToken ?? 'cleanup-lease' }));
  }
  async completeCleanup(cleanupId: string, claimToken: string) {
    const record = this.cleanups.find(
      (candidate) =>
        candidate.cleanupId === cleanupId &&
        candidate.deletedAt === undefined &&
        (candidate.claimToken ?? 'cleanup-lease') === claimToken,
    );
    if (record === undefined) return false;
    record.deletedAt = new Date();
    return true;
  }
  async recordCleanupFailure(cleanupId: string, error: string, claimToken: string) {
    if (this.failureRecordUnavailable) throw new Error('database transient failure');
    const record = this.cleanups.find(
      (candidate) =>
        candidate.cleanupId === cleanupId &&
        candidate.deletedAt === undefined &&
        (candidate.claimToken ?? 'cleanup-lease') === claimToken,
    );
    if (record !== undefined) {
      record.attempts += 1;
      record.lastError = error;
    }
  }
}

describe('asset lifecycle job', () => {
  it('deletes a claimed result-import cleanup independently from deletion records', async () => {
    const repository = new MemoryLifecycleRepository();
    repository.cleanups.push({
      cleanupId: 'cleanup-1',
      objectKey: 'results/orphan',
      scheduledAt: new Date('2026-08-30T00:00:00.000Z'),
      attempts: 0,
    });
    const objectStore = { delete: vi.fn(async () => undefined) };
    const job = new AssetLifecycleJob({
      repository,
      objectStore: objectStore as never,
      now: () => new Date('2026-08-31T00:00:00.000Z'),
    });
    await job.run();
    expect(objectStore.delete).toHaveBeenCalledWith('results/orphan');
    expect(repository.cleanups[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it('records a retryable cleanup failure without preventing other cleanup records', async () => {
    const repository = new MemoryLifecycleRepository();
    repository.cleanups.push(
      {
        cleanupId: 'cleanup-1',
        objectKey: 'results/fails',
        scheduledAt: new Date('2026-08-30T00:00:00.000Z'),
        attempts: 0,
      },
      {
        cleanupId: 'cleanup-2',
        objectKey: 'results/succeeds',
        scheduledAt: new Date('2026-08-30T00:00:00.000Z'),
        attempts: 0,
      },
    );
    const objectStore = {
      delete: vi.fn(async (key: string) => {
        if (key === 'results/fails') throw new Error('offline');
      }),
    };
    const job = new AssetLifecycleJob({
      repository,
      objectStore: objectStore as never,
      now: () => new Date('2026-08-31T00:00:00.000Z'),
    });
    await job.run();
    expect(repository.cleanups[0]).toMatchObject({
      attempts: 1,
      lastError: 'OBJECT_DELETE_FAILED',
    });
    expect(repository.cleanups[1]?.deletedAt).toBeInstanceOf(Date);
  });

  it('isolates a cleanup failure even when recording that failure also errors', async () => {
    const repository = new MemoryLifecycleRepository();
    repository.failureRecordUnavailable = true;
    repository.cleanups.push(
      {
        cleanupId: 'cleanup-1',
        objectKey: 'results/fails',
        scheduledAt: new Date('2026-08-30T00:00:00.000Z'),
        attempts: 0,
      },
      {
        cleanupId: 'cleanup-2',
        objectKey: 'results/succeeds',
        scheduledAt: new Date('2026-08-30T00:00:00.000Z'),
        attempts: 0,
      },
    );
    const objectStore = {
      delete: vi.fn(async (key: string) => {
        if (key === 'results/fails') throw new Error('offline');
      }),
    };
    const job = new AssetLifecycleJob({
      repository,
      objectStore: objectStore as never,
      now: () => new Date('2026-08-31T00:00:00.000Z'),
    });
    await expect(job.run()).resolves.toBeUndefined();
    expect(objectStore.delete).toHaveBeenCalledWith('results/succeeds');
  });
  it('keeps a seven-day recovery window before physically deleting a user asset', async () => {
    const repository = new MemoryLifecycleRepository();
    repository.assets.set('asset-1', {
      id: 'asset-1',
      ownerId: 'owner-1',
      objectKey: 'results/a',
      status: 'AVAILABLE',
    });
    const objectStore = { delete: vi.fn(async () => undefined) };
    const job = new AssetLifecycleJob({
      repository,
      objectStore: objectStore as never,
      now: () => new Date('2026-08-31T00:00:00.000Z'),
    });
    await job.requestUserDeletion('owner-1', 'asset-1');
    expect(repository.deletions[0]?.scheduledAt.toISOString()).toBe('2026-09-07T00:00:00.000Z');
    await job.run();
    expect(objectStore.delete).not.toHaveBeenCalled();
  });

  it('restores only the requested asset within its recovery window and cancels deletion', async () => {
    const repository = new MemoryLifecycleRepository();
    repository.assets.set('asset-1', {
      id: 'asset-1',
      ownerId: 'owner-1',
      objectKey: 'results/a',
      status: 'AVAILABLE',
    });
    const job = new AssetLifecycleJob({ repository, objectStore: { delete: vi.fn() } as never });
    await job.requestUserDeletion('owner-1', 'asset-1');
    await expect(job.restoreUserDeletion('owner-1', 'asset-1')).resolves.toBe(true);
    expect(repository.assets.get('asset-1')?.status).toBe('AVAILABLE');
  });

  it('is idempotent and never deletes an available asset on a replay', async () => {
    const repository = new MemoryLifecycleRepository();
    repository.assets.set('asset-1', {
      id: 'asset-1',
      ownerId: 'owner-1',
      objectKey: 'results/a',
      status: 'AVAILABLE',
    });
    const objectStore = { delete: vi.fn(async () => undefined) };
    const job = new AssetLifecycleJob({
      repository,
      objectStore: objectStore as never,
      now: () => new Date('2026-08-31T00:00:00.000Z'),
    });
    await job.run();
    await job.run();
    expect(objectStore.delete).not.toHaveBeenCalled();
  });

  it('records a retryable physical deletion failure', async () => {
    const repository = new MemoryLifecycleRepository();
    repository.deletions.push({
      assetId: 'asset-1',
      objectKey: 'results/a',
      scheduledAt: new Date('2026-08-24T00:00:00.000Z'),
      attempts: 0,
    });
    const objectStore = {
      delete: vi.fn(async () => {
        throw new Error('offline');
      }),
    };
    const job = new AssetLifecycleJob({
      repository,
      objectStore: objectStore as never,
      now: () => new Date('2026-08-31T00:00:00.000Z'),
    });
    await job.run();
    expect(repository.deletions[0]).toMatchObject({
      attempts: 1,
      lastError: 'OBJECT_DELETE_FAILED',
    });
  });
});
