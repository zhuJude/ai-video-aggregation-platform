import { uuidV7 } from '../domain/uuid-v7.js';
import type { PaymentGateway } from '../ports/payment-gateway.js';
import type { PaymentFinancialRepository, RefundRecord } from './payment-financial.repository.js';

export interface WalletRefundPort {
  compensateRefund(input: {
    userId: string;
    points: bigint;
    businessKey: string;
    traceId: string;
  }): Promise<{ ledgerTransactionId: string }>;
}

interface RefundOptions {
  authorizedReasons: ReadonlySet<string>;
}

interface RefundCommand {
  orderId: string;
  userId: string;
  refundNo: string;
  reason: string;
  traceId: string;
}

function refundError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'UNKNOWN_REFUND_FAILURE';
}

export class RefundService {
  constructor(
    private readonly repository: PaymentFinancialRepository,
    private readonly gateway: PaymentGateway,
    private readonly wallet: WalletRefundPort,
    private readonly options: RefundOptions,
  ) {}

  async refund(command: RefundCommand): Promise<RefundRecord> {
    if (!this.options.authorizedReasons.has(command.reason)) {
      throw refundError('REFUND_REASON_NOT_AUTHORIZED');
    }
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(command.refundNo)) {
      throw refundError('REFUND_NUMBER_INVALID');
    }
    const order = await this.repository.findFinancialOrder(command.orderId);
    if (!order) throw refundError('PAYMENT_ORDER_NOT_FOUND');
    if (order.userId !== command.userId) throw refundError('REFUND_ORDER_OWNERSHIP_MISMATCH');
    if (order.status !== 'PAID' && order.status !== 'REFUNDED') {
      throw refundError('REFUND_ORDER_STATUS_INVALID');
    }

    const refundId = uuidV7();
    let refund = await this.repository.createOrGetRefund({
      id: refundId,
      orderId: order.id,
      refundNo: command.refundNo,
      amountMinor: order.amountMinor,
      reason: command.reason,
      status: 'PENDING',
      walletBusinessKey: `refund:${refundId}:wallet`,
      traceId: command.traceId,
    });
    if (refund.status === 'SUCCEEDED') return refund;

    try {
      refund = await this.repository.markRefundProcessing(refund.id);
      const gatewayRefund = await this.gateway.refund({
        orderNo: order.orderNo,
        refundNo: refund.refundNo,
        amountMinor: refund.amountMinor,
        reason: refund.reason,
      });
      await this.wallet.compensateRefund({
        userId: order.userId,
        points: order.points,
        businessKey: refund.walletBusinessKey,
        traceId: refund.traceId,
      });
      return await this.repository.completeRefund(refund.id, gatewayRefund.refundId);
    } catch (error) {
      await this.repository.markRefundFailed(refund.id, errorMessage(error));
      throw error;
    }
  }
}
