import type { AccountKind } from '../domain/ledger.js';

export interface ReconciliationMismatch {
  accountId: string;
  userId: string;
  account: AccountKind;
  expected: bigint;
  actual: bigint;
}

export interface ReconciliationReport {
  runId: string;
  mismatches: readonly ReconciliationMismatch[];
}

export type AdjustmentDirection = 'CREDIT' | 'DEBIT';
export type AdjustmentStatus = 'PENDING' | 'POSTED' | 'REJECTED';

export interface AdjustmentRequestRecord {
  id: string;
  userId: string;
  direction: AdjustmentDirection;
  points: bigint;
  requestedBy: string;
  reason: string;
  traceId: string;
  status: AdjustmentStatus;
  approvals: readonly string[];
  transactionId?: string;
}

export interface FinancialControlRepository {
  findReconciliationMismatches(): Promise<readonly ReconciliationMismatch[]>;
  recordReconciliation(
    traceId: string,
    mismatches: readonly ReconciliationMismatch[],
  ): Promise<ReconciliationReport>;
  createAdjustment(
    request: Omit<AdjustmentRequestRecord, 'id' | 'status' | 'approvals' | 'transactionId'>,
  ): Promise<AdjustmentRequestRecord>;
  getAdjustment(id: string): Promise<AdjustmentRequestRecord | undefined>;
  addAdjustmentApproval(id: string, adminId: string): Promise<AdjustmentRequestRecord>;
  markAdjustmentPosted(id: string, transactionId: string): Promise<AdjustmentRequestRecord>;
}
