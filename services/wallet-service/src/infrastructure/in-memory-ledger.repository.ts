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

function domainError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function accountKey(account: AccountKind, ownerId: string): string {
  return `${account}:${ownerId}`;
}

function fingerprint(command: LedgerPostCommand): string {
  return [command.kind, command.userId, command.points.toString(), command.reason ?? ''].join('|');
}

export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly balances = new Map<string, bigint>();
  private readonly transactions = new Map<string, StoredTransaction>();
  private readonly userTransactionKeys = new Map<string, string[]>();
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
