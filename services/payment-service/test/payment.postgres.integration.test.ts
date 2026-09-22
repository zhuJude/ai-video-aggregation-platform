import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { FakePaymentGateway } from '../src/adapters/fake-payment.gateway.js';
import { PaymentCallbackService } from '../src/application/payment-callback.service.js';
import { ChannelReconciliationJob } from '../src/application/channel-reconciliation.job.js';
import { InvoiceService } from '../src/application/invoice.service.js';
import { OrderService } from '../src/application/order.service.js';
import { RefundService } from '../src/application/refund.service.js';
import { PrismaPaymentRepository } from '../src/infrastructure/prisma-payment.repository.js';

const serviceRoot = fileURLToPath(new URL('../', import.meta.url));
const userId = '0198f5f6-b5c9-7d33-a4a5-608b27b9d776';

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
  let repository: PrismaPaymentRepository;
  let gateway: FakePaymentGateway;

  beforeEach(() => vi.restoreAllMocks());

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
    repository = new PrismaPaymentRepository(prisma, {
      findPackage: () =>
        Promise.resolve({
          id: 'pkg-database',
          title: '数据库套餐',
          amountMinor: 2_000n,
          points: 20_000n,
          currency: 'CNY',
          active: true,
        }),
    });
    gateway = new FakePaymentGateway();
    service = new OrderService(repository, gateway);
  }, 120_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (containerId) docker('stop', containerId);
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

  it('serializes concurrent duplicate callbacks into one outbox event and wallet credit', async () => {
    const order = await service.create({
      userId,
      packageId: 'pkg-database',
      traceId: 'fedcba9876543210fedcba9876543210',
    });
    vi.spyOn(gateway, 'verifyCallback').mockResolvedValue({
      transactionId: 'wx-database-transaction',
      orderNo: order.orderNo,
      merchantId: '1900000109',
      amountMinor: 2_000n,
      currency: 'CNY',
      paidAt: new Date('2026-08-31T12:00:00.000Z'),
    });
    const wallet = { credit: vi.fn(() => Promise.resolve({ ledgerTransactionId: 'ledger-1' })) };
    const callback = new PaymentCallbackService(repository, gateway, wallet, {
      merchantId: '1900000109',
    });
    const rawBody = '{"id":"callback-database"}';

    const results = await Promise.all([callback.handle({}, rawBody), callback.handle({}, rawBody)]);

    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(wallet.credit).toHaveBeenCalledTimes(1);
    await expect(
      prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } }),
    ).resolves.toMatchObject({ status: 'PAID', transactionId: 'wx-database-transaction' });
    await expect(
      prisma.outboxEvent.count({
        where: { aggregateId: order.id, eventType: 'payment.paid.v1' },
      }),
    ).resolves.toBe(1);
  });

  it('persists reconciliation, refund retry state and one invoice per paid order', async () => {
    const order = await service.create({
      userId,
      packageId: 'pkg-database',
      traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    vi.spyOn(gateway, 'verifyCallback').mockResolvedValue({
      transactionId: 'wx-financial-workflows',
      orderNo: order.orderNo,
      merchantId: '1900000109',
      amountMinor: 2_000n,
      currency: 'CNY',
      paidAt: new Date('2026-08-28T12:00:00.000Z'),
    });
    await new PaymentCallbackService(
      repository,
      gateway,
      { credit: () => Promise.resolve({ ledgerTransactionId: 'ledger-credit-2' }) },
      { merchantId: '1900000109' },
    ).handle({}, '{"id":"financial-workflows"}');

    const invoices = new InvoiceService(repository);
    await invoices.apply({ userId, orderId: order.id, title: '个人' });
    await expect(
      invoices.apply({ userId, orderId: order.id, title: '重复' }),
    ).rejects.toMatchObject({ code: 'INVOICE_ORDER_ALREADY_USED' });

    vi.spyOn(gateway, 'downloadBill').mockResolvedValue(
      Readable.from(
        'order_no,transaction_id,amount_minor,status\n' +
          `${order.orderNo},wx-financial-workflows,2000,SUCCESS\n`,
      ),
    );
    await expect(
      new ChannelReconciliationJob(repository, gateway).run('2026-08-28'),
    ).resolves.toMatchObject({ status: 'MATCHED', differences: [] });
    await expect(
      prisma.channelReconciliation.findUniqueOrThrow({
        where: { billDate: new Date('2026-08-28T00:00:00.000Z') },
      }),
    ).resolves.toMatchObject({ status: 'MATCHED', differenceCount: 0 });

    vi.spyOn(gateway, 'refund').mockResolvedValue({ refundId: 'wx-refund-database' });
    const wallet = {
      compensateRefund: vi.fn(() =>
        Promise.resolve({ ledgerTransactionId: 'ledger-refund-database' }),
      ),
    };
    await expect(
      new RefundService(repository, gateway, wallet, {
        authorizedReasons: new Set(['USER_REQUEST']),
      }).refund({
        orderId: order.id,
        userId,
        refundNo: 'REFUND-DATABASE-001',
        reason: 'USER_REQUEST',
        traceId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
    ).resolves.toMatchObject({ status: 'SUCCEEDED', gatewayRefundId: 'wx-refund-database' });
    expect(wallet.compensateRefund).toHaveBeenCalledTimes(1);
  });
});
