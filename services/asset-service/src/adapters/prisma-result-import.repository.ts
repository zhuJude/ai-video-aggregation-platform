/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Prisma client is injected structurally to keep this adapter independently testable. */
import { randomUUID } from 'node:crypto';
import type { ResultImportRepository, ImportedResult } from '../application/result-import.service.js';

const RESERVATION_LEASE_MS = 5 * 60 * 1_000;

/** Transactional reservation, asset and outbox persistence for provider imports. */
export class PrismaResultImportRepository implements ResultImportRepository {
  constructor(
    private readonly client: { $transaction<T>(callback: (tx: any) => Promise<T>): Promise<T> },
    private readonly token: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async findImported(idempotencyKey: string): Promise<ImportedResult | null> {
    return this.client.$transaction(async (tx) => toImported(await tx.resultImport.findUnique({ where: { idempotencyKey }, include: { asset: true } })));
  }

  async reserveImport(input: { idempotencyKey: string; ownerId: string; providerId: string; authorizationId: string; objectKey: string; now: Date }): Promise<
    { kind: 'claimed'; claimToken: string } | { kind: 'busy' } | ({ kind: 'duplicate' } & ImportedResult)
  > {
    return this.client.$transaction(async (tx) => {
      const claimToken = this.token();
      const leaseUntil = new Date(input.now.getTime() + RESERVATION_LEASE_MS);
      const inserted = await tx.resultImport.createMany({
        data: [{ id: randomUUID(), idempotencyKey: input.idempotencyKey, ownerId: input.ownerId,
          providerId: input.providerId, authorizationId: input.authorizationId, reservedObjectKey: input.objectKey,
          status: 'RESERVED', claimToken, leaseUntil, attempts: 1 }],
        skipDuplicates: true,
      });
      if (inserted.count === 1) return { kind: 'claimed' as const, claimToken };
      const row = await tx.resultImport.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { asset: true } });
      const imported = toImported(row);
      if (imported !== null) return { kind: 'duplicate' as const, ...imported };
      if (row === null) throw new Error('Result import reservation disappeared');

      if (row.status === 'RESERVED' && row.leaseUntil !== null && row.leaseUntil > input.now) return { kind: 'busy' as const };
      if (row.status !== 'FAILED' && row.status !== 'RESERVED') return { kind: 'busy' as const };
      if (row.reservedObjectKey !== null && row.reservedObjectKey !== undefined && row.reservedObjectKey !== input.objectKey) {
        await tx.assetCleanup.upsert({
          where: { objectKey: row.reservedObjectKey },
          create: { id: randomUUID(), objectKey: row.reservedObjectKey, reason: 'STALE_IMPORT_RESERVATION', scheduledAt: input.now },
          update: reactivateCleanup('STALE_IMPORT_RESERVATION', input.now),
        });
      }
      const changed = await tx.resultImport.updateMany({
        where: {
          id: row.id,
          OR: [
            { status: 'FAILED' },
            { status: 'RESERVED', OR: [{ leaseUntil: null }, { leaseUntil: { lte: input.now } }] },
          ],
        },
        data: {
          status: 'RESERVED', claimToken, leaseUntil, reservedObjectKey: input.objectKey, lastError: null, failedAt: null,
          attempts: { increment: 1 },
        },
      });
      return changed.count === 1 ? { kind: 'claimed' as const, claimToken } : { kind: 'busy' as const };
    });
  }

  async persistImported(input: Parameters<ResultImportRepository['persistImported']>[0]): Promise<{ kind: 'created'; eventId: string } | { kind: 'stale' } | ({ kind: 'duplicate' } & ImportedResult)> {
    return this.client.$transaction(async (tx) => {
      const importRow = await tx.resultImport.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { asset: true } });
      const imported = toImported(importRow);
      if (imported !== null) return { kind: 'duplicate' as const, ...imported };
      if (importRow?.status !== 'RESERVED' || importRow.claimToken !== input.claimToken) {
        const scheduledAt = this.now();
        await tx.assetCleanup.upsert({
          where: { objectKey: input.asset.objectKey },
          create: { id: randomUUID(), objectKey: input.asset.objectKey, reason: 'STALE_IMPORT_WRITE', scheduledAt },
          update: reactivateCleanup('STALE_IMPORT_WRITE', scheduledAt),
        });
        return { kind: 'stale' as const };
      }
      await tx.asset.create({ data: { id: input.asset.assetId, ownerId: input.asset.ownerId, kind: 'RESULT', status: 'AVAILABLE', objectKey: input.asset.objectKey, originalFileName: input.asset.originalFileName, mimeType: input.asset.mimeType, sizeBytes: input.asset.sizeBytes, checksum: input.asset.checksum ?? null, availableAt: new Date() } });
      const changed = await tx.resultImport.updateMany({ where: { id: importRow.id, status: 'RESERVED', claimToken: input.claimToken }, data: { assetId: input.asset.assetId, status: 'IMPORTED', importedAt: new Date(), claimToken: null, leaseUntil: null, reservedObjectKey: null } });
      if (changed.count !== 1) throw new Error('Result import reservation was lost');
      const eventId = randomUUID();
      await tx.outboxEvent.create({ data: { id: eventId, aggregateType: 'Asset', aggregateId: input.asset.assetId, eventType: 'asset.imported.v1', payload: { assetId: input.asset.assetId }, status: 'PENDING' } });
      return { kind: 'created' as const, eventId };
    });
  }

  async failAndScheduleCleanup(input: Parameters<ResultImportRepository['failAndScheduleCleanup']>[0]): Promise<void> {
    await this.client.$transaction(async (tx) => {
      await tx.resultImport.updateMany({
        where: { idempotencyKey: input.idempotencyKey, status: 'RESERVED', claimToken: input.claimToken },
        data: { status: 'FAILED', failedAt: input.failedAt, lastError: input.error, claimToken: null, leaseUntil: null },
      });
      await tx.assetCleanup.upsert({
        where: { objectKey: input.objectKey },
        create: { id: randomUUID(), objectKey: input.objectKey, reason: 'IMPORT_FAILED', scheduledAt: input.scheduledAt },
        update: reactivateCleanup('IMPORT_FAILED', input.scheduledAt),
      });
    });
  }

  async scheduleCleanup(input: Parameters<ResultImportRepository['scheduleCleanup']>[0]): Promise<void> {
    await this.client.$transaction((tx) => tx.assetCleanup.upsert({
      where: { objectKey: input.objectKey },
      create: { id: randomUUID(), objectKey: input.objectKey, reason: input.reason, scheduledAt: input.scheduledAt },
      update: reactivateCleanup(input.reason, input.scheduledAt),
    }));
  }
}

function reactivateCleanup(reason: string, scheduledAt: Date) {
  return { reason, scheduledAt, deletedAt: null, claimToken: null, leaseUntil: null, lastError: null };
}

function toImported(row: any): ImportedResult | null {
  return row?.status === 'IMPORTED' && row.asset !== null
    ? { assetId: row.asset.id, objectKey: row.asset.objectKey, status: 'AVAILABLE' as const }
    : null;
}
