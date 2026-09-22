import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WalletService } from '../src/application/wallet.service.js';
import { AdjustmentService } from '../src/application/adjustment.service.js';
import { ReconciliationJob } from '../src/application/reconciliation.job.js';
import { PrismaFinancialControlRepository } from '../src/infrastructure/prisma-financial-control.repository.js';
import { PrismaLedgerRepository } from '../src/infrastructure/prisma-ledger.repository.js';

const userId = '0198f5f6-b5c9-7d33-a4a5-608b27b9d776';
const serviceRoot = fileURLToPath(new URL('../', import.meta.url));

function docker(...args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  }).trim();
}

async function waitForPostgres(containerId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      docker('exec', containerId, 'pg_isready', '-U', 'postgres', '-d', 'wallet');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('POSTGRES_TEST_CONTAINER_NOT_READY');
}

describe('WalletService PostgreSQL concurrency', { concurrent: false }, () => {
  let containerId: string;
  let prisma: PrismaClient;
  let disconnectPrisma: (() => Promise<void>) | undefined;
  let service: WalletService;
  let controls: PrismaFinancialControlRepository;

  beforeAll(async () => {
    containerId = docker(
      'run',
      '--detach',
      '--rm',
      '--env',
      'POSTGRES_PASSWORD=postgres',
      '--env',
      'POSTGRES_DB=wallet',
      '--publish',
      '127.0.0.1::5432',
      'postgres:17-alpine',
    );
    await waitForPostgres(containerId);
    const published = docker('port', containerId, '5432/tcp');
    const port = published.slice(published.lastIndexOf(':') + 1);
    const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/wallet`;
    const pnpmCli = process.env.npm_execpath;
    if (!pnpmCli) throw new Error('PNPM_CLI_PATH_MISSING');
    execFileSync(process.execPath, [pnpmCli, 'exec', 'prisma', 'migrate', 'deploy'], {
      cwd: serviceRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    disconnectPrisma = () => prisma.$disconnect();
    service = new WalletService(
      new PrismaLedgerRepository(prisma, { jitter: () => Promise.resolve() }),
    );
    controls = new PrismaFinancialControlRepository(prisma);
  }, 120_000);

  afterAll(async () => {
    await disconnectPrisma?.();
    if (containerId) docker('stop', containerId);
  });

  it('serializes competing reservations and keeps every transaction balanced', async () => {
    await service.credit({
      businessKey: 'postgres:seed:credit',
      userId,
      points: 100n,
      traceId: 'trace-postgres-seed',
    });

    const results = await Promise.allSettled([
      service.reserve({
        businessKey: 'postgres:a:reserve',
        userId,
        points: 80n,
        traceId: 'trace-postgres-a',
      }),
      service.reserve({
        businessKey: 'postgres:b:reserve',
        userId,
        points: 80n,
        traceId: 'trace-postgres-b',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(service.getBalance(userId)).resolves.toMatchObject({
      available: 20n,
      frozen: 80n,
    });

    const transactions = await prisma.ledgerTransaction.findMany({ include: { entries: true } });
    expect(transactions).toHaveLength(2);
    for (const transaction of transactions) {
      expect(transaction.entries.reduce((total, entry) => total + entry.delta, 0n)).toBe(0n);
    }
  });

  it('returns the committed transaction for a repeated business key', async () => {
    const command = {
      businessKey: 'postgres:idempotent:reserve',
      userId,
      points: 10n,
      traceId: 'trace-postgres-idempotent',
    };

    const [first, second] = await Promise.all([service.reserve(command), service.reserve(command)]);

    expect(second.transactionId).toBe(first.transactionId);
    await expect(
      prisma.ledgerTransaction.count({ where: { businessKey: command.businessKey } }),
    ).resolves.toBe(1);
  });

  it('rejects update and delete mutations against ledger facts', async () => {
    await expect(
      prisma.$executeRaw`UPDATE "LedgerTransaction" SET "reason" = 'tampered' WHERE "businessKey" = 'postgres:seed:credit'`,
    ).rejects.toThrow(/LEDGER_FACTS_ARE_IMMUTABLE/);
    await expect(
      prisma.$executeRaw`DELETE FROM "LedgerEntry" WHERE "transactionId" IN (SELECT "id" FROM "LedgerTransaction" LIMIT 1)`,
    ).rejects.toThrow(/LEDGER_FACTS_ARE_IMMUTABLE/);
  });

  it('persists mismatches, P0 events and blocks affected wallets', async () => {
    const available = await prisma.walletAccount.findUniqueOrThrow({
      where: { ownerId_kind: { ownerId: userId, kind: 'USER_AVAILABLE' } },
    });
    await prisma.balanceSnapshot.update({
      where: { accountId: available.id },
      data: { balance: 999n },
    });

    const report = await new ReconciliationJob(controls).run('trace-postgres-reconciliation');

    expect(report.mismatches).toContainEqual(
      expect.objectContaining({ userId, account: 'USER_AVAILABLE', expected: 10n, actual: 999n }),
    );
    await expect(
      prisma.outboxEvent.count({ where: { eventType: 'wallet.ledger-mismatch.v1' } }),
    ).resolves.toBe(1);
    await expect(
      service.reserve({
        businessKey: 'postgres:blocked:reserve',
        userId,
        points: 1n,
        traceId: 'trace-postgres-blocked',
      }),
    ).rejects.toMatchObject({ code: 'WALLET_BLOCKED' });
  });

  it('posts a single adjustment after two persisted approvals', async () => {
    const adjustments = new AdjustmentService(controls, service, { canApprove: () => true });
    const request = await adjustments.request({
      userId,
      direction: 'CREDIT',
      points: 5n,
      requestedBy: 'admin-requester',
      reason: 'approved repair',
      traceId: 'trace-postgres-adjustment',
    });

    await adjustments.approve(request.id, 'admin-a', 'trace-postgres-approval-a');
    const posted = await adjustments.approve(request.id, 'admin-b', 'trace-postgres-approval-b');
    const duplicate = await adjustments.approve(
      request.id,
      'admin-b',
      'trace-postgres-approval-b-duplicate',
    );

    expect(posted.status).toBe('POSTED');
    expect(duplicate.transactionId).toBe(posted.transactionId);
    await expect(
      prisma.ledgerTransaction.count({
        where: { businessKey: `adjustment:${request.id}:apply` },
      }),
    ).resolves.toBe(1);
  });
});
