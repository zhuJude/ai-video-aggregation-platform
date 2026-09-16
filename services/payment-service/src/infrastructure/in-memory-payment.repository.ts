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
  published: boolean;
}

function settlementError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export class InMemoryPaymentRepository
  implements PaymentRepository, PaymentSettlementRepository, PaymentFinancialRepository
{
  private readonly packages = new Map<string, RechargePackage>();
  private readonly orders = new Map<string, StoredOrder>();
  private readonly snapshots = new Map<string, PackageSnapshot>();
  private readonly callbacks = new Map<string, StoredCallback>();
  private readonly outbox: StoredOutboxEvent[] = [];
  private readonly refunds = new Map<string, RefundRecord>();
  private readonly invoices = new Map<string, InvoiceRecord>();
  private readonly invoiceByOrder = new Map<string, string>();

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
      published: false,
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

  listPendingWalletCredits(limit: number): Promise<readonly PaymentSettlement[]> {
    const settlements = this.outbox
      .filter((event) => event.eventType === 'payment.paid.v1' && !event.published)
      .slice(0, limit)
      .map((event) => {
        const order = this.orders.get(event.aggregateId);
        if (!order) throw settlementError('PAYMENT_ORDER_NOT_FOUND');
        return this.settlement(order, false);
      });
    return Promise.resolve(settlements);
  }

  markWalletCreditPublished(orderId: string): Promise<void> {
    const event = this.outbox.find(
      (candidate) => candidate.aggregateId === orderId && candidate.eventType === 'payment.paid.v1',
    );
    if (!event) return Promise.reject(settlementError('PAYMENT_OUTBOX_NOT_FOUND'));
    event.published = true;
    return Promise.resolve();
  }

  findFinancialOrder(orderId: string): Promise<FinancialOrder | undefined> {
    const order = this.orders.get(orderId);
    return Promise.resolve(order ? this.toFinancialOrder(order) : undefined);
  }

  createOrGetRefund(input: RefundRecord): Promise<RefundRecord> {
    const existing = this.refunds.get(input.refundNo);
    if (existing) {
      if (
        existing.orderId !== input.orderId ||
        existing.amountMinor !== input.amountMinor ||
        existing.reason !== input.reason
      ) {
        return Promise.reject(settlementError('REFUND_IDEMPOTENCY_CONFLICT'));
      }
      return Promise.resolve({ ...existing });
    }
    this.refunds.set(input.refundNo, { ...input });
    return Promise.resolve({ ...input });
  }

  markRefundProcessing(refundId: string): Promise<RefundRecord> {
    const refund = this.refundById(refundId);
    refund.status = 'PROCESSING';
    delete refund.lastError;
    return Promise.resolve({ ...refund });
  }

  markRefundFailed(refundId: string, error: string): Promise<RefundRecord> {
    return this.updateRefund(refundId, { status: 'FAILED', lastError: error });
  }

  completeRefund(refundId: string, gatewayRefundId: string): Promise<RefundRecord> {
    const refund = this.refundById(refundId);
    const order = this.orders.get(refund.orderId);
    if (!order) return Promise.reject(settlementError('PAYMENT_ORDER_NOT_FOUND'));
    refund.status = 'SUCCEEDED';
    refund.gatewayRefundId = gatewayRefundId;
    delete refund.lastError;
    order.status = 'REFUNDED';
    return Promise.resolve({ ...refund });
  }

  listPaidOrders(from: Date, to: Date): Promise<readonly FinancialOrder[]> {
    return Promise.resolve(
      [...this.orders.values()]
        .filter(
          (order) =>
            order.status === 'PAID' &&
            order.paidAt !== undefined &&
            order.paidAt >= from &&
            order.paidAt < to,
        )
        .map((order) => this.toFinancialOrder(order)),
    );
  }

  saveReconciliation(input: {
    id: string;
    billDate: Date;
    differences: readonly ReconciliationDifference[];
  }): Promise<void> {
    const severities = new Set(input.differences.map((difference) => difference.severity));
    for (const severity of severities) {
      this.outbox.push({
        eventType: `payment.reconciliation.${severity.toLowerCase()}.v1`,
        aggregateId: input.id,
        payload: {
          billDate: input.billDate.toISOString().slice(0, 10),
          differenceCount: input.differences.length.toString(),
          severity,
        },
        published: false,
      });
    }
    return Promise.resolve();
  }

  createInvoice(input: InvoiceRecord): Promise<InvoiceRecord> {
    if (this.invoiceByOrder.has(input.orderId)) {
      return Promise.reject(settlementError('INVOICE_ORDER_ALREADY_USED'));
    }
    this.invoices.set(input.id, { ...input });
    this.invoiceByOrder.set(input.orderId, input.id);
    return Promise.resolve({ ...input });
  }

  findInvoice(invoiceId: string): Promise<InvoiceRecord | undefined> {
    const invoice = this.invoices.get(invoiceId);
    return Promise.resolve(invoice ? { ...invoice } : undefined);
  }

  updateInvoice(input: {
    invoiceId: string;
    expectedStatus: readonly InvoiceRecordStatus[];
    nextStatus: InvoiceRecordStatus;
    rejectionReason?: string;
    issuedAt?: Date;
  }): Promise<InvoiceRecord> {
    const invoice = this.invoices.get(input.invoiceId);
    if (!invoice) return Promise.reject(settlementError('INVOICE_NOT_FOUND'));
    if (!input.expectedStatus.includes(invoice.status)) {
      return Promise.reject(settlementError('INVOICE_STATUS_INVALID'));
    }
    invoice.status = input.nextStatus;
    if (input.rejectionReason) invoice.rejectionReason = input.rejectionReason;
    return Promise.resolve({ ...invoice });
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

  private toFinancialOrder(order: StoredOrder): FinancialOrder {
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

  private refundById(refundId: string): RefundRecord {
    const refund = [...this.refunds.values()].find((candidate) => candidate.id === refundId);
    if (!refund) throw settlementError('REFUND_NOT_FOUND');
    return refund;
  }

  private updateRefund(refundId: string, changes: Partial<RefundRecord>): Promise<RefundRecord> {
    const refund = this.refundById(refundId);
    Object.assign(refund, changes);
    return Promise.resolve({ ...refund });
  }
}
