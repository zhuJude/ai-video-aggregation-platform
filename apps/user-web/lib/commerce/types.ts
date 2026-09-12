export type CursorPageInfo = Readonly<{
  nextCursor?: string;
  previousCursor?: string;
}>;

export type AssetKind = 'UPLOAD' | 'RESULT';

export interface AssetListItem {
  readonly id: string;
  readonly kind: AssetKind;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: string;
  readonly createdAt: string;
  readonly posterAlt: string;
}

export interface AssetPage {
  readonly items: readonly AssetListItem[];
  readonly pageInfo: CursorPageInfo;
}

export interface AssetFilters {
  readonly cursor?: string;
  readonly kind?: AssetKind;
  readonly mediaType?: 'IMAGE' | 'VIDEO';
  readonly query?: string;
}

export interface SignedAssetUrl {
  readonly url: string;
  readonly expiresAt: string;
}

export interface UploadFileDescriptor {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

export interface WalletBalanceView {
  readonly available: string;
  readonly frozen: string;
  readonly totalRecharged: string;
  readonly totalConsumed: string;
}

export type LedgerTransactionType =
  'RECHARGE' | 'RESERVE' | 'SETTLE' | 'RELEASE' | 'REFUND' | 'ADJUST';

export interface LedgerTransaction {
  readonly id: string;
  readonly type: LedgerTransactionType;
  readonly direction: 'CREDIT' | 'DEBIT' | 'TRANSFER';
  readonly status: 'POSTED';
  readonly points: string;
  readonly occurredAt: string;
  readonly reference?: {
    readonly kind: 'TASK' | 'ORDER';
    readonly id: string;
    readonly label: string;
  };
}

export interface WalletPage {
  readonly balance: WalletBalanceView;
  readonly transactions: readonly LedgerTransaction[];
  readonly pageInfo: CursorPageInfo;
}

export interface WalletFilters {
  readonly cursor?: string;
  readonly type?: LedgerTransactionType;
}

export interface RechargePackage {
  readonly id: string;
  readonly amountMinor: string;
  readonly currency: 'CNY';
  readonly points: string;
}

export type RechargeOrderStatus = 'PENDING' | 'PAID' | 'CLOSED' | 'REFUNDED' | 'FAILED';

export interface RechargeOrderView {
  readonly id: string;
  readonly amountMinor: string;
  readonly currency: 'CNY';
  readonly points: string;
  readonly status: RechargeOrderStatus;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly paidAt?: string;
}

export interface OrderPage {
  readonly packages: readonly RechargePackage[];
  readonly customAmount: {
    readonly minMinor: string;
    readonly maxMinor: string;
    readonly stepMinor: string;
  };
  readonly items: readonly RechargeOrderView[];
  readonly pageInfo: CursorPageInfo;
}

export interface PaymentPayload {
  readonly kind: 'QR_CODE';
  readonly qrCodeUrl: string;
  readonly expiresAt: string;
}

export interface OrderCreateResult {
  readonly order: RechargeOrderView;
  readonly payment: PaymentPayload;
}

export interface InvoiceCandidate {
  readonly orderId: string;
  readonly paidAt: string;
  readonly amountMinor: string;
  readonly currency: 'CNY';
  readonly points: string;
}

export type InvoiceStatus = 'SUBMITTED' | 'REVIEWING' | 'APPROVED' | 'ISSUED' | 'REJECTED';

export interface InvoiceHistoryItem {
  readonly id: string;
  readonly amountMinor: string;
  readonly currency: 'CNY';
  readonly title: string;
  readonly status: InvoiceStatus;
  readonly updatedAt: string;
  readonly statusHistory: readonly {
    readonly status: InvoiceStatus;
    readonly occurredAt: string;
    readonly note?: string;
  }[];
}

export interface InvoiceCandidatePage {
  readonly items: readonly InvoiceCandidate[];
  readonly history: readonly InvoiceHistoryItem[];
}

export interface CommandContext {
  readonly ownerId: string;
  readonly idempotencyKey: string;
}

export interface CommerceGateway {
  listAssets(filters: AssetFilters, context: { readonly ownerId: string }): Promise<unknown>;
  requestAssetAccess(
    assetId: string,
    purpose: 'PREVIEW' | 'DOWNLOAD',
    context: { readonly ownerId: string },
  ): Promise<unknown>;
  uploadAsset(
    file: UploadFileDescriptor,
    options: {
      readonly idempotencyKey: string;
      readonly ownerId: string;
      readonly signal: AbortSignal;
      readonly onProgress: (percentage: number) => void;
    },
  ): Promise<unknown>;
  renameAsset(assetId: string, name: string, context: CommandContext): Promise<unknown>;
  deleteAsset(assetId: string, context: CommandContext): Promise<unknown>;
  getWallet(filters: WalletFilters, context: { readonly ownerId: string }): Promise<unknown>;
  listOrders(
    filters: { readonly cursor?: string; readonly status?: RechargeOrderStatus },
    context: { readonly ownerId: string },
  ): Promise<unknown>;
  createOrder(
    input: { readonly packageId?: string; readonly customAmountMinor?: string },
    context: CommandContext,
  ): Promise<unknown>;
  listInvoiceCandidates(context: { readonly ownerId: string }): Promise<unknown>;
  createInvoice(
    input: {
      readonly orderIds: readonly string[];
      readonly title: string;
      readonly taxNumber: string;
      readonly email: string;
    },
    context: CommandContext,
  ): Promise<unknown>;
}

export type CommandOutcome = 'DEFINITIVE_FAILURE' | 'UNCERTAIN' | 'SESSION_REFRESH_REQUIRED';
