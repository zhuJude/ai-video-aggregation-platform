import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { PaymentCallbackService } from '../src/application/payment-callback.service.js';
import { OrderService } from '../src/application/order.service.js';
import { InMemoryPaymentRepository } from '../src/infrastructure/in-memory-payment.repository.js';
import type { PaymentGateway, VerifiedPayment } from '../src/ports/payment-gateway.js';

const userId = '0198f5f6-b5c9-7d33-a4a5-608b27b9d776';
const now = new Date('2026-08-31T12:00:00.000Z');

class CallbackGateway implements PaymentGateway {
  constructor(public payment?: VerifiedPayment) {}

  createNativeOrder(): Promise<{ prepayId: string; expiresAt: Date }> {
    return Promise.resolve({ prepayId: 'prepay-1', expiresAt: new Date(now.getTime() + 900_000) });
  }

  verifyCallback(): Promise<VerifiedPayment> {
    if (!this.payment) return Promise.reject(new Error('PAYMENT_NOT_CONFIGURED'));
    return Promise.resolve(this.payment);
  }

  queryOrder(): Promise<VerifiedPayment | undefined> {
    return Promise.resolve(this.payment);
  }

  closeOrder(): Promise<void> {
    return Promise.resolve();
  }

  refund(): Promise<{ refundId: string }> {
    return Promise.resolve({ refundId: 'refund-1' });
  }

  downloadBill(): Promise<NodeJS.ReadableStream> {
    return Promise.resolve(Readable.from(''));
  }
}

async function fixture() {
  const repository = new InMemoryPaymentRepository([
    {
      id: 'pkg-100',
      title: '一百元套餐',
      amountMinor: 10_000n,
      points: 100_000n,
      currency: 'CNY',
      active: true,
    },
  ]);
  const gateway = new CallbackGateway();
  const order = await new OrderService(repository, gateway).create({
    userId,
    packageId: 'pkg-100',
    traceId: '0123456789abcdef0123456789abcdef',
  });
  gateway.payment = {
    transactionId: 'wx-transaction-1',
    orderNo: order.orderNo,
    merchantId: '1900000109',
    amountMinor: 10_000n,
    currency: 'CNY',
    paidAt: now,
  };
  const wallet = {
    credit: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ledgerTransactionId: 'ledger-1' };
    }),
  };
  const service = new PaymentCallbackService(repository, gateway, wallet, {
    merchantId: '1900000109',
    now: () => now,
  });
  return { repository, gateway, order, wallet, service };
}

describe('payment callback settlement', () => {
  it('credits the wallet once for concurrent repeated valid callbacks', async () => {
    const { repository, order, service, wallet } = await fixture();
    const rawBody = '{"id":"callback-1","resource":{"ciphertext":"opaque"}}';

    const results = await Promise.all([
      service.handle({ 'wechatpay-serial': 'platform-serial' }, rawBody),
      service.handle({ 'wechatpay-serial': 'platform-serial' }, rawBody),
    ]);

    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(wallet.credit).toHaveBeenCalledTimes(1);
    expect(wallet.credit).toHaveBeenCalledWith({
      userId,
      points: 100_000n,
      businessKey: `payment:${order.id}:credit`,
      traceId: '0123456789abcdef0123456789abcdef',
    });
    expect(repository.orderStatus(order.orderNo)).toBe('PAID');
    expect(repository.outboxEvents()).toHaveLength(1);
  });

  it.each([
    ['merchant', { merchantId: 'another-merchant' }, 'PAYMENT_MERCHANT_MISMATCH'],
    ['currency', { currency: 'USD' }, 'PAYMENT_CURRENCY_MISMATCH'],
    ['amount', { amountMinor: 1n }, 'PAYMENT_AMOUNT_MISMATCH'],
  ] as const)('rejects a signed callback with a mismatched %s', async (_label, change, code) => {
    const { gateway, order, repository, service, wallet } = await fixture();
    const configuredPayment = gateway.payment;
    if (!configuredPayment) throw new Error('payment fixture is missing');
    gateway.payment = { ...configuredPayment, ...change };

    await expect(service.handle({}, '{"id":"mismatch"}')).rejects.toMatchObject({ code });
    expect(repository.orderStatus(order.orderNo)).toBe('PENDING');
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('recovers an old pending order through the same settlement transition', async () => {
    const { repository, order, service, wallet } = await fixture();
    repository.setCreatedAt(order.orderNo, new Date(now.getTime() - 180_000));

    await expect(service.recoverStalePending()).resolves.toEqual({ checked: 1, settled: 1 });
    expect(repository.orderStatus(order.orderNo)).toBe('PAID');
    expect(repository.outboxEvents()).toHaveLength(1);
    expect(wallet.credit).toHaveBeenCalledTimes(1);
  });
});
