import type { PrismaClient } from '../../generated/prisma/client.js';
import { uuidV7 } from '../domain/uuid-v7.js';
import type {
  PaymentOrderRecord,
  PaymentRepository,
  RechargePackage,
} from '../application/payment.repository.js';

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

export class PrismaPaymentRepository implements PaymentRepository {
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
}
