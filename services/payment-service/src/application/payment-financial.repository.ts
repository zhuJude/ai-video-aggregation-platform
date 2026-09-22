export type RefundRecordStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
export type InvoiceRecordStatus = 'APPLIED' | 'APPROVED' | 'ISSUED' | 'REJECTED';

export interface FinancialOrder {
  id: string;
  orderNo: string;
  userId: string;
  amountMinor: bigint;
  points: bigint;
  currency: string;
  status: string;
  traceId: string;
  transactionId?: string;
  paidAt?: Date;
}

export interface RefundRecord {
  id: string;
  orderId: string;
  refundNo: string;
  amountMinor: bigint;
  reason: string;
  status: RefundRecordStatus;
  walletBusinessKey: string;
  traceId: string;
  gatewayRefundId?: string;
  lastError?: string;
}

export interface InvoiceRecord {
  id: string;
  userId: string;
  orderId: string;
  amountMinor: bigint;
  title: string;
  taxNo?: string;
  status: InvoiceRecordStatus;
  rejectionReason?: string;
}

export type ReconciliationDifferenceKind =
  | 'CHANNEL_ONLY'
  | 'PLATFORM_ONLY'
  | 'TRANSACTION_ID_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'STATUS_MISMATCH';

export interface ReconciliationDifference {
  kind: ReconciliationDifferenceKind;
  orderNo: string;
  severity: 'P0' | 'P1';
  channelTransactionId?: string;
  platformTransactionId?: string;
  channelAmountMinor?: bigint;
  platformAmountMinor?: bigint;
}

export interface PaymentFinancialRepository {
  findFinancialOrder(orderId: string): Promise<FinancialOrder | undefined>;
  createOrGetRefund(input: RefundRecord): Promise<RefundRecord>;
  markRefundProcessing(refundId: string): Promise<RefundRecord>;
  markRefundFailed(refundId: string, error: string): Promise<RefundRecord>;
  completeRefund(refundId: string, gatewayRefundId: string): Promise<RefundRecord>;
  listPaidOrders(from: Date, to: Date): Promise<readonly FinancialOrder[]>;
  saveReconciliation(input: {
    id: string;
    billDate: Date;
    differences: readonly ReconciliationDifference[];
  }): Promise<void>;
  createInvoice(input: InvoiceRecord): Promise<InvoiceRecord>;
  findInvoice(invoiceId: string): Promise<InvoiceRecord | undefined>;
  updateInvoice(input: {
    invoiceId: string;
    expectedStatus: readonly InvoiceRecordStatus[];
    nextStatus: InvoiceRecordStatus;
    rejectionReason?: string;
    issuedAt?: Date;
  }): Promise<InvoiceRecord>;
}
