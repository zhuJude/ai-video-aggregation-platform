import {
  MinorAmountSchema,
  PointsStringSchema,
  UtcDateTimeSchema,
  UuidSchema,
} from '@repo/contracts/common';
import { LedgerKindSchema as WalletTransactionKindSchema } from '@repo/contracts/wallet';

import type {
  AssetFilters,
  AssetListItem,
  AssetPage,
  InvoiceCandidate,
  InvoiceCandidatePage,
  InvoiceHistoryItem,
  InvoiceStatus,
  LedgerTransaction,
  OrderCreateResult,
  OrderPage,
  PaymentPayload,
  RechargeOrderStatus,
  RechargeOrderView,
  SignedAssetUrl,
  WalletFilters,
  WalletPage,
  UploadSessionGrant,
} from './types';

export function classifyCommerceCommandError(error: unknown): 'DEFINITIVE_FAILURE' | 'UNCERTAIN' {
  return typeof error === 'object' &&
    error !== null &&
    'outcome' in error &&
    error.outcome === 'DEFINITIVE_FAILURE'
    ? 'DEFINITIVE_FAILURE'
    : 'UNCERTAIN';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(code);
  return value;
}

function exact(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(code);
}

function text(value: unknown, code: string, max = 240): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max)
    throw new Error(code);
  return value;
}

function points(value: unknown, code: string): string {
  const parsed = PointsStringSchema.safeParse(value);
  if (!parsed.success) throw new Error(code);
  return parsed.data;
}

function minor(value: unknown, code: string): string {
  const parsed = MinorAmountSchema.safeParse(value);
  if (!parsed.success) throw new Error(code);
  return parsed.data;
}

function instant(value: unknown, code: string): string {
  const parsed = UtcDateTimeSchema.safeParse(value);
  if (!parsed.success) throw new Error(code);
  return parsed.data;
}

function uuid(value: unknown, code: string): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) throw new Error(code);
  return parsed.data;
}

function cursorPageInfo(value: unknown): AssetPage['pageInfo'] {
  const page = record(value, 'INVALID_PAGE_INFO');
  exact(page, ['nextCursor', 'previousCursor'], 'INVALID_PAGE_INFO');
  return {
    ...(page.nextCursor === undefined
      ? {}
      : { nextCursor: text(page.nextCursor, 'INVALID_CURSOR', 512) }),
    ...(page.previousCursor === undefined
      ? {}
      : { previousCursor: text(page.previousCursor, 'INVALID_CURSOR', 512) }),
  };
}

export function formatPoints(value: string): string {
  return BigInt(points(value, 'INVALID_POINTS')).toLocaleString('en-US');
}

export function formatMinorAmount(value: string, currency: 'CNY'): string {
  void currency;
  const amount = BigInt(minor(value, 'INVALID_MINOR_AMOUNT'));
  const units = amount / 100n;
  const cents = (amount % 100n).toString().padStart(2, '0');
  return `¥${units.toLocaleString('en-US')}.${cents}`;
}

const CHINA_DATE = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Shanghai',
});

export function formatChinaDate(value: string): string {
  return CHINA_DATE.format(new Date(instant(value, 'INVALID_INSTANT')));
}

function parseAsset(value: unknown): AssetListItem {
  const asset = record(value, 'INVALID_ASSET');
  exact(
    asset,
    ['id', 'kind', 'name', 'mimeType', 'sizeBytes', 'createdAt', 'posterAlt'],
    'INVALID_ASSET',
  );
  if (asset.kind !== 'UPLOAD' && asset.kind !== 'RESULT') throw new Error('INVALID_ASSET');
  if (
    typeof asset.mimeType !== 'string' ||
    !/^(?:image\/(?:jpeg|png|webp)|video\/(?:mp4|webm|quicktime))$/.test(asset.mimeType)
  )
    throw new Error('INVALID_ASSET');
  const sizeBytes = points(asset.sizeBytes, 'INVALID_ASSET');
  if (BigInt(sizeBytes) <= 0n) throw new Error('INVALID_ASSET');
  return {
    id: uuid(asset.id, 'INVALID_ASSET'),
    kind: asset.kind,
    name: text(asset.name, 'INVALID_ASSET', 120),
    mimeType: asset.mimeType,
    sizeBytes,
    createdAt: instant(asset.createdAt, 'INVALID_ASSET'),
    posterAlt: text(asset.posterAlt, 'INVALID_ASSET', 180),
  };
}

