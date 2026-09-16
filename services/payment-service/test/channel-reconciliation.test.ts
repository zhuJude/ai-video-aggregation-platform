import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentCallbackService } from '../src/application/payment-callback.service.js';
import { ChannelReconciliationJob } from '../src/application/channel-reconciliation.job.js';
import { InvoiceService } from '../src/application/invoice.service.js';
import { OrderService } from '../src/application/order.service.js';
import { RefundService } from '../src/application/refund.service.js';
import { InMemoryPaymentRepository } from '../src/infrastructure/in-memory-payment.repository.js';
import type { PaymentGateway, VerifiedPayment } from '../src/ports/payment-gateway.js';

const userId = '0198f5f6-b5c9-7d33-a4a5-608b27b9d776';
const anotherUserId = '0198f5f6-b5c9-7d33-a4a5-608b27b9d777';
const paidAt = new Date('2026-08-28T12:00:00.000Z');

class WorkflowGateway implements PaymentGateway {
  payment?: VerifiedPayment;
  billText = 'order_no,transaction_id,amount_minor,status\n';
  refundFailures = 0;
  readonly refundCalls: string[] = [];

  createNativeOrder(input: { orderNo: string }): Promise<{ prepayId: string; expiresAt: Date }> {
    return Promise.resolve({
      prepayId: `prepay-${input.orderNo}`,
      expiresAt: new Date(paidAt.getTime() + 900_000),
    });
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

  refund(input: { refundNo: string }): Promise<{ refundId: string }> {
    this.refundCalls.push(input.refundNo);
    if (this.refundFailures > 0) {
      this.refundFailures -= 1;
      return Promise.reject(new Error('GATEWAY_TEMPORARY_FAILURE'));
    }
    return Promise.resolve({ refundId: `wx-refund-${input.refundNo}` });
  }

  downloadBill(): Promise<NodeJS.ReadableStream> {
    return Promise.resolve(Readable.from(this.billText));
  }
}

async function paidOrderFixture() {
  const repository = new InMemoryPaymentRepository([
    {
      id: 'pkg-100',
      title: '充值套餐',
      amountMinor: 10_000n,
      points: 100_000n,
      currency: 'CNY',
      active: true,
    },
  ]);
  const gateway = new WorkflowGateway();
  const order = await new OrderService(repository, gateway).create({
    userId,
    packageId: 'pkg-100',
    traceId: '0123456789abcdef0123456789abcdef',
  });
  gateway.payment = {
    transactionId: 'wx-paid-1',
    orderNo: order.orderNo,
    merchantId: '1900000109',
    amountMinor: order.amountMinor,
    currency: 'CNY',
    paidAt,
  };
  await new PaymentCallbackService(
    repository,
    gateway,
    { credit: () => Promise.resolve({ ledgerTransactionId: 'ledger-credit-1' }) },
    { merchantId: '1900000109' },
  ).handle({}, '{"id":"paid-1"}');
  return { gateway, order, repository };
}

describe('payment financial workflows', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reports channel-only and platform-only payments and emits monetary P0', async () => {
    const { gateway, order, repository } = await paidOrderFixture();
    gateway.billText =
      'order_no,transaction_id,amount_minor,status\n' + 'unexpected,wx-unexpected,10000,SUCCESS\n';

    const result = await new ChannelReconciliationJob(repository, gateway).run('2026-08-28');

    expect(result.differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'CHANNEL_ONLY', orderNo: 'unexpected' }),
        expect.objectContaining({ kind: 'PLATFORM_ONLY', orderNo: order.orderNo }),
      ]),
    );
    expect(result.status).toBe('MISMATCHED');
    expect(repository.outboxEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'payment.reconciliation.p0.v1' }),
      ]),
    );
  });

  it('retries a failed refund with one refund number and idempotent wallet compensation', async () => {
    const { gateway, order, repository } = await paidOrderFixture();
    gateway.refundFailures = 1;
    const wallet = {
      compensateRefund: vi.fn(
        (input: { userId: string; points: bigint; businessKey: string; traceId: string }) => {
          void input;
          return Promise.resolve({ ledgerTransactionId: 'ledger-refund-1' });
        },
      ),
    };
    const service = new RefundService(repository, gateway, wallet, {
      authorizedReasons: new Set(['USER_REQUEST']),
    });
    const command = {
      orderId: order.id,
      userId,
      refundNo: 'REFUND-001',
      reason: 'USER_REQUEST',
      traceId: 'fedcba9876543210fedcba9876543210',
    };

    await expect(service.refund(command)).rejects.toThrow(/GATEWAY_TEMPORARY_FAILURE/);
    await expect(service.refund(command)).resolves.toMatchObject({ status: 'SUCCEEDED' });
    await expect(service.refund(command)).resolves.toMatchObject({ status: 'SUCCEEDED' });

    expect(gateway.refundCalls).toEqual(['REFUND-001', 'REFUND-001']);
    expect(wallet.compensateRefund).toHaveBeenCalledTimes(1);
    const walletCommand = wallet.compensateRefund.mock.calls[0]?.[0];
    expect(walletCommand).toMatchObject({ userId, points: 100_000n });
    expect(walletCommand?.businessKey).toMatch(/^refund:.+:wallet$/);
  });

  it('enforces paid ownership, one invoice per order, and the invoice status flow', async () => {
    const { order, repository } = await paidOrderFixture();
    const service = new InvoiceService(repository);

    await expect(
      service.apply({ userId: anotherUserId, orderId: order.id, title: '错误归属' }),
    ).rejects.toMatchObject({ code: 'INVOICE_ORDER_OWNERSHIP_MISMATCH' });
    const invoice = await service.apply({ userId, orderId: order.id, title: '个人' });
    await expect(service.apply({ userId, orderId: order.id, title: '重复' })).rejects.toMatchObject(
      { code: 'INVOICE_ORDER_ALREADY_USED' },
    );
    await expect(service.approve(invoice.id)).resolves.toMatchObject({ status: 'APPROVED' });
    await expect(service.issue(invoice.id)).resolves.toMatchObject({ status: 'ISSUED' });
    await expect(service.reject(invoice.id, 'too late')).rejects.toMatchObject({
      code: 'INVOICE_STATUS_INVALID',
    });
  });
});
