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

interface PackageSnapshot {
  sourcePackageId: string;
  title: string;
  amountMinor: bigint;
  points: bigint;
  currency: 'CNY';
}

function domainError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

interface StoredOrder extends PaymentOrderRecord {
  createdAt: Date;
  transactionId?: string;
  paidAt?: Date;
}

interface StoredCallback {
  transactionId: string;
  orderNo: string;
  rawBodyHash: string;
}

interface StoredOutboxEvent {
  eventType: string;
  aggregateId: string;
  payload: Record<string, string>;
}

function settlementError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export class InMemoryPaymentRepository implements PaymentRepository, PaymentSettlementRepository {
  private readonly packages = new Map<string, RechargePackage>();
  private readonly orders = new Map<string, StoredOrder>();
  private readonly snapshots = new Map<string, PackageSnapshot>();
  private readonly callbacks = new Map<string, StoredCallback>();
  private readonly outbox: StoredOutboxEvent[] = [];

  constructor(packages: readonly RechargePackage[]) {
    for (const rechargePackage of packages) this.packages.set(rechargePackage.id, rechargePackage);
  }

  findPackage(packageId: string): Promise<RechargePackage | undefined> {
    return Promise.resolve(this.packages.get(packageId));
  }

  createOrderWithSnapshot(input: {
    order: PaymentOrderRecord;
    sourcePackageId: string;
    packageTitle: string;
  }): Promise<PaymentOrderRecord> {
    if (this.orders.has(input.order.id)) return Promise.reject(domainError('PAYMENT_ORDER_EXISTS'));
    this.orders.set(input.order.id, { ...input.order, createdAt: new Date() });
    this.snapshots.set(input.order.id, {
      sourcePackageId: input.sourcePackageId,
      title: input.packageTitle,
      amountMinor: input.order.amountMinor,
      points: input.order.points,
      currency: input.order.currency,
    });
    return Promise.resolve({ ...input.order });
  }

  markGatewayCreated(
    orderId: string,
    gateway: { prepayId: string; expiresAt: Date },
  ): Promise<PaymentOrderRecord> {
    const order = this.orders.get(orderId);
    if (!order) return Promise.reject(domainError('PAYMENT_ORDER_NOT_FOUND'));
    order.prepayId = gateway.prepayId;
    order.expiresAt = gateway.expiresAt;
    return Promise.resolve({ ...order });
  }

  packageSnapshot(orderId: string): PackageSnapshot | undefined {
    const snapshot = this.snapshots.get(orderId);
    return snapshot ? { ...snapshot } : undefined;
  }

  acceptPayment(input: {
    callbackId: string;
    rawBodyHash: string;
    expectedMerchantId: string;
    payment: VerifiedPayment;
    source: 'CALLBACK' | 'ACTIVE_QUERY';
  }): Promise<PaymentSettlement> {
    const callback = this.callbacks.get(input.payment.transactionId);
    const order = [...this.orders.values()].find(
      (candidate) => candidate.orderNo === input.payment.orderNo,
    );
    if (!order) return Promise.reject(settlementError('PAYMENT_ORDER_NOT_FOUND'));
    if (callback) {
      if (
        callback.orderNo !== input.payment.orderNo ||
        callback.rawBodyHash !== input.rawBodyHash
      ) {
        return Promise.reject(settlementError('PAYMENT_CALLBACK_CONFLICT'));
      }
      return Promise.resolve(this.settlement(order, false));
    }
    if (input.payment.merchantId !== input.expectedMerchantId) {
      return Promise.reject(settlementError('PAYMENT_MERCHANT_MISMATCH'));
    }
    if (input.payment.currency !== 'CNY') {
      return Promise.reject(settlementError('PAYMENT_CURRENCY_MISMATCH'));
    }
    if (input.payment.amountMinor !== order.amountMinor) {
      return Promise.reject(settlementError('PAYMENT_AMOUNT_MISMATCH'));
    }
    if (order.status === 'PAID' && order.transactionId === input.payment.transactionId) {
      return Promise.resolve(this.settlement(order, false));
    }
    if (order.status !== 'PENDING') {
      return Promise.reject(settlementError('PAYMENT_ORDER_STATE_INVALID'));
    }
    order.status = 'PAID';
    order.transactionId = input.payment.transactionId;
    order.paidAt = input.payment.paidAt;
    this.callbacks.set(input.payment.transactionId, {
      transactionId: input.payment.transactionId,
      orderNo: input.payment.orderNo,
      rawBodyHash: input.rawBodyHash,
    });
    this.outbox.push({
      eventType: 'payment.paid.v1',
      aggregateId: order.id,
      payload: {
        orderId: order.id,
        orderNo: order.orderNo,
        userId: order.userId,
        points: order.points.toString(),
        amountMinor: order.amountMinor.toString(),
        transactionId: input.payment.transactionId,
      },
    });
    return Promise.resolve(this.settlement(order, true));
  }

  findPendingBefore(cutoff: Date, limit: number): Promise<readonly string[]> {
    return Promise.resolve(
      [...this.orders.values()]
        .filter((order) => order.status === 'PENDING' && order.createdAt < cutoff)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        .slice(0, limit)
        .map((order) => order.orderNo),
    );
  }

  orderStatus(orderNo: string): PaymentOrderRecord['status'] | undefined {
    return [...this.orders.values()].find((order) => order.orderNo === orderNo)?.status;
  }

  setCreatedAt(orderNo: string, createdAt: Date): void {
    const order = [...this.orders.values()].find((candidate) => candidate.orderNo === orderNo);
    if (!order) throw settlementError('PAYMENT_ORDER_NOT_FOUND');
    order.createdAt = createdAt;
  }

  outboxEvents(): readonly StoredOutboxEvent[] {
    return this.outbox.map((event) => ({ ...event, payload: { ...event.payload } }));
  }

  private settlement(order: StoredOrder, accepted: boolean): PaymentSettlement {
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
