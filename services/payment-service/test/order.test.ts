import { describe, expect, it } from 'vitest';
import { OrderService } from '../src/application/order.service.js';
import { FakePaymentGateway } from '../src/adapters/fake-payment.gateway.js';
import { InMemoryPaymentRepository } from '../src/infrastructure/in-memory-payment.repository.js';

const userId = '0198f5f6-b5c9-7d33-a4a5-608b27b9d776';

describe('recharge order creation', () => {
  it('uses the server-side package amount and immutable point snapshot', async () => {
    const repository = new InMemoryPaymentRepository([
      {
        id: 'pkg-100',
        title: '100元充值包',
        amountMinor: 10_000n,
        points: 100_000n,
        currency: 'CNY',
        active: true,
      },
    ]);
    const service = new OrderService(repository, new FakePaymentGateway());

    const order = await service.create({
      userId,
      packageId: 'pkg-100',
      amountMinor: '1',
      points: '999999999',
      traceId: '0123456789abcdef0123456789abcdef',
    } as never);

    expect(order).toMatchObject({
      amountMinor: 10_000n,
      points: 100_000n,
      currency: 'CNY',
      status: 'PENDING',
    });
    expect(repository.packageSnapshot(order.id)).toMatchObject({
      sourcePackageId: 'pkg-100',
      amountMinor: 10_000n,
      points: 100_000n,
    });
  });

  it('rejects inactive packages before calling the gateway', async () => {
    const repository = new InMemoryPaymentRepository([
      {
        id: 'pkg-offline',
        title: '下架套餐',
        amountMinor: 1_000n,
        points: 10_000n,
        currency: 'CNY',
        active: false,
      },
    ]);
    const gateway = new FakePaymentGateway();
    const service = new OrderService(repository, gateway);

    await expect(
      service.create({
        userId,
        packageId: 'pkg-offline',
        traceId: '0123456789abcdef0123456789abcdef',
      }),
    ).rejects.toMatchObject({ code: 'RECHARGE_PACKAGE_UNAVAILABLE' });
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('rejects a server package with a non-positive amount or points', async () => {
    const repository = new InMemoryPaymentRepository([
      {
        id: 'pkg-invalid',
        title: '错误套餐',
        amountMinor: 0n,
        points: 10_000n,
        currency: 'CNY',
        active: true,
      },
    ]);

    await expect(
      new OrderService(repository, new FakePaymentGateway()).create({
        userId,
        packageId: 'pkg-invalid',
        traceId: '0123456789abcdef0123456789abcdef',
      }),
    ).rejects.toMatchObject({ code: 'RECHARGE_PACKAGE_INVALID' });
  });
});
