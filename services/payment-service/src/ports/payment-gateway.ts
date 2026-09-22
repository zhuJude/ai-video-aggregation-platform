export interface VerifiedPayment {
  transactionId: string;
  orderNo: string;
  merchantId: string;
  amountMinor: bigint;
  currency: string;
  paidAt: Date;
}

export interface PaymentGateway {
  createNativeOrder(input: {
    orderNo: string;
    amountMinor: bigint;
    description: string;
    notifyUrl: string;
  }): Promise<{ prepayId: string; expiresAt: Date }>;
  verifyCallback(headers: Record<string, string>, body: string): Promise<VerifiedPayment>;
  queryOrder(orderNo: string): Promise<VerifiedPayment | undefined>;
  closeOrder(orderNo: string): Promise<void>;
  refund(input: {
    orderNo: string;
    refundNo: string;
    amountMinor: bigint;
    reason: string;
  }): Promise<{ refundId: string }>;
  downloadBill(date: string): Promise<NodeJS.ReadableStream>;
}
