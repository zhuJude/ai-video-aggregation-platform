import { randomUUID } from 'node:crypto';
import type {
  AssetKind,
  AssetRecord,
  UploadSessionRecord,
  UploadSessionRepository,
  UploadSessionStatus,
} from '../application/upload-session.service.js';

type AssetStatus = 'PENDING' | 'AVAILABLE' | 'DELETING' | 'DELETED';

interface PersistedAsset {
  id: string;
  ownerId: string;
  kind: AssetKind;
  objectKey: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: bigint;
  checksum: string | null;
  status: AssetStatus;
}

interface PersistedUploadSession {
  id: string;
  ownerId: string;
  assetId: string;
  objectKey: string;
  expectedMimeType: string;
  expectedSizeBytes: bigint;
  status: UploadSessionStatus;
  expiresAt: Date;
  completedAt: Date | null;
  asset: PersistedAsset;
}

interface PrismaAssetDelegate {
  create(input: { data: PersistedAsset }): Promise<unknown>;
  findFirst(input: {
    where: { id: string; ownerId: string; status: 'AVAILABLE' };
  }): Promise<PersistedAsset | null>;
  findUnique(input: { where: { id: string } }): Promise<PersistedAsset | null>;
  updateMany(input: {
    where: { id: string; ownerId: string; status: 'PENDING' };
    data: { status: 'AVAILABLE'; availableAt: Date; checksum?: string } | { status: 'DELETING' };
  }): Promise<{ count: number }>;
}

interface PrismaUploadSessionDelegate {
  create(input: {
    data: Omit<PersistedUploadSession, 'asset' | 'completedAt' | 'status'> & {
      status: 'PENDING';
    };
  }): Promise<unknown>;
  findFirst(input: {
    where: {
      id: string;
      ownerId: string;
      status: 'PENDING';
      expiresAt?: { gt?: Date; lte?: Date };
    };
    select: { assetId: true };
  }): Promise<{ assetId: string } | null>;
  findUnique(input: {
    where: { id: string };
    include: { asset: true };
  }): Promise<PersistedUploadSession | null>;
  updateMany(input: {
    where: {
      id: string;
      ownerId?: string;
      status: 'PENDING';
      expiresAt?: { gt?: Date; lte?: Date };
    };
    data:
      | { status: 'COMPLETED'; completedAt: Date }
      | { status: 'EXPIRED' }
      | { status: 'REJECTED' };
  }): Promise<{ count: number }>;
}

interface PrismaAssetDeletionDelegate {
  create(input: { data: { id: string; assetId: string; objectKey: string } }): Promise<unknown>;
}

export interface PrismaUploadSessionTransaction {
  asset: PrismaAssetDelegate;
  uploadSession: PrismaUploadSessionDelegate;
  assetDeletion: PrismaAssetDeletionDelegate;
}

export interface PrismaUploadSessionClient {
  $transaction<T>(
    callback: (transaction: PrismaUploadSessionTransaction) => Promise<T>,
  ): Promise<T>;
}

/**
 * Production repository for a generated Prisma 7 client. The narrow structural
 * seam keeps this adapter testable without requiring a database container.
 */
export class PrismaUploadSessionRepository implements UploadSessionRepository {
  readonly #client: PrismaUploadSessionClient;

  constructor(client: PrismaUploadSessionClient) {
    this.#client = client;
  }