export function parseAssetPage(value: unknown): AssetPage {
  const page = record(value, 'INVALID_ASSET_PAGE');
  exact(page, ['items', 'pageInfo'], 'INVALID_ASSET_PAGE');
  if (!Array.isArray(page.items)) throw new Error('INVALID_ASSET_PAGE');
  return { items: page.items.map(parseAsset), pageInfo: cursorPageInfo(page.pageInfo) };
}

export function parseSignedAssetUrl(value: unknown): SignedAssetUrl {
  const grant = record(value, 'INVALID_SIGNED_ASSET_URL');
  exact(grant, ['url', 'expiresAt'], 'INVALID_SIGNED_ASSET_URL');
  return {
    url: text(grant.url, 'INVALID_SIGNED_ASSET_URL', 2_048),
    expiresAt: instant(grant.expiresAt, 'INVALID_SIGNED_ASSET_URL'),
  };
}

export function parseUploadSessionGrant(value: unknown): UploadSessionGrant {
  const grant = record(value, 'INVALID_UPLOAD_GRANT');
  exact(grant, ['id', 'url', 'headers', 'expiresAt'], 'INVALID_UPLOAD_GRANT');
  const headers = record(grant.headers, 'INVALID_UPLOAD_GRANT');
  exact(headers, ['content-type', 'x-upload-content-length'], 'INVALID_UPLOAD_GRANT');
  const contentType = text(headers['content-type'], 'INVALID_UPLOAD_GRANT', 80);
  const size = points(headers['x-upload-content-length'], 'INVALID_UPLOAD_GRANT');
  const url = text(grant.url, 'INVALID_UPLOAD_GRANT', 4_096);
  if (
    !/^(?:image\/(?:jpeg|png|webp)|video\/(?:mp4|webm|quicktime))$/.test(contentType) ||
    BigInt(size) <= 0n ||
    !/^\/api\/commerce\/mock-uploads\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(url)
  ) {
    throw new Error('INVALID_UPLOAD_GRANT');
  }
  return {
    id: uuid(grant.id, 'INVALID_UPLOAD_GRANT'),
    url,
    headers: { 'content-type': contentType, 'x-upload-content-length': size },
    expiresAt: instant(grant.expiresAt, 'INVALID_UPLOAD_GRANT'),
  };
}

export function parseUploadReceiptResponse(value: unknown): { readonly receipt: string } {
  const response = record(value, 'INVALID_UPLOAD_RECEIPT');
  exact(response, ['receipt'], 'INVALID_UPLOAD_RECEIPT');
  return { receipt: text(response.receipt, 'INVALID_UPLOAD_RECEIPT', 4_096) };
}

