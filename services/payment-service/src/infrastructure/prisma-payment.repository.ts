import {
  Prisma,
  type InvoiceApplication,
  type PaymentOrder,
  type PrismaClient,
  type RefundOrder,
} from '../../generated/prisma/client.js';
import { uuidV7 } from '../domain/uuid-v7.js';
import type {
  PaymentOrderRecord,
  PaymentRepository,
  RechargePackage,
} from '../application/payment.repository.js';
import type {
  PaymentSettlement,
  PaymentSettlementRepository,
} from '../application/payment-settlement.repository.js';
import type {
  FinancialOrder,
  InvoiceRecord,
  InvoiceRecordStatus,
  PaymentFinancialRepository,
  ReconciliationDifference,
  RefundRecord,
} from '../application/payment-financial.repository.js';
import type { VerifiedPayment } from '../ports/payment-gateway.js';

export interface RechargePackageProvider {
  findPackage(packageId: string): Promise<RechargePackage | undefined>;
}

function toRecord(order: {
  id: string;
  orderNo: string;
  userId: string;
  amountMinor: bigint;
  points: bigint;
  currency: string;
  description: string;
  status: string;
  traceId: string;
  prepayId: string | null;
  expiresAt: Date | null;
}): PaymentOrderRecord {
  if (order.currency !== 'CNY') throw new Error('UNSUPPORTED_PAYMENT_CURRENCY');
  if (!['PENDING', 'PAID', 'CLOSED', 'REFUNDED', 'FAILED'].includes(order.status)) {
    throw new Error('INVALID_PAYMENT_ORDER_STATUS');
  }
  return {
    id: order.id,
    orderNo: order.orderNo,
    userId: order.userId,
    amountMinor: order.amountMinor,
    points: order.points,
    currency: order.currency,
    description: order.description,
    status: order.status as PaymentOrderRecord['status'],
    traceId: order.traceId,
    ...(order.prepayId ? { prepayId: order.prepayId } : {}),
    ...(order.expiresAt ? { expiresAt: order.expiresAt } : {}),
  };
}

