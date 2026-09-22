export interface RechargePackage {
  id: string;
  title: string;
  amountMinor: bigint;
  points: bigint;
  currency: 'CNY';
  active: boolean;
}

export interface PaymentOrderRecord {
  id: string;
  orderNo: string;
  userId: string;
  amountMinor: bigint;
  points: bigint;
  currency: 'CNY';
  description: string;
  status: 'PENDING' | 'PAID' | 'CLOSED' | 'REFUNDED' | 'FAILED';
  traceId: string;
  prepayId?: string;
  expiresAt?: Date;
}

export interface PaymentRepository {
  findPackage(packageId: string): Promise<RechargePackage | undefined>;
  createOrderWithSnapshot(input: {
    order: PaymentOrderRecord;
    sourcePackageId: string;
    packageTitle: string;
  }): Promise<PaymentOrderRecord>;
  markGatewayCreated(
    orderId: string,
    gateway: { prepayId: string; expiresAt: Date },
  ): Promise<PaymentOrderRecord>;
}
