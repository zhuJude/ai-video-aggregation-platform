import {
  type AdjustmentRequestRecord,
  type FinancialControlRepository,
  type ReconciliationMismatch,
  type ReconciliationReport,
} from '../application/financial-control.repository.js';
import {
  type LedgerPostCommand,
  type LedgerRepository,
  type PostedLedgerTransaction,
  type WalletBalance,
} from '../application/ledger.repository.js';
import { assertBalanced, type AccountKind } from '../domain/ledger.js';
import { uuidV7 } from '../domain/uuid-v7.js';

interface StoredTransaction extends PostedLedgerTransaction {
  fingerprint: string;
}

interface StoredAdjustment extends Omit<AdjustmentRequestRecord, 'approvals'> {
  approvals: Set<string>;
}

interface InMemoryOutboxEvent {
  eventType: string;
  severity: 'P0';
  traceId: string;
}

function domainError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function accountKey(account: AccountKind, ownerId: string): string {
  return `${account}:${ownerId}`;
}

function fingerprint(command: LedgerPostCommand): string {
  return [command.kind, command.userId, command.points.toString(), command.reason ?? ''].join('|');
}

function adjustmentRecord(adjustment: StoredAdjustment): AdjustmentRequestRecord {
  return { ...adjustment, approvals: [...adjustment.approvals] };
}

export class InMemoryLedgerRepository implements LedgerRepository, FinancialControlRepository {
  private readonly balances = new Map<string, bigint>();
  private readonly ledgerBalances = new Map<string, bigint>();
  private readonly transactions = new Map<string, StoredTransaction>();
  private readonly userTransactionKeys = new Map<string, string[]>();
  private readonly blockedUsers = new Set<string>();
  private readonly events: InMemoryOutboxEvent[] = [];
  private readonly adjustments = new Map<string, StoredAdjustment>();
  private tail: Promise<void> = Promise.resolve();

  post(command: LedgerPostCommand): Promise<PostedLedgerTransaction> {
    return this.exclusive(() => {
      const commandFingerprint = fingerprint(command);
      const existing = this.transactions.get(command.businessKey);
      if (existing) {
        if (existing.fingerprint !== commandFingerprint) {
          throw domainError('IDEMPOTENCY_CONFLICT');
        }
        return existing;
      }
      if (
        (this.blockedUsers.has(command.userId) || this.blockedUsers.has('*')) &&
        command.kind !== 'ADJUST' &&
        command.kind !== 'REPAIR'
      ) {
        throw domainError('WALLET_BLOCKED');
      }

      assertBalanced(command.entries);
      const nextBalances = new Map(this.balances);
      for (const entry of command.entries) {
        const key = accountKey(entry.account, entry.ownerId);
        const next = (nextBalances.get(key) ?? 0n) + entry.delta;
        if (entry.account === 'USER_AVAILABLE' && next < 0n) {
          throw domainError('INSUFFICIENT_AVAILABLE_POINTS');
        }
        if (entry.account === 'USER_FROZEN' && next < 0n) {
          throw domainError('INSUFFICIENT_FROZEN_POINTS');
        }
        nextBalances.set(key, next);
      }

      this.balances.clear();
      for (const [key, balance] of nextBalances) this.balances.set(key, balance);
      for (const entry of command.entries) {
        const key = accountKey(entry.account, entry.ownerId);
        this.ledgerBalances.set(key, (this.ledgerBalances.get(key) ?? 0n) + entry.delta);
      }

      const transaction: StoredTransaction = {
        transactionId: uuidV7(),
        businessKey: command.businessKey,
        kind: command.kind,
        userId: command.userId,
        points: command.points,
        traceId: command.traceId,
        createdAt: new Date(),
        fingerprint: commandFingerprint,
      };
      this.transactions.set(command.businessKey, transaction);
      const keys = this.userTransactionKeys.get(command.userId) ?? [];
      keys.push(command.businessKey);
      this.userTransactionKeys.set(command.userId, keys);
      return transaction;
    });
  }

