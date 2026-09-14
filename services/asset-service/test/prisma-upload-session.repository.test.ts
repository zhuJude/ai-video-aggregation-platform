/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment -- focused in-memory Prisma seams deliberately resolve synchronously. */
import { describe, expect, it, vi } from 'vitest';
import {
  PrismaUploadSessionRepository,
  type PrismaUploadSessionClient,
} from '../src/adapters/prisma-upload-session.repository.js';

const ownerId = '018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7a';
const sessionId = '018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7c';
const assetId = '018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7d';
const completedAt = new Date('2026-08-31T00:00:00.000Z');

function makePrismaSeam(sessionUpdateCount: number) {
  const asset = {
    create: vi.fn(() => Promise.resolve()),
    findFirst: vi.fn<(input: unknown) => Promise<unknown>>(() => Promise.resolve(null)),
    findUnique: vi.fn(() =>
      Promise.resolve({
        id: assetId,
        ownerId,
        kind: 'UPLOAD',
        objectKey: `uploads/${ownerId}/018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7e`,
        originalFileName: 'avatar.png',
        mimeType: 'image/png',
        sizeBytes: 200n,
        checksum: 'sha256:example',
        status: 'AVAILABLE',
      }),
    ),
    updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
  };
  const uploadSession = {
    create: vi.fn(() => Promise.resolve()),
    findFirst: vi.fn(() => Promise.resolve({ assetId })),
    findUnique: vi.fn(() => Promise.resolve(null)),
    updateMany: vi.fn(() => Promise.resolve({ count: sessionUpdateCount })),
  };
  const assetDeletion = {
    create: vi.fn(() => Promise.resolve()),
  };
  const transaction = { asset, uploadSession, assetDeletion };
  return {
    client: {
      $transaction: vi.fn((callback: (tx: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    },
    asset,
    uploadSession,
    assetDeletion,
  };
}

describe('PrismaUploadSessionRepository', () => {
  it('persists a 24-hour temporary retention timestamp when a direct upload completes', async () => {
    const updates: unknown[] = [];
    const repository = new PrismaUploadSessionRepository({
      $transaction: async (work: never) =>
        (work as unknown as (tx: unknown) => Promise<unknown>)({
          uploadSession: {
            findFirst: async () => ({ assetId: 'asset' }),
            updateMany: async () => ({ count: 1 }),
          },
          asset: {
            updateMany: async (input: unknown) => {
              updates.push(input);
              return { count: 1 };
            },
            findUnique: async () => ({
              id: 'asset',
              ownerId: 'owner',
              kind: 'UPLOAD',
              objectKey: 'uploads/a',
              originalFileName: 'a.png',
              mimeType: 'image/png',
              sizeBytes: 1n,
              checksum: null,
              status: 'AVAILABLE',
            }),
          },
        }),
    } as never);
    await repository.completePending({
      sessionId: 'session',
      ownerId: 'owner',
      completedAt: new Date('2026-08-31T00:00:00.000Z'),
    });
    expect(updates[0]).toMatchObject({
      data: { temporaryExpiresAt: new Date('2026-09-01T00:00:00.000Z') },
    });
  });
  it('atomically completes a pending owned unexpired session once', async () => {
    const seam = makePrismaSeam(1);
    const repository = new PrismaUploadSessionRepository(seam.client as PrismaUploadSessionClient);

    await expect(
      repository.completePending({ sessionId, ownerId, completedAt, checksum: 'sha256:example' }),
    ).resolves.toMatchObject({ id: assetId, status: 'AVAILABLE' });
    expect(seam.client.$transaction).toHaveBeenCalledTimes(1);
    expect(seam.uploadSession.updateMany).toHaveBeenCalledWith({
      where: {
        id: sessionId,
        ownerId,
        status: 'PENDING',
        expiresAt: { gt: completedAt },
      },
      data: { status: 'COMPLETED', completedAt },
    });
    expect(seam.asset.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: assetId, ownerId, status: 'PENDING' },
        data: expect.objectContaining({
          status: 'AVAILABLE',
          availableAt: completedAt,
          checksum: 'sha256:example',
          temporaryExpiresAt: new Date('2026-09-01T00:00:00.000Z'),
        }),
      }),
    );
  });

  it('returns null when a replay loses the conditional session update', async () => {
    const seam = makePrismaSeam(0);
    const repository = new PrismaUploadSessionRepository(seam.client as PrismaUploadSessionClient);

    await expect(
      repository.completePending({ sessionId, ownerId, completedAt }),
    ).resolves.toBeNull();
    expect(seam.asset.updateMany).not.toHaveBeenCalled();
  });

  it('claims expiry only once and persists deletion work with the owner asset transition', async () => {
    const seam = makePrismaSeam(1);
    const repository = new PrismaUploadSessionRepository(seam.client as PrismaUploadSessionClient);

    await expect(
      (
        repository as unknown as {
          claimExpired(sessionId: string, ownerId: string, expiredAt: Date): Promise<boolean>;
        }
      ).claimExpired(sessionId, ownerId, completedAt),
    ).resolves.toBe(true);
    expect(seam.uploadSession.updateMany).toHaveBeenCalledWith({
      where: { id: sessionId, ownerId, status: 'PENDING', expiresAt: { lte: completedAt } },
      data: { status: 'EXPIRED' },
    });
    expect(seam.asset.updateMany).toHaveBeenCalledWith({
      where: { id: assetId, ownerId, status: 'PENDING' },
      data: { status: 'DELETING' },
    });
    expect(seam.assetDeletion.create).toHaveBeenCalledWith({
      data: {
        id: expect.any(String) as string,
        assetId,
        objectKey: `uploads/${ownerId}/018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7e`,
      },
    });
  });

  it('fails the expiry transaction when its asset transition cannot be made', async () => {
    const seam = makePrismaSeam(1);
    seam.asset.updateMany.mockResolvedValue({ count: 0 } as never);
    const repository = new PrismaUploadSessionRepository(seam.client as PrismaUploadSessionClient);

    await expect(
      (
        repository as unknown as {
          claimExpired(sessionId: string, ownerId: string, expiredAt: Date): Promise<boolean>;
        }
      ).claimExpired(sessionId, ownerId, completedAt),
    ).rejects.toThrow(/expiry asset transition failed/i);
    expect(seam.assetDeletion.create).not.toHaveBeenCalled();
  });

  it('atomically rejects a pending session and creates deletion work exactly once', async () => {
    const seam = makePrismaSeam(1);
    const repository = new PrismaUploadSessionRepository(seam.client as PrismaUploadSessionClient);

    await expect(
      (
        repository as unknown as {
          rejectPending(sessionId: string, ownerId: string, rejectedAt: Date): Promise<boolean>;
        }
      ).rejectPending(sessionId, ownerId, completedAt),
    ).resolves.toBe(true);
    expect(seam.uploadSession.updateMany).toHaveBeenCalledWith({
      where: { id: sessionId, ownerId, status: 'PENDING' },
      data: { status: 'REJECTED' },
    });
    expect(seam.asset.updateMany).toHaveBeenCalledWith({
      where: { id: assetId, ownerId, status: 'PENDING' },
      data: { status: 'DELETING', failedTemporaryExpiresAt: new Date('2026-09-07T00:00:00.000Z') },
    });
    expect(seam.assetDeletion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scheduledAt: new Date('2026-09-07T00:00:00.000Z'),
      }) as unknown,
    });
  });

  it('rolls rejection work back by failing the transaction when deletion persistence fails', async () => {
    const seam = makePrismaSeam(1);
    seam.assetDeletion.create.mockRejectedValue(new Error('deletion record unavailable'));
    const repository = new PrismaUploadSessionRepository(seam.client as PrismaUploadSessionClient);

    await expect(
      (
        repository as unknown as {
          rejectPending(sessionId: string, ownerId: string, rejectedAt: Date): Promise<boolean>;
        }
      ).rejectPending(sessionId, ownerId, completedAt),
    ).rejects.toThrow(/deletion record unavailable/i);
  });

  it('maps a nullable Prisma checksum to an omitted domain checksum', async () => {
    const seam = makePrismaSeam(1);
    seam.asset.findFirst.mockResolvedValue({
      id: assetId,
      ownerId,
      kind: 'UPLOAD',
      objectKey: `uploads/${ownerId}/018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7e`,
      originalFileName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 200n,
      checksum: null,
      status: 'AVAILABLE',
    });
    const repository = new PrismaUploadSessionRepository(seam.client as PrismaUploadSessionClient);

    await expect(repository.findAvailableAsset(assetId, ownerId)).resolves.toEqual({
      id: assetId,
      ownerId,
      kind: 'UPLOAD',
      objectKey: `uploads/${ownerId}/018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7e`,
      originalFileName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 200n,
      status: 'AVAILABLE',
    });
  });
});
