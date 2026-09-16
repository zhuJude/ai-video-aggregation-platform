import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
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

export class PrismaPaymentRepository implements PaymentRepository, PaymentSettlementRepository {
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
}
