import { type AdjustmentApproval, type AdjustmentRequest, type PrismaClient } from '@prisma/client';
import type {
  AdjustmentRequestRecord,
  FinancialControlRepository,
  ReconciliationMismatch,
  ReconciliationReport,
} from '../application/financial-control.repository.js';
import { uuidV7 } from '../domain/uuid-v7.js';

type AdjustmentWithApprovals = AdjustmentRequest & { approvals: AdjustmentApproval[] };

function domainError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function toAdjustment(request: AdjustmentWithApprovals): AdjustmentRequestRecord {
  return {
    id: request.id,
    userId: request.userId,
    direction: request.direction,
    points: request.points,
    requestedBy: request.requestedBy,
    reason: request.reason,
    traceId: request.traceId,
    status: request.status,
    approvals: request.approvals.map((approval) => approval.adminId),
    ...(request.postedTransactionId === null ? {} : { transactionId: request.postedTransactionId }),
  };
}

export class PrismaFinancialControlRepository implements FinancialControlRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findReconciliationMismatches(): Promise<readonly ReconciliationMismatch[]> {
    const accounts = await this.prisma.walletAccount.findMany({
      include: { snapshot: true, entries: { select: { delta: true } } },
    });
    const mismatches: ReconciliationMismatch[] = [];
    for (const account of accounts) {
      const expected = account.entries.reduce((total, entry) => total + entry.delta, 0n);
      const actual = account.snapshot?.balance ?? 0n;
      if (expected !== actual) {
        mismatches.push({
          accountId: account.id,
          userId: account.ownerId,
          account: account.kind,
          expected,
          actual,
        });
      }
    }
    return mismatches;
  }

  async recordReconciliation(
    traceId: string,
    mismatches: readonly ReconciliationMismatch[],
  ): Promise<ReconciliationReport> {
    const runId = uuidV7();
    await this.prisma.$transaction(async (tx) => {
      await tx.reconciliationRun.create({
        data: {
          id: runId,
          status: mismatches.length === 0 ? 'MATCHED' : 'MISMATCHED',
          completedAt: new Date(),
          mismatchCount: mismatches.length,
          summary: {
            mismatches: mismatches.map((mismatch) => ({
              accountId: mismatch.accountId,
              userId: mismatch.userId,
              account: mismatch.account,
              expected: mismatch.expected.toString(),
              actual: mismatch.actual.toString(),
            })),
          },
        },
      });
      for (const mismatch of mismatches) {
        await tx.reconciliationMismatch.create({
          data: { id: uuidV7(), runId, ...mismatch },
        });
        const blockedUserId = mismatch.userId === 'platform' ? '*' : mismatch.userId;
        await tx.walletRestriction.upsert({
          where: { userId: blockedUserId },
          create: {
            userId: blockedUserId,
            reconciliationRunId: runId,
            reason: 'LEDGER_MISMATCH',
          },
          update: {
            reconciliationRunId: runId,
            reason: 'LEDGER_MISMATCH',
            blockedAt: new Date(),
            unblockedAt: null,
          },
        });
      }
      if (mismatches.length > 0) {
        await tx.outboxEvent.create({
          data: {
            id: uuidV7(),
            aggregateType: 'wallet-reconciliation',
            aggregateId: runId,
            eventType: 'wallet.ledger-mismatch.v1',
            traceId,
            payload: {
              severity: 'P0',
              runId,
              mismatchCount: mismatches.length,
            },
          },
        });
      }
    });
    return { runId, mismatches: [...mismatches] };
  }

  async createAdjustment(
    request: Omit<AdjustmentRequestRecord, 'id' | 'status' | 'approvals' | 'transactionId'>,
  ): Promise<AdjustmentRequestRecord> {
    const created = await this.prisma.adjustmentRequest.create({
      data: { id: uuidV7(), ...request },
      include: { approvals: true },
    });
    return toAdjustment(created);
  }

  async getAdjustment(id: string): Promise<AdjustmentRequestRecord | undefined> {
    const request = await this.prisma.adjustmentRequest.findUnique({
      where: { id },
      include: { approvals: { orderBy: { approvedAt: 'asc' } } },
    });
    return request ? toAdjustment(request) : undefined;
  }

  async addAdjustmentApproval(id: string, adminId: string): Promise<AdjustmentRequestRecord> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.adjustmentRequest.findUnique({ where: { id } });
      if (!existing) throw domainError('ADJUSTMENT_NOT_FOUND');
      await tx.adjustmentApproval.upsert({
        where: { requestId_adminId: { requestId: id, adminId } },
        create: { requestId: id, adminId },
        update: {},
      });
      return toAdjustment(
        await tx.adjustmentRequest.findUniqueOrThrow({
          where: { id },
          include: { approvals: { orderBy: { approvedAt: 'asc' } } },
        }),
      );
    });
  }

  async markAdjustmentPosted(id: string, transactionId: string): Promise<AdjustmentRequestRecord> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.adjustmentRequest.findUniqueOrThrow({ where: { id } });
      if (existing.postedTransactionId && existing.postedTransactionId !== transactionId) {
        throw domainError('ADJUSTMENT_TRANSACTION_CONFLICT');
      }
      const updated = await tx.adjustmentRequest.update({
        where: { id },
        data: { status: 'POSTED', postedTransactionId: transactionId, completedAt: new Date() },
        include: { approvals: { orderBy: { approvedAt: 'asc' } } },
      });
      await tx.outboxEvent.create({
        data: {
          id: uuidV7(),
          aggregateType: 'adjustment',
          aggregateId: id,
          eventType: 'wallet.adjustment-posted.v1',
          traceId: updated.traceId,
          payload: {
            adjustmentId: id,
            transactionId,
            userId: updated.userId,
            points: updated.points.toString(),
            direction: updated.direction,
          },
        },
      });
      return toAdjustment(updated);
    });
  }
}
