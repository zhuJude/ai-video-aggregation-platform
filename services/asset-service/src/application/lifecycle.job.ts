import type { ObjectStore } from '../ports/object-store.js';

const USER_DELETE_RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export interface AssetLifecycleRepository {
  requestDeletion(ownerId: string, assetId: string, scheduledAt: Date): Promise<boolean>;
  restoreDeletion(ownerId: string, assetId: string): Promise<boolean>;
  claimDue(now: Date): Promise<Array<{ assetId: string; objectKey: string; claimToken: string }>>;
  completeDelete(assetId: string, claimToken?: string): Promise<boolean>;
  recordDeleteFailure(assetId: string, error: 'OBJECT_DELETE_FAILED', claimToken?: string): Promise<void>;
  scheduleExpiredTemporary(now: Date): Promise<number>;
  claimCleanupDue(now: Date): Promise<Array<{ cleanupId: string; objectKey: string; claimToken: string }>>;
  completeCleanup(cleanupId: string, claimToken: string): Promise<boolean>;
  recordCleanupFailure(cleanupId: string, error: 'OBJECT_DELETE_FAILED', claimToken: string): Promise<void>;
  recoverImportOrphans?(now: Date): Promise<number>;
}

export class AssetLifecycleJob {
  readonly #repository: AssetLifecycleRepository;
  readonly #objectStore: Pick<ObjectStore, 'delete'>;
  readonly #now: () => Date;

  constructor(input: {
    repository: AssetLifecycleRepository;
    objectStore: Pick<ObjectStore, 'delete'>;
    now?: () => Date;
  }) {
    this.#repository = input.repository;
    this.#objectStore = input.objectStore;
    this.#now = input.now ?? (() => new Date());
  }

  async requestUserDeletion(ownerId: string, assetId: string): Promise<boolean> {
    const scheduledAt = new Date(this.#now().getTime() + USER_DELETE_RECOVERY_WINDOW_MS);
    return this.#repository.requestDeletion(ownerId, assetId, scheduledAt);
  }

  async restoreUserDeletion(ownerId: string, assetId: string): Promise<boolean> {
    return this.#repository.restoreDeletion(ownerId, assetId);
  }

  async run(): Promise<void> {
    const now = this.#now();
    await this.#repository.recoverImportOrphans?.(now);
    await this.#repository.scheduleExpiredTemporary(now);
    for (const deletion of await this.#repository.claimDue(now)) {
      try {
        await this.#objectStore.delete(deletion.objectKey);
        await this.#repository.completeDelete(deletion.assetId, deletion.claimToken);
      } catch {
        try {
          await this.#repository.recordDeleteFailure(deletion.assetId, 'OBJECT_DELETE_FAILED', deletion.claimToken);
        } catch {
          // The lease expiry makes the work reclaimable even during a database transient failure.
        }
      }
    }
    for (const cleanup of await this.#repository.claimCleanupDue(now)) {
      try {
        await this.#objectStore.delete(cleanup.objectKey);
        await this.#repository.completeCleanup(cleanup.cleanupId, cleanup.claimToken);
      } catch {
        try {
          await this.#repository.recordCleanupFailure(cleanup.cleanupId, 'OBJECT_DELETE_FAILED', cleanup.claimToken);
        } catch {
          // Continue isolating other records; this claim is reclaimable after its lease expires.
        }
      }
    }
  }
}