  async createPending(input: { session: UploadSessionRecord; asset: AssetRecord }): Promise<void> {
    await this.#client.$transaction(async (transaction) => {
      await transaction.asset.create({ data: toPersistedAsset(input.asset) });
      await transaction.uploadSession.create({
        data: {
          id: input.session.id,
          ownerId: input.session.ownerId,
          assetId: input.session.assetId,
          objectKey: input.session.objectKey,
          expectedMimeType: input.session.expectedMimeType,
          expectedSizeBytes: input.session.expectedSizeBytes,
          expiresAt: input.session.expiresAt,
          status: 'PENDING',
        },
      });
    });
  }

  async findSession(sessionId: string): Promise<UploadSessionRecord | null> {
    const session = await this.#client.$transaction((transaction) =>
      transaction.uploadSession.findUnique({ where: { id: sessionId }, include: { asset: true } }),
    );
    return session === null ? null : toUploadSessionRecord(session);
  }

  async claimExpired(sessionId: string, ownerId: string, expiredAt: Date): Promise<boolean> {
    return this.#claimTerminalPending({ sessionId, ownerId, expiredAt, status: 'EXPIRED' });
  }

  async rejectPending(sessionId: string, ownerId: string, _rejectedAt: Date): Promise<boolean> {
    void _rejectedAt;
    return this.#claimTerminalPending({ sessionId, ownerId, status: 'REJECTED' });
  }

  async completePending(input: {
    sessionId: string;
    ownerId: string;
    completedAt: Date;
    checksum?: string;
  }): Promise<AssetRecord | null> {
    return this.#client.$transaction(async (transaction) => {
      const session = await transaction.uploadSession.findFirst({
        where: {
          id: input.sessionId,
          ownerId: input.ownerId,
          status: 'PENDING',
          expiresAt: { gt: input.completedAt },
        },
        select: { assetId: true },
      });
      if (session === null) return null;

      const sessionUpdate = await transaction.uploadSession.updateMany({
        where: {
          id: input.sessionId,
          ownerId: input.ownerId,
          status: 'PENDING',
          expiresAt: { gt: input.completedAt },
        },
        data: { status: 'COMPLETED', completedAt: input.completedAt },
      });
      if (sessionUpdate.count !== 1) return null;

      const assetUpdate = await transaction.asset.updateMany({
        where: { id: session.assetId, ownerId: input.ownerId, status: 'PENDING' },
        data: {
          status: 'AVAILABLE',
          availableAt: input.completedAt,
          ...(input.checksum === undefined ? {} : { checksum: input.checksum }),
        },
      });
      if (assetUpdate.count !== 1) {
        throw new Error('Upload session completion asset transition failed');
      }
      const asset = await transaction.asset.findUnique({ where: { id: session.assetId } });
      if (asset === null) throw new Error('Completed upload asset was not found');
      return toAssetRecord(asset);
    });
  }

  async findAvailableAsset(assetId: string, ownerId: string): Promise<AssetRecord | null> {
    const asset = await this.#client.$transaction((transaction) =>
      transaction.asset.findFirst({ where: { id: assetId, ownerId, status: 'AVAILABLE' } }),
    );
    return asset === null ? null : toAssetRecord(asset);
  }

  async #claimTerminalPending(input: {
    sessionId: string;
    ownerId: string;
    status: 'EXPIRED' | 'REJECTED';
    expiredAt?: Date;
  }): Promise<boolean> {
    return this.#client.$transaction(async (transaction) => {
      const session = await transaction.uploadSession.findFirst({
        where: {
          id: input.sessionId,
          ownerId: input.ownerId,
          status: 'PENDING',
          ...(input.expiredAt === undefined ? {} : { expiresAt: { lte: input.expiredAt } }),
        },
        select: { assetId: true },
      });
      if (session === null) return false;

      const sessionUpdate = await transaction.uploadSession.updateMany({
        where: {
          id: input.sessionId,
          ownerId: input.ownerId,
          status: 'PENDING',
          ...(input.expiredAt === undefined ? {} : { expiresAt: { lte: input.expiredAt } }),
        },
        data: { status: input.status },
      });
      if (sessionUpdate.count === 0) return false;
      if (sessionUpdate.count !== 1) throw new Error('Upload session terminal transition was not unique');

      const asset = await transaction.asset.findUnique({ where: { id: session.assetId } });
      if (asset === null) throw new Error('Upload session terminal asset was not found');
      const assetUpdate = await transaction.asset.updateMany({
        where: { id: session.assetId, ownerId: input.ownerId, status: 'PENDING' },
        data: { status: 'DELETING' },
      });
      if (assetUpdate.count !== 1) {
        throw new Error(
          `Upload session ${input.status === 'EXPIRED' ? 'expiry' : 'rejection'} asset transition failed`,
        );
      }
      await transaction.assetDeletion.create({
        data: { id: randomUUID(), assetId: session.assetId, objectKey: asset.objectKey },
      });
      return true;
    });
  }
}

function toPersistedAsset(asset: AssetRecord): PersistedAsset {
  return { ...asset, checksum: asset.checksum ?? null };
}

function toUploadSessionRecord(session: PersistedUploadSession): UploadSessionRecord {
  return {
    id: session.id,
    ownerId: session.ownerId,
    assetId: session.assetId,
    kind: session.asset.kind,
    objectKey: session.objectKey,
    originalFileName: session.asset.originalFileName,
    expectedMimeType: session.expectedMimeType,
    expectedSizeBytes: session.expectedSizeBytes,
    status: session.status,
    expiresAt: session.expiresAt,
    ...(session.completedAt === null ? {} : { completedAt: session.completedAt }),
  };
}

function toAssetRecord(asset: PersistedAsset): AssetRecord {
  const status = asset.status;
  if (status !== 'PENDING' && status !== 'AVAILABLE' && status !== 'DELETING') {
    throw new Error('Asset is not usable by upload sessions');
  }
  return {
    id: asset.id,
    ownerId: asset.ownerId,
    kind: asset.kind,
    objectKey: asset.objectKey,
    originalFileName: asset.originalFileName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    status,
    ...(asset.checksum === null ? {} : { checksum: asset.checksum }),
  };
}
