import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { FakePaymentGateway } from '../src/adapters/fake-payment.gateway.js';
import { OrderService } from '../src/application/order.service.js';
import { PrismaPaymentRepository } from '../src/infrastructure/prisma-payment.repository.js';

const serviceRoot = fileURLToPath(new URL('../', import.meta.url));
const userId = '0198f5f6-b5c9-7d33-a4a5-608b27b9d776';

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

async function waitForPostgres(containerId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      docker('exec', containerId, 'pg_isready', '-U', 'postgres', '-d', 'payment');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('POSTGRES_TEST_CONTAINER_NOT_READY');
}

describe('payment PostgreSQL persistence', { concurrent: false }, () => {
  let containerId: string;
  let prisma: PrismaClient;
  let service: OrderService;

  beforeAll(async () => {
    containerId = docker(
      'run',
      '--detach',
      '--rm',
      '--env',
      'POSTGRES_PASSWORD=postgres',
      '--env',
      'POSTGRES_DB=payment',
      '--publish',
      '127.0.0.1::5432',
      'postgres:17-alpine',
    );
    await waitForPostgres(containerId);
    const published = docker('port', containerId, '5432/tcp');
    const port = published.slice(published.lastIndexOf(':') + 1);
    const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/payment`;
    const pnpmCli = process.env.npm_execpath;
    if (!pnpmCli) throw new Error('PNPM_CLI_PATH_MISSING');
    execFileSync(process.execPath, [pnpmCli, 'exec', 'prisma', 'migrate', 'deploy'], {
      cwd: serviceRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    service = new OrderService(
      new PrismaPaymentRepository(prisma, {
        findPackage: () =>
          Promise.resolve({
            id: 'pkg-database',
            title: '数据库套餐',
            amountMinor: 2_000n,
            points: 20_000n,
            currency: 'CNY',
            active: true,
          }),
      }),
      new FakePaymentGateway(),
    );
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    docker('stop', containerId);
  });

  it('atomically persists immutable package amount and point snapshots', async () => {
    const order = await service.create({
      userId,
      packageId: 'pkg-database',
      traceId: '0123456789abcdef0123456789abcdef',
    });

    const persisted = await prisma.paymentOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { packageSnapshot: true },
    });
    expect(persisted).toMatchObject({ amountMinor: 2_000n, points: 20_000n });
    expect(persisted.packageSnapshot).toMatchObject({
      sourcePackageId: 'pkg-database',
      amountMinor: 2_000n,
      points: 20_000n,
    });
    await expect(
      prisma.rechargePackageSnapshot.update({
        where: { id: persisted.packageSnapshotId },
        data: { amountMinor: 1n },
      }),
    ).rejects.toThrow(/PAYMENT_FACTS_ARE_IMMUTABLE/);
  });
});