function settlementError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export class PrismaPaymentRepository
  implements PaymentRepository, PaymentSettlementRepository, PaymentFinancialRepository
{
  constructor(
    private readonly prisma: PrismaClient,
    private readonly packages: RechargePackageProvider,
  ) {}

  findPackage(packageId: string): Promise<RechargePackage | undefined> {
    return this.packages.findPackage(packageId);
  }

  async createOrderWithSnapshot(input: {
    order: PaymentOrderRecord;
    sourcePackageId: string;
    packageTitle: string;
  }): Promise<PaymentOrderRecord> {
    const order = await this.prisma.$transaction(async (transaction) => {
      const snapshot = await transaction.rechargePackageSnapshot.create({
        data: {
          id: uuidV7(),
          sourcePackageId: input.sourcePackageId,
          title: input.packageTitle,
          amountMinor: input.order.amountMinor,
          points: input.order.points,
          currency: input.order.currency,
        },
      });
      return transaction.paymentOrder.create({
        data: {
          ...input.order,
          packageSnapshotId: snapshot.id,
        },
      });
    });
    return toRecord(order);
  }

  async markGatewayCreated(
    orderId: string,
    gateway: { prepayId: string; expiresAt: Date },
  ): Promise<PaymentOrderRecord> {
    const order = await this.prisma.paymentOrder.update({
      where: { id: orderId },
      data: gateway,
    });
    return toRecord(order);
  }

  acceptPayment(input: {
    callbackId: string;
    rawBodyHash: string;
    expectedMerchantId: string;
    payment: VerifiedPayment;
    source: 'CALLBACK' | 'ACTIVE_QUERY';
  }): Promise<PaymentSettlement> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${input.payment.transactionId}))`,
      );
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "PaymentOrder" WHERE "orderNo" = ${input.payment.orderNo} FOR UPDATE`,
      );
      const order = await transaction.paymentOrder.findUnique({
        where: { orderNo: input.payment.orderNo },
      });
      if (!order) throw settlementError('PAYMENT_ORDER_NOT_FOUND');

      const existing = await transaction.paymentCallback.findUnique({
        where: { transactionId: input.payment.transactionId },
      });
      if (existing) {
        if (
          existing.orderNo !== input.payment.orderNo ||
          existing.rawBodyHash !== input.rawBodyHash
        ) {
          throw settlementError('PAYMENT_CALLBACK_CONFLICT');
        }
        return this.toSettlement(order, false);
      }
      if (input.payment.merchantId !== input.expectedMerchantId) {
        throw settlementError('PAYMENT_MERCHANT_MISMATCH');
      }
      if (input.payment.currency !== 'CNY' || input.payment.currency !== order.currency) {
        throw settlementError('PAYMENT_CURRENCY_MISMATCH');
      }
      if (input.payment.amountMinor !== order.amountMinor) {
        throw settlementError('PAYMENT_AMOUNT_MISMATCH');
      }
      if (order.status === 'PAID' && order.transactionId === input.payment.transactionId) {
        return this.toSettlement(order, false);
      }
      if (order.status !== 'PENDING') {
        throw settlementError('PAYMENT_ORDER_STATE_INVALID');
      }

      const updated = await transaction.paymentOrder.update({
        where: { id: order.id },
        data: {
          status: 'PAID',
          transactionId: input.payment.transactionId,
          paidAt: input.payment.paidAt,
        },
      });
      await transaction.paymentCallback.create({
        data: {
          id: uuidV7(),
          callbackId: input.callbackId,
          transactionId: input.payment.transactionId,
          orderNo: input.payment.orderNo,
          rawBodyHash: input.rawBodyHash,
          payload: {
            source: input.source,
            merchantId: input.payment.merchantId,
            currency: input.payment.currency,
            amountMinor: input.payment.amountMinor.toString(),
            paidAt: input.payment.paidAt.toISOString(),
          },
          processedAt: new Date(),
        },
      });
      await transaction.outboxEvent.create({
        data: {
          id: uuidV7(),
          aggregateType: 'PaymentOrder',
          aggregateId: order.id,
          eventType: 'payment.paid.v1',
          traceId: order.traceId,
          payload: {
            orderId: order.id,
            orderNo: order.orderNo,
            userId: order.userId,
            points: order.points.toString(),
            amountMinor: order.amountMinor.toString(),
            transactionId: input.payment.transactionId,
          },
        },
      });
      return this.toSettlement(updated, true);
    });
  }

  async findPendingBefore(cutoff: Date, limit: number): Promise<readonly string[]> {
    const orders = await this.prisma.paymentOrder.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { orderNo: true },
    });
    return orders.map((order) => order.orderNo);
  }

  async findFinancialOrder(orderId: string): Promise<FinancialOrder | undefined> {
    const order = await this.prisma.paymentOrder.findUnique({ where: { id: orderId } });
    return order ? this.toFinancialOrder(order) : undefined;
  }

  async createOrGetRefund(input: RefundRecord): Promise<RefundRecord> {
    const existing = await this.prisma.refundOrder.findUnique({
      where: { refundNo: input.refundNo },
    });
    if (existing) return this.ensureSameRefund(existing, input);
    try {
      const refund = await this.prisma.refundOrder.create({
        data: {
          id: input.id,
          orderId: input.orderId,
          refundNo: input.refundNo,
          amountMinor: input.amountMinor,
          reason: input.reason,
          status: input.status,
          walletBusinessKey: input.walletBusinessKey,
          traceId: input.traceId,
        },
      });
      return this.toRefundRecord(refund);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const concurrent = await this.prisma.refundOrder.findUniqueOrThrow({
        where: { refundNo: input.refundNo },
      });
      return this.ensureSameRefund(concurrent, input);
    }
  }

  async markRefundProcessing(refundId: string): Promise<RefundRecord> {
    const refund = await this.prisma.refundOrder.update({
      where: { id: refundId },
      data: { status: 'PROCESSING', attempts: { increment: 1 }, lastError: null },
    });
    return this.toRefundRecord(refund);
  }

  async markRefundFailed(refundId: string, error: string): Promise<RefundRecord> {
    const refund = await this.prisma.refundOrder.update({
      where: { id: refundId },
      data: { status: 'FAILED', lastError: error.slice(0, 500) },
    });
    return this.toRefundRecord(refund);
  }

  completeRefund(refundId: string, gatewayRefundId: string): Promise<RefundRecord> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "RefundOrder" WHERE "id" = ${refundId}::uuid FOR UPDATE`,
      );
      const existing = await transaction.refundOrder.findUnique({ where: { id: refundId } });
      if (!existing) throw settlementError('REFUND_NOT_FOUND');
      if (existing.status === 'SUCCEEDED') return this.toRefundRecord(existing);
      const refund = await transaction.refundOrder.update({
        where: { id: refundId },
        data: {
          status: 'SUCCEEDED',
          gatewayRefundId,
          lastError: null,
          completedAt: new Date(),
        },
      });
      await transaction.paymentOrder.update({
        where: { id: existing.orderId },
        data: { status: 'REFUNDED' },
      });
      return this.toRefundRecord(refund);
    });
  }

  async listPaidOrders(from: Date, to: Date): Promise<readonly FinancialOrder[]> {
    const orders = await this.prisma.paymentOrder.findMany({
      where: { status: 'PAID', paidAt: { gte: from, lt: to } },
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    });
    return orders.map((order) => this.toFinancialOrder(order));
  }

  saveReconciliation(input: {
    id: string;
    billDate: Date;
    differences: readonly ReconciliationDifference[];
  }): Promise<void> {
    const summary: Prisma.InputJsonObject[] = input.differences.map((difference) => ({
      kind: difference.kind,
      orderNo: difference.orderNo,
      severity: difference.severity,
      ...(difference.channelTransactionId
        ? { channelTransactionId: difference.channelTransactionId }
        : {}),
      ...(difference.platformTransactionId
        ? { platformTransactionId: difference.platformTransactionId }
        : {}),
      ...(difference.channelAmountMinor === undefined
        ? {}
        : { channelAmountMinor: difference.channelAmountMinor.toString() }),
      ...(difference.platformAmountMinor === undefined
        ? {}
        : { platformAmountMinor: difference.platformAmountMinor.toString() }),
    }));
    return this.prisma.$transaction(async (transaction) => {
      const reconciliation = await transaction.channelReconciliation.upsert({
        where: { billDate: input.billDate },
        create: {
          id: input.id,
          billDate: input.billDate,
          status: input.differences.length === 0 ? 'MATCHED' : 'MISMATCHED',
          differenceCount: input.differences.length,
          summary,
          completedAt: new Date(),
        },
        update: {
          status: input.differences.length === 0 ? 'MATCHED' : 'MISMATCHED',
          differenceCount: input.differences.length,
          summary,
          completedAt: new Date(),
        },
      });
      const severities = new Set(input.differences.map((difference) => difference.severity));
      for (const severity of severities) {
        await transaction.outboxEvent.create({
          data: {
            id: uuidV7(),
            aggregateType: 'ChannelReconciliation',
            aggregateId: reconciliation.id,
            eventType: `payment.reconciliation.${severity.toLowerCase()}.v1`,
            traceId: `reconciliation:${input.billDate.toISOString().slice(0, 10)}`,
            payload: {
              billDate: input.billDate.toISOString().slice(0, 10),
              differenceCount: input.differences.length,
              severity,
            },
          },
        });
      }
    });
  }

  async createInvoice(input: InvoiceRecord): Promise<InvoiceRecord> {
    try {
      const invoice = await this.prisma.invoiceApplication.create({
        data: {
          id: input.id,
          userId: input.userId,
          orderId: input.orderId,
          amountMinor: input.amountMinor,
          title: input.title,
          ...(input.taxNo ? { taxNo: input.taxNo } : {}),
          status: input.status,
        },
      });
      return this.toInvoiceRecord(invoice);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw settlementError('INVOICE_ORDER_ALREADY_USED');
      }
      throw error;
    }
  }

  async findInvoice(invoiceId: string): Promise<InvoiceRecord | undefined> {
    const invoice = await this.prisma.invoiceApplication.findUnique({
      where: { id: invoiceId },
    });
    return invoice ? this.toInvoiceRecord(invoice) : undefined;
  }

  updateInvoice(input: {
    invoiceId: string;
    expectedStatus: readonly InvoiceRecordStatus[];
    nextStatus: InvoiceRecordStatus;
    rejectionReason?: string;
    issuedAt?: Date;
  }): Promise<InvoiceRecord> {
    return this.prisma.$transaction(async (transaction) => {
      const result = await transaction.invoiceApplication.updateMany({
        where: { id: input.invoiceId, status: { in: [...input.expectedStatus] } },
        data: {
          status: input.nextStatus,
          ...(input.rejectionReason ? { rejectionReason: input.rejectionReason } : {}),
          ...(input.issuedAt ? { issuedAt: input.issuedAt } : {}),
        },
      });
      if (result.count !== 1) {
        const exists = await transaction.invoiceApplication.findUnique({
          where: { id: input.invoiceId },
          select: { id: true },
        });
        throw settlementError(exists ? 'INVOICE_STATUS_INVALID' : 'INVOICE_NOT_FOUND');
      }
      const invoice = await transaction.invoiceApplication.findUniqueOrThrow({
        where: { id: input.invoiceId },
      });
      return this.toInvoiceRecord(invoice);
    });
  }

  private toSettlement(
    order: {
      id: string;
      orderNo: string;
      userId: string;
      points: bigint;
      traceId: string;
    },
    accepted: boolean,
  ): PaymentSettlement {
    return {
      accepted,
      orderId: order.id,
      orderNo: order.orderNo,
      userId: order.userId,
      points: order.points,
      traceId: order.traceId,
    };
  }

  private toFinancialOrder(order: PaymentOrder): FinancialOrder {
    return {
      id: order.id,
      orderNo: order.orderNo,
      userId: order.userId,
      amountMinor: order.amountMinor,
      points: order.points,
      currency: order.currency,
      status: order.status,
      traceId: order.traceId,
      ...(order.transactionId ? { transactionId: order.transactionId } : {}),
      ...(order.paidAt ? { paidAt: order.paidAt } : {}),
    };
  }

  private toRefundRecord(refund: RefundOrder): RefundRecord {
    return {
      id: refund.id,
      orderId: refund.orderId,
      refundNo: refund.refundNo,
      amountMinor: refund.amountMinor,
      reason: refund.reason,
      status: refund.status,
      walletBusinessKey: refund.walletBusinessKey,
      traceId: refund.traceId,
      ...(refund.gatewayRefundId ? { gatewayRefundId: refund.gatewayRefundId } : {}),
      ...(refund.lastError ? { lastError: refund.lastError } : {}),
    };
  }

  private ensureSameRefund(existing: RefundOrder, input: RefundRecord): RefundRecord {
    if (
      existing.orderId !== input.orderId ||
      existing.amountMinor !== input.amountMinor ||
      existing.reason !== input.reason
    ) {
      throw settlementError('REFUND_IDEMPOTENCY_CONFLICT');
    }
    return this.toRefundRecord(existing);
  }

  private toInvoiceRecord(invoice: InvoiceApplication): InvoiceRecord {
    return {
      id: invoice.id,
      userId: invoice.userId,
      orderId: invoice.orderId,
      amountMinor: invoice.amountMinor,
      title: invoice.title,
      status: invoice.status,
      ...(invoice.taxNo ? { taxNo: invoice.taxNo } : {}),
      ...(invoice.rejectionReason ? { rejectionReason: invoice.rejectionReason } : {}),
    };
  }
}
