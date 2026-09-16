import type {
  PaymentOrderRecord,
  PaymentRepository,
  RechargePackage,
} from '../application/payment.repository.js';

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

export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly packages = new Map<string, RechargePackage>();
  private readonly orders = new Map<string, PaymentOrderRecord>();
  private readonly snapshots = new Map<string, PackageSnapshot>();

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
    this.orders.set(input.order.id, { ...input.order });
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
}
