/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Prisma's generated client is structurally injected so this service can be tested without a generated-client singleton. */
import {
  SupportUploadError,
  type InternalAssetRepository,
  type SupportUploadMutationInput,
  type SupportUploadOutcome,
  type SupportUploadReservation,
  type SupportUploadReserveInput,
} from '../application/support-upload.service.js';

export class PrismaInternalAssetRepository implements InternalAssetRepository {
  constructor(
    private readonly client: { $transaction<T>(work: (tx: any) => Promise<T>): Promise<T> },
  ) {}

  findAvailableAsset(assetId: string): Promise<{ id: string; ownerId: string } | null> {
    return this.client.$transaction((tx) =>
      tx.asset.findFirst({
        where: { id: assetId, status: 'AVAILABLE' },
        select: { id: true, ownerId: true },
      }),
    );
  }

  reserve(
    input: SupportUploadReserveInput & { id: string; ownershipToken: string; now: Date },
  ): Promise<SupportUploadOutcome> {
    return this.client.$transaction(async (tx) => {
      const existing = await tx.supportUploadReservation.findUnique({
        where: { remoteOperationId: input.remoteOperationId },
      });
      if (existing !== null) {
        if (!same(existing, input)) throw new SupportUploadError('RESERVATION_CONFLICT');
        return { outcome: 'RESERVED', reservation: toReservation(existing) } as const;
      }
      const session = await tx.uploadSession.findUnique({
        where: { id: input.sessionId },
        include: { asset: true },
      });
      if (
        session === null ||
        session.assetId !== input.assetId ||
        session.ownerId !== input.ownerId ||
        session.asset?.status !== 'AVAILABLE'
      )
        return { outcome: 'NOT_FOUND' } as const;
      if (
        session.status === 'EXPIRED' ||
        (session.status === 'PENDING' && session.expiresAt.getTime() <= input.now.getTime())
      )
        return { outcome: 'EXPIRED' } as const;
      if (session.status !== 'COMPLETED') return { outcome: 'USED' } as const;
      const created = await tx.supportUploadReservation.create({
        data: {
          id: input.id,
          operationId: input.operationId,
          remoteOperationId: input.remoteOperationId,
          generation: input.generation,
          fence: input.fence,
          requestHash: input.requestHash,
          idempotencyKey: input.idempotencyKey,
          ownershipToken: input.ownershipToken,
          sessionId: input.sessionId,
          assetId: input.assetId,
          ownerId: input.ownerId,
          purpose: input.purpose,
          status: 'RESERVED',
          expiresAt: new Date(input.now.getTime() + 15 * 60_000),
        },
      });
      return { outcome: 'RESERVED', reservation: toReservation(created) } as const;
    });
  }

  finalize(input: SupportUploadMutationInput): Promise<boolean> {
    return this.mutate(input, 'FINALIZED');
  }
  release(input: SupportUploadMutationInput): Promise<boolean> {
    return this.mutate(input, 'RELEASED');
  }

  lookup(remoteOperationId: string): Promise<SupportUploadReservation | null> {
    return this.client.$transaction(async (tx) => {
      const row = await tx.supportUploadReservation.findUnique({ where: { remoteOperationId } });
      return row === null ? null : toReservation(row);
    });
  }

  private mutate(
    input: SupportUploadMutationInput,
    status: 'FINALIZED' | 'RELEASED',
  ): Promise<boolean> {
    return this.client.$transaction(async (tx) => {
      const row = await tx.supportUploadReservation.findUnique({
        where: { remoteOperationId: input.remoteOperationId },
      });
      if (row === null || !same(row, input)) return false;
      if (row.status === status) return true;
      if (status === 'FINALIZED' && row.status !== 'RESERVED') return false;
      if (status === 'RELEASED' && row.status === 'RELEASED') return true;
      return (
        (
          await tx.supportUploadReservation.updateMany({
            where: { id: row.id, status: row.status },
            data: { status },
          })
        ).count === 1
      );
    });
  }
}

function same(row: any, input: any): boolean {
  return (
    row.operationId === input.operationId &&
    row.remoteOperationId === input.remoteOperationId &&
    row.generation === input.generation &&
    row.fence === input.fence &&
    row.requestHash === input.requestHash &&
    (input.ownershipToken === undefined || row.ownershipToken === input.ownershipToken)
  );
}
function toReservation(row: any): SupportUploadReservation {
  return {
    id: row.id,
    operationId: row.operationId,
    remoteOperationId: row.remoteOperationId,
    generation: row.generation,
    fence: row.fence,
    requestHash: row.requestHash,
    ownershipToken: row.ownershipToken,
    sessionId: row.sessionId,
    assetId: row.assetId,
    ownerId: row.ownerId,
    purpose: 'SUPPORT_TICKET',
    expiresAt: row.expiresAt,
  };
}