  async getBalance(userId: string): Promise<WalletBalance> {
    await this.tail;
    return {
      userId,
      available: this.balances.get(accountKey('USER_AVAILABLE', userId)) ?? 0n,
      frozen: this.balances.get(accountKey('USER_FROZEN', userId)) ?? 0n,
    };
  }

  async listTransactions(userId: string): Promise<readonly PostedLedgerTransaction[]> {
    await this.tail;
    return (this.userTransactionKeys.get(userId) ?? []).map((key) => {
      const transaction = this.transactions.get(key);
      if (!transaction) throw domainError('LEDGER_TRANSACTION_NOT_FOUND');
      return transaction;
    });
  }

  corruptSnapshot(userId: string, account: AccountKind, balance: bigint): void {
    this.balances.set(accountKey(account, userId), balance);
  }

  outboxEvents(): readonly InMemoryOutboxEvent[] {
    return [...this.events];
  }

  findReconciliationMismatches(): Promise<readonly ReconciliationMismatch[]> {
    return this.exclusive(() => {
      const keys = new Set([...this.ledgerBalances.keys(), ...this.balances.keys()]);
      const mismatches: ReconciliationMismatch[] = [];
      for (const key of keys) {
        const separator = key.indexOf(':');
        const account = key.slice(0, separator) as AccountKind;
        const userId = key.slice(separator + 1);
        const expected = this.ledgerBalances.get(key) ?? 0n;
        const actual = this.balances.get(key) ?? 0n;
        if (expected !== actual) {
          mismatches.push({ accountId: key, userId, account, expected, actual });
        }
      }
      return mismatches;
    });
  }

  recordReconciliation(
    traceId: string,
    mismatches: readonly ReconciliationMismatch[],
  ): Promise<ReconciliationReport> {
    return this.exclusive(() => {
      const runId = uuidV7();
      if (mismatches.length > 0) {
        for (const mismatch of mismatches) {
          this.blockedUsers.add(mismatch.userId === 'platform' ? '*' : mismatch.userId);
        }
        this.events.push({ eventType: 'wallet.ledger-mismatch.v1', severity: 'P0', traceId });
      }
      return { runId, mismatches: [...mismatches] };
    });
  }

  createAdjustment(
    request: Omit<AdjustmentRequestRecord, 'id' | 'status' | 'approvals' | 'transactionId'>,
  ): Promise<AdjustmentRequestRecord> {
    return this.exclusive(() => {
      const adjustment: StoredAdjustment = {
        ...request,
        id: uuidV7(),
        status: 'PENDING',
        approvals: new Set(),
      };
      this.adjustments.set(adjustment.id, adjustment);
      return adjustmentRecord(adjustment);
    });
  }

  getAdjustment(id: string): Promise<AdjustmentRequestRecord | undefined> {
    return this.exclusive(() => {
      const adjustment = this.adjustments.get(id);
      return adjustment ? adjustmentRecord(adjustment) : undefined;
    });
  }

  addAdjustmentApproval(id: string, adminId: string): Promise<AdjustmentRequestRecord> {
    return this.exclusive(() => {
      const adjustment = this.adjustments.get(id);
      if (!adjustment) throw domainError('ADJUSTMENT_NOT_FOUND');
      adjustment.approvals.add(adminId);
      return adjustmentRecord(adjustment);
    });
  }

  markAdjustmentPosted(id: string, transactionId: string): Promise<AdjustmentRequestRecord> {
    return this.exclusive(() => {
      const adjustment = this.adjustments.get(id);
      if (!adjustment) throw domainError('ADJUSTMENT_NOT_FOUND');
      if (adjustment.transactionId && adjustment.transactionId !== transactionId) {
        throw domainError('ADJUSTMENT_TRANSACTION_CONFLICT');
      }
      adjustment.status = 'POSTED';
      adjustment.transactionId = transactionId;
      return adjustmentRecord(adjustment);
    });
  }

  private async exclusive<T>(operation: () => T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }
}
