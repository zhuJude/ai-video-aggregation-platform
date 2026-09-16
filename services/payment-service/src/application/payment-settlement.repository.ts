import type { VerifiedPayment } from '../ports/payment-gateway.js';

export interface WalletCreditPort {
  credit(input: {
    userId: string;
    points: bigint;
    businessKey: string;
    traceId: string;
  }): Promise<{ ledgerTransactionId: string }>;
}

export interface PaymentSettlement {
  accepted: boolean;
  orderId: string;
  orderNo: string;
  userId: string;
  points: bigint;
  traceId: string;
}

export interface PaymentSettlementRepository {
  acceptPayment(input: {
    callbackId: string;
    rawBodyHash: string;
    expectedMerchantId: string;
    payment: VerifiedPayment;
    source: 'CALLBACK' | 'ACTIVE_QUERY';
  }): Promise<PaymentSettlement>;
  findPendingBefore(cutoff: Date, limit: number): Promise<readonly string[]>;
}
