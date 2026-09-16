import { Prisma, type LedgerTransaction, type PrismaClient } from '@prisma/client';
import {
  type LedgerPostCommand,
  type LedgerRepository,
  type PostedLedgerTransaction,
  type WalletBalance,
} from '../application/ledger.repository.js';
import { assertBalanced, type AccountKind } from '../domain/ledger.js';
import { uuidV7 } from '../domain/uuid-v7.js';

interface RetryOptions {
  jitter?: (attempt: number) => Promise<void>;
}

function domainError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function commandFingerprint(command: LedgerPostCommand): string {
  return [command.kind, command.userId, command.points.toString(), command.reason ?? ''].join('|');
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function isSerializationFailure(error: unknown): boolean {
  if (isPrismaCode(error, 'P2034')) return true;
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') {
    return false;
  }
  const meta = error.meta as
    { driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  const databaseCode = meta?.driverAdapterError?.cause?.originalCode;
  return databaseCode === '40001' || databaseCode === '40P01';
}

function toPosted(transaction: LedgerTransaction): PostedLedgerTransaction {
  if (!transaction.userId) throw domainError('LEDGER_TRANSACTION_MISSING_USER');
  return {
    transactionId: transaction.id,
    businessKey: transaction.businessKey,
    kind: transaction.kind,
    userId: transaction.userId,
    points: transaction.points,
    traceId: transaction.traceId,
    createdAt: transaction.createdAt,
  };
}

function ensureSameCommand(
  transaction: LedgerTransaction,
  command: LedgerPostCommand,
): PostedLedgerTransaction {
  if (transaction.commandFingerprint !== commandFingerprint(command)) {
    throw domainError('IDEMPOTENCY_CONFLICT');
  }
  return toPosted(transaction);
}

function accountKey(account: AccountKind, ownerId: string): string {
  return `${account}:${ownerId}`;
}

async function defaultJitter(attempt: number): Promise<void> {
  const delay = Math.floor(Math.random() * 10) + attempt * 5;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

export class PrismaLedgerRepository implements LedgerRepository {
  private readonly jitter: (attempt: number) => Promise<void>;

  constructor(
    private readonly prisma: PrismaClient,
    options: RetryOptions = {},
  ) {
    this.jitter = options.jitter ?? defaultJitter;
  }

  async post(command: LedgerPostCommand): Promise<PostedLedgerTransaction> {
    assertBalanced(command.entries);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction((tx) => this.postInTransaction(tx, command), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (isPrismaCode(error, 'P2002')) {
          const existing = await this.prisma.ledgerTransaction.findUnique({
            where: { businessKey: command.businessKey },
          });
          if (existing) return ensureSameCommand(existing, command);
        }
        if (isSerializationFailure(error) && attempt < 3) {
          await this.jitter(attempt);
          continue;
        }
        throw error;
      }
    }
    throw domainError('SERIALIZABLE_RETRY_EXHAUSTED');
  }

  async getBalance(userId: string): Promise<WalletBalance> {
    const accounts = await this.prisma.walletAccount.findMany({
      where: { ownerId: userId, kind: { in: ['USER_AVAILABLE', 'USER_FROZEN'] } },
      include: { snapshot: true },
    });
    return {
      userId,
      available:
        accounts.find((account) => account.kind === 'USER_AVAILABLE')?.snapshot?.balance ?? 0n,
      frozen: accounts.find((account) => account.kind === 'USER_FROZEN')?.snapshot?.balance ?? 0n,
    };
  }

  async listTransactions(userId: string): Promise<readonly PostedLedgerTransaction[]> {
    const transactions = await this.prisma.ledgerTransaction.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return transactions.map(toPosted);
  }

  private async postInTransaction(
    tx: Prisma.TransactionClient,
    command: LedgerPostCommand,
  ): Promise<PostedLedgerTransaction> {
    const existing = await tx.ledgerTransaction.findUnique({
      where: { businessKey: command.businessKey },
    });
    if (existing) return ensureSameCommand(existing, command);

    const uniqueAccounts = [
      ...new Map(
        command.entries.map((entry) => [accountKey(entry.account, entry.ownerId), entry]),
      ).values(),
    ].sort((left, right) =>
      accountKey(left.account, left.ownerId).localeCompare(
        accountKey(right.account, right.ownerId),
      ),
    );

    for (const entry of uniqueAccounts) {
      await tx.walletAccount.upsert({
        where: { ownerId_kind: { ownerId: entry.ownerId, kind: entry.account } },
        create: { id: uuidV7(), ownerId: entry.ownerId, kind: entry.account },
        update: {},
      });
    }

    const accounts = await tx.walletAccount.findMany({
      where: {
        OR: uniqueAccounts.map((entry) => ({ ownerId: entry.ownerId, kind: entry.account })),
      },
    });
    const accountIds = accounts.map((account) => account.id).sort();
    for (const accountId of accountIds) {
      await tx.balanceSnapshot.upsert({
        where: { accountId },
        create: { accountId, balance: 0n },
        update: {},
      });
    }
    await tx.$queryRaw(
      Prisma.sql`SELECT "accountId" FROM "BalanceSnapshot" WHERE "accountId" IN (${Prisma.join(accountIds)}) ORDER BY "accountId" FOR UPDATE`,
    );

    const snapshots = await tx.balanceSnapshot.findMany({
      where: { accountId: { in: accountIds } },
    });
    const nextBalances = new Map(
      snapshots.map((snapshot) => [snapshot.accountId, snapshot.balance]),
    );
    const accountsByKey = new Map(
      accounts.map((account) => [accountKey(account.kind, account.ownerId), account]),
    );
    for (const entry of command.entries) {
      const account = accountsByKey.get(accountKey(entry.account, entry.ownerId));
      if (!account) throw domainError('LEDGER_ACCOUNT_NOT_FOUND');
      const next = (nextBalances.get(account.id) ?? 0n) + entry.delta;
      if (account.kind === 'USER_AVAILABLE' && next < 0n) {
        throw domainError('INSUFFICIENT_AVAILABLE_POINTS');
      }
      if (account.kind === 'USER_FROZEN' && next < 0n) {
        throw domainError('INSUFFICIENT_FROZEN_POINTS');
      }
      nextBalances.set(account.id, next);
    }

    const transactionId = uuidV7();
    const transaction = await tx.ledgerTransaction.create({
      data: {
        id: transactionId,
        businessKey: command.businessKey,
        commandFingerprint: commandFingerprint(command),
        kind: command.kind,
        userId: command.userId,
        points: command.points,
        traceId: command.traceId,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
        entries: {
          create: command.entries.map((entry) => {
            const account = accountsByKey.get(accountKey(entry.account, entry.ownerId));
            if (!account) throw domainError('LEDGER_ACCOUNT_NOT_FOUND');
            return { id: uuidV7(), accountId: account.id, delta: entry.delta };
          }),
        },
      },
    });

    for (const [accountId, balance] of nextBalances) {
      await tx.balanceSnapshot.update({
        where: { accountId },
        data: { balance, version: { increment: 1n } },
      });
    }
    await tx.outboxEvent.create({
      data: {
        id: uuidV7(),
        aggregateType: 'wallet',
        aggregateId: command.userId,
        eventType: 'wallet.transaction-posted.v1',
        traceId: command.traceId,
        payload: {
          transactionId,
          businessKey: command.businessKey,
          kind: command.kind,
          userId: command.userId,
          points: command.points.toString(),
        },
      },
    });
    return toPosted(transaction);
  }
}
