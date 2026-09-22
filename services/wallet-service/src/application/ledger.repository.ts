import type { EntryDraft } from '../domain/ledger.js';

export type LedgerOperation =
  'CREDIT' | 'RESERVE' | 'SETTLE' | 'RELEASE' | 'ADJUST' | 'REPAIR' | 'REFUND';

export interface LedgerPostCommand {
  businessKey: string;
  kind: LedgerOperation;
  userId: string;
  points: bigint;
  traceId: string;
  reason?: string;
  entries: readonly EntryDraft[];
}

export interface PostedLedgerTransaction {
  transactionId: string;
  businessKey: string;
  kind: LedgerOperation;
  userId: string;
  points: bigint;
  traceId: string;
  createdAt: Date;
}

export interface WalletBalance {
  userId: string;
  available: bigint;
  frozen: bigint;
}

export interface LedgerRepository {
  post(command: LedgerPostCommand): Promise<PostedLedgerTransaction>;
  getBalance(userId: string): Promise<WalletBalance>;
  listTransactions(userId: string): Promise<readonly PostedLedgerTransaction[]>;
}
