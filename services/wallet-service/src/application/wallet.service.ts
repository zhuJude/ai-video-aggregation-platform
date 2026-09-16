import {
  adjustmentEntries,
  creditEntries,
  releaseEntries,
  reserveEntries,
  settleEntries,
  type EntryDraft,
} from '../domain/ledger.js';
import type {
  LedgerOperation,
  LedgerRepository,
  PostedLedgerTransaction,
  WalletBalance,
} from './ledger.repository.js';

export interface WalletCommand {
  businessKey: string;
  userId: string;
  points: bigint;
  traceId: string;
  reason?: string;
}

type EntryFactory = (userId: string, points: bigint) => EntryDraft[];

export class WalletService {
  constructor(private readonly repository: LedgerRepository) {}

  credit(command: WalletCommand): Promise<PostedLedgerTransaction> {
    return this.post('CREDIT', creditEntries, command);
  }

  reserve(command: WalletCommand): Promise<PostedLedgerTransaction> {
    return this.post('RESERVE', reserveEntries, command);
  }

  settle(command: WalletCommand): Promise<PostedLedgerTransaction> {
    return this.post('SETTLE', settleEntries, command);
  }

  release(command: WalletCommand): Promise<PostedLedgerTransaction> {
    return this.post('RELEASE', releaseEntries, command);
  }

  adjust(command: WalletCommand): Promise<PostedLedgerTransaction> {
    return this.post('ADJUST', adjustmentEntries, command);
  }

  getBalance(userId: string): Promise<WalletBalance> {
    return this.repository.getBalance(userId);
  }

  listTransactions(userId: string): Promise<readonly PostedLedgerTransaction[]> {
    return this.repository.listTransactions(userId);
  }

  private post(
    kind: LedgerOperation,
    createEntries: EntryFactory,
    command: WalletCommand,
  ): Promise<PostedLedgerTransaction> {
    return this.repository.post({
      ...command,
      kind,
      entries: createEntries(command.userId, command.points),
    });
  }
}