export function usableSignedUrl(
  value: SignedAssetUrl,
  now: number = Date.now(),
): string | undefined {
  const grant = parseSignedAssetUrl(value);
  const expiresAt = Date.parse(grant.expiresAt);
  if (expiresAt <= now + 5_000 || expiresAt > now + 15 * 60_000) return undefined;
  if (/^\/api\/commerce\/mock-assets\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(grant.url)) {
    return grant.url;
  }
  try {
    const url = new URL(grant.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseLedgerTransaction(value: unknown): LedgerTransaction {
  const item = record(value, 'INVALID_WALLET_TRANSACTION');
  exact(
    item,
    ['id', 'type', 'direction', 'status', 'points', 'occurredAt', 'reference'],
    'INVALID_WALLET_TRANSACTION',
  );
  const transactionKind = WalletTransactionKindSchema.safeParse(item.type);
  if (!transactionKind.success) throw new Error('INVALID_WALLET_TRANSACTION');
  if (item.direction !== 'CREDIT' && item.direction !== 'DEBIT' && item.direction !== 'TRANSFER')
    throw new Error('INVALID_WALLET_TRANSACTION');
  if (item.status !== 'POSTED') throw new Error('INVALID_WALLET_TRANSACTION');
  let reference: LedgerTransaction['reference'];
  if (item.reference !== undefined) {
    const ref = record(item.reference, 'INVALID_WALLET_TRANSACTION');
    exact(ref, ['kind', 'id', 'label'], 'INVALID_WALLET_TRANSACTION');
    if (ref.kind !== 'TASK' && ref.kind !== 'ORDER') throw new Error('INVALID_WALLET_TRANSACTION');
    reference = {
      kind: ref.kind,
      id: text(ref.id, 'INVALID_WALLET_TRANSACTION', 120),
      label: text(ref.label, 'INVALID_WALLET_TRANSACTION', 80),
    };
  }
  return {
    id: text(item.id, 'INVALID_WALLET_TRANSACTION', 120),
    type: transactionKind.data,
    direction: item.direction,
    status: 'POSTED',
    points: points(item.points, 'INVALID_WALLET_TRANSACTION'),
    occurredAt: instant(item.occurredAt, 'INVALID_WALLET_TRANSACTION'),
    ...(reference ? { reference } : {}),
  };
}

export function parseWalletPage(value: unknown): WalletPage {
  const page = record(value, 'INVALID_WALLET_PAGE');
  exact(page, ['balance', 'transactions', 'pageInfo'], 'INVALID_WALLET_PAGE');
  const balance = record(page.balance, 'INVALID_WALLET_BALANCE');
  exact(
    balance,
    ['available', 'frozen', 'totalRecharged', 'totalConsumed'],
    'INVALID_WALLET_BALANCE',
  );
  if (!Array.isArray(page.transactions)) throw new Error('INVALID_WALLET_PAGE');
  return {
    balance: {
      available: points(balance.available, 'INVALID_WALLET_BALANCE'),
      frozen: points(balance.frozen, 'INVALID_WALLET_BALANCE'),
      totalRecharged: points(balance.totalRecharged, 'INVALID_WALLET_BALANCE'),
      totalConsumed: points(balance.totalConsumed, 'INVALID_WALLET_BALANCE'),
    },
    transactions: page.transactions.map(parseLedgerTransaction),
    pageInfo: cursorPageInfo(page.pageInfo),
  };
}

const ORDER_STATUSES = new Set<RechargeOrderStatus>([
  'PENDING',
  'PAID',
  'CLOSED',
  'REFUNDED',
  'FAILED',
]);

function parseOrder(value: unknown): RechargeOrderView {
  const order = record(value, 'INVALID_ORDER');
  exact(
    order,
    ['id', 'amountMinor', 'currency', 'points', 'status', 'createdAt', 'expiresAt', 'paidAt'],
    'INVALID_ORDER',
  );
  if (order.currency !== 'CNY' || !ORDER_STATUSES.has(order.status as RechargeOrderStatus))
    throw new Error('INVALID_ORDER');
  return {
    id: uuid(order.id, 'INVALID_ORDER'),
    amountMinor: minor(order.amountMinor, 'INVALID_ORDER'),
    currency: 'CNY',
    points: points(order.points, 'INVALID_ORDER'),
    status: order.status as RechargeOrderStatus,
    createdAt: instant(order.createdAt, 'INVALID_ORDER'),
    ...(order.expiresAt === undefined
      ? {}
      : { expiresAt: instant(order.expiresAt, 'INVALID_ORDER') }),
    ...(order.paidAt === undefined ? {} : { paidAt: instant(order.paidAt, 'INVALID_ORDER') }),
  };
}

export function parseOrderPage(value: unknown): OrderPage {
  const page = record(value, 'INVALID_ORDER_PAGE');
  exact(page, ['packages', 'customAmount', 'items', 'pageInfo'], 'INVALID_ORDER_PAGE');
  if (!Array.isArray(page.packages) || !Array.isArray(page.items))
    throw new Error('INVALID_ORDER_PAGE');
  const custom = record(page.customAmount, 'INVALID_ORDER_PAGE');
  exact(custom, ['minMinor', 'maxMinor', 'stepMinor'], 'INVALID_ORDER_PAGE');
  const minMinor = minor(custom.minMinor, 'INVALID_ORDER_PAGE');
  const maxMinor = minor(custom.maxMinor, 'INVALID_ORDER_PAGE');
  const stepMinor = minor(custom.stepMinor, 'INVALID_ORDER_PAGE');
  if (BigInt(minMinor) <= 0n || BigInt(maxMinor) < BigInt(minMinor) || BigInt(stepMinor) <= 0n)
    throw new Error('INVALID_ORDER_PAGE');
  return {
    packages: page.packages.map((value) => {
      const item = record(value, 'INVALID_RECHARGE_PACKAGE');
      exact(item, ['id', 'amountMinor', 'currency', 'points'], 'INVALID_RECHARGE_PACKAGE');
      if (item.currency !== 'CNY') throw new Error('INVALID_RECHARGE_PACKAGE');
      return {
        id: text(item.id, 'INVALID_RECHARGE_PACKAGE', 80),
        amountMinor: minor(item.amountMinor, 'INVALID_RECHARGE_PACKAGE'),
        currency: 'CNY' as const,
        points: points(item.points, 'INVALID_RECHARGE_PACKAGE'),
      };
    }),
    customAmount: {
      minMinor,
      maxMinor,
      stepMinor,
    },
    items: page.items.map(parseOrder),
    pageInfo: cursorPageInfo(page.pageInfo),
  };
}

function parsePaymentPayload(value: unknown): PaymentPayload {
  const payment = record(value, 'INVALID_PAYMENT_PAYLOAD');
  if (payment.environment === 'MOCK') {
    exact(payment, ['environment', 'kind', 'expiresAt'], 'INVALID_PAYMENT_PAYLOAD');
    if (payment.kind !== 'DISPLAY_ONLY') throw new Error('INVALID_PAYMENT_PAYLOAD');
    return {
      environment: 'MOCK',
      kind: 'DISPLAY_ONLY',
      expiresAt: instant(payment.expiresAt, 'INVALID_PAYMENT_PAYLOAD'),
    };
  }
  exact(payment, ['environment', 'kind', 'qrCodeUrl', 'expiresAt'], 'INVALID_PAYMENT_PAYLOAD');
  if (payment.environment !== 'LIVE' || payment.kind !== 'QR_CODE')
    throw new Error('INVALID_PAYMENT_PAYLOAD');
  const urlValue = text(payment.qrCodeUrl, 'INVALID_PAYMENT_PAYLOAD', 2_048);
  try {
    const url = new URL(urlValue);
    const trustedHost =
      url.hostname === 'pay.weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com');
    if (url.protocol !== 'https:' || !trustedHost || url.username || url.password || url.hash)
      throw new Error('INVALID_PAYMENT_PAYLOAD');
  } catch {
    throw new Error('INVALID_PAYMENT_PAYLOAD');
  }
  return {
    environment: 'LIVE',
    kind: 'QR_CODE',
    qrCodeUrl: urlValue,
    expiresAt: instant(payment.expiresAt, 'INVALID_PAYMENT_PAYLOAD'),
  };
}

export function parseOrderCreateResult(value: unknown): OrderCreateResult {
  const result = record(value, 'INVALID_ORDER_RESULT');
  exact(result, ['order', 'payment'], 'INVALID_ORDER_RESULT');
  const order = parseOrder(result.order);
  const payment = parsePaymentPayload(result.payment);
  if (order.status !== 'PENDING' || !order.expiresAt || order.expiresAt !== payment.expiresAt)
    throw new Error('INVALID_PAYMENT_PAYLOAD');
  return { order, payment };
}

function parseCandidate(value: unknown): InvoiceCandidate {
  const item = record(value, 'INVALID_INVOICE_CANDIDATE');
  exact(
    item,
    ['orderId', 'paidAt', 'amountMinor', 'currency', 'points'],
    'INVALID_INVOICE_CANDIDATE',
  );
  if (item.currency !== 'CNY') throw new Error('INVALID_INVOICE_CANDIDATE');
  return {
    orderId: uuid(item.orderId, 'INVALID_INVOICE_CANDIDATE'),
    paidAt: instant(item.paidAt, 'INVALID_INVOICE_CANDIDATE'),
    amountMinor: minor(item.amountMinor, 'INVALID_INVOICE_CANDIDATE'),
    currency: 'CNY',
    points: points(item.points, 'INVALID_INVOICE_CANDIDATE'),
  };
}

const INVOICE_STATUSES = new Set<InvoiceStatus>([
  'SUBMITTED',
  'REVIEWING',
  'APPROVED',
  'ISSUED',
  'REJECTED',
]);

function invoiceStatus(value: unknown): InvoiceStatus {
  if (!INVOICE_STATUSES.has(value as InvoiceStatus)) throw new Error('INVALID_INVOICE_HISTORY');
  return value as InvoiceStatus;
}

function parseInvoiceHistory(value: unknown): InvoiceHistoryItem {
  const item = record(value, 'INVALID_INVOICE_HISTORY');
  exact(
    item,
    ['id', 'amountMinor', 'currency', 'title', 'status', 'updatedAt', 'statusHistory'],
    'INVALID_INVOICE_HISTORY',
  );
  if (item.currency !== 'CNY' || !Array.isArray(item.statusHistory))
    throw new Error('INVALID_INVOICE_HISTORY');
  return {
    id: uuid(item.id, 'INVALID_INVOICE_HISTORY'),
    amountMinor: minor(item.amountMinor, 'INVALID_INVOICE_HISTORY'),
    currency: 'CNY',
    title: text(item.title, 'INVALID_INVOICE_HISTORY', 100),
    status: invoiceStatus(item.status),
    updatedAt: instant(item.updatedAt, 'INVALID_INVOICE_HISTORY'),
    statusHistory: item.statusHistory.map((raw) => {
      const status = record(raw, 'INVALID_INVOICE_HISTORY');
      exact(status, ['status', 'occurredAt', 'note'], 'INVALID_INVOICE_HISTORY');
      return {
        status: invoiceStatus(status.status),
        occurredAt: instant(status.occurredAt, 'INVALID_INVOICE_HISTORY'),
        ...(status.note === undefined
          ? {}
          : { note: text(status.note, 'INVALID_INVOICE_HISTORY', 240) }),
      };
    }),
  };
}

export function parseInvoiceCandidatePage(value: unknown): InvoiceCandidatePage {
  const page = record(value, 'INVALID_INVOICE_PAGE');
  exact(page, ['items', 'history'], 'INVALID_INVOICE_PAGE');
  if (!Array.isArray(page.items) || !Array.isArray(page.history))
    throw new Error('INVALID_INVOICE_PAGE');
  const items = page.items.map(parseCandidate);
  if (new Set(items.map((item) => item.orderId)).size !== items.length)
    throw new Error('DUPLICATE_INVOICE_CANDIDATE');
  return { items, history: page.history.map(parseInvoiceHistory) };
}

export function parseAssetFilters(
  value: Record<string, string | string[] | undefined>,
): AssetFilters {
  const scalar = (key: string) => {
    const raw = value[key];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  };
  const kind = scalar('kind');
  const mediaType = scalar('mediaType');
  if (kind && kind !== 'UPLOAD' && kind !== 'RESULT') throw new Error('INVALID_ASSET_FILTER');
  if (mediaType && mediaType !== 'IMAGE' && mediaType !== 'VIDEO')
    throw new Error('INVALID_ASSET_FILTER');
  return {
    ...(kind ? { kind } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(scalar('query') ? { query: scalar('query') } : {}),
    ...(scalar('cursor') ? { cursor: scalar('cursor') } : {}),
  } as AssetFilters;
}

export function parseWalletFilters(
  value: Record<string, string | string[] | undefined>,
): WalletFilters {
  const cursor = typeof value.cursor === 'string' && value.cursor ? value.cursor : undefined;
  const type = typeof value.type === 'string' && value.type ? value.type : undefined;
  const parsedType = type ? WalletTransactionKindSchema.safeParse(type) : undefined;
  if (parsedType && !parsedType.success) throw new Error('INVALID_WALLET_FILTER');
  return {
    ...(cursor ? { cursor } : {}),
    ...(parsedType?.success ? { type: parsedType.data } : {}),
  };
}
