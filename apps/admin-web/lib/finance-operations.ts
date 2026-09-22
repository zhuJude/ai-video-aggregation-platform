import { types as utilTypes } from 'node:util';

import {
  createOutboundRequestContext,
  parseOutboundRequestContext,
  type OutboundRequestContext,
} from './outbound-request-context';
import type { DataScope } from './permissions';
import {
  assertAdminDataScope,
  requireAdminAuthorization,
  type ServerGuardContext,
} from './server-guard';
import { isTraceId } from './trace-id';
import { isUuidV7 } from './uuid-v7';

const ORDER_STATUSES = ['PENDING', 'PAID', 'CLOSED', 'REFUNDING', 'REFUNDED', 'FAILED'] as const;
const ORDER_OPERATIONS = ['CLOSE', 'REFUND', 'RETRY_REFUND'] as const;
const ORDER_EVENTS = [
  'ORDER_CREATED',
  'PAYMENT_CREATED',
  'CALLBACK_VERIFIED',
  'PAYMENT_SUCCEEDED',
  'ORDER_CLOSED',
  'REFUND_REQUESTED',
  'REFUND_SUCCEEDED',
  'REFUND_FAILED',
] as const;
const RECONCILIATION_CATEGORIES = [
  'PLATFORM_ONLY',
  'CHANNEL_ONLY',
  'AMOUNT_MISMATCH',
  'STATUS_MISMATCH',
] as const;
const RECONCILIATION_STATUSES = ['OPEN', 'INVESTIGATING', 'REPAIRED', 'IGNORED'] as const;
const INVOICE_STATUSES = ['APPLIED', 'APPROVED', 'ISSUED', 'REJECTED'] as const;
const INVOICE_TRANSITIONS = ['APPROVED', 'ISSUED', 'REJECTED'] as const;
const CURRENCY_CODES = ['CNY'] as const;
const ACCOUNT_CODES = [
  'USER_AVAILABLE',
  'USER_FROZEN',
  'PLATFORM_LIABILITY',
  'PLATFORM_CONSUMED',
  'ADJUSTMENT',
] as const;

type ExactRecord = Readonly<Record<string, unknown>>;
type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export type InvoiceTransition = (typeof INVOICE_TRANSITIONS)[number];
export type OrderOperation = (typeof ORDER_OPERATIONS)[number];
export type ReconciliationCategory = (typeof RECONCILIATION_CATEGORIES)[number];

export type OrderTimelineEvent = Readonly<{
  actor: string;
  at: string;
  event: (typeof ORDER_EVENTS)[number];
  id: string;
  note: string;
  traceId: string;
}>;

export type FinanceOrder = Readonly<{
  allowedOperations: readonly OrderOperation[];
  amountFen: string;
  assignedAdminIds: readonly string[];
  callbackSummary: Readonly<{
    duplicate: boolean;
    eventId: string;
    status: 'MISSING' | 'VERIFIED' | 'REJECTED';
    verifiedAt: string | null;
  }>;
  currency: 'CNY';
  exceptionSummary: Readonly<{ at: string; code: string; message: string }> | null;
  id: string;
  operationPreviews: readonly Readonly<{
    expiresAt: string;
    impact: string;
    operation: OrderOperation;
    preflightToken: string;
    resultStatus: (typeof ORDER_STATUSES)[number];
  }>[];
  ownerAdminId: string | null;
  refundSummary: Readonly<{
    amountFen: string;
    currency: 'CNY';
    gatewayStatus: 'NOT_REQUESTED' | 'PENDING' | 'SUCCEEDED' | 'FAILED';
    refundId: string | null;
    walletStatus: 'NOT_REQUESTED' | 'PENDING' | 'CREDITED' | 'FAILED';
  }>;
  status: (typeof ORDER_STATUSES)[number];
  timeline: readonly OrderTimelineEvent[];
  userIdMasked: string;
  version: number;
}>;

export type OrderDirectory = Readonly<{
  items: readonly FinanceOrder[];
  nextCursor: string | null;
  sourceUpdatedAt: string;
}>;

export type LedgerEntry = Readonly<{
  account: (typeof ACCOUNT_CODES)[number];
  credit: string;
  debit: string;
  id: string;
}>;

export type LedgerTransaction = Readonly<{
  businessKey: string;
  createdAt: string;
  entries: readonly LedgerEntry[];
  id: string;
  traceId: string;
}>;

export type LedgerDirectory = Readonly<{
  items: readonly LedgerTransaction[];
  nextCursor: string | null;
  sourceUpdatedAt: string;
  totals: Readonly<{ credit: string; debit: string }>;
}>;

export type RepairPreflight = Readonly<{
  approvalPolicy: Readonly<{
    prohibitRequesterApproval: true;
    requiredApprovals: 2;
  }>;
  expiresAt: string;
  impact: string;
  preflightToken: string;
}>;

export type CompensationRequest = Readonly<{
  allowedApproval: Readonly<{
    expiresAt: string;
    impact: string;
    preflightToken: string;
    resultStatus: 'PENDING_APPROVAL' | 'APPROVED';
  }> | null;
  approvals: readonly Readonly<{ approvedAt: string; approverId: string }>[];
  id: string;
  requestedById: string;
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'POSTED' | 'REJECTED';
}>;

export type ReconciliationItem = Readonly<{
  assignedAdminIds: readonly string[];
  category: ReconciliationCategory;
  channelAmountFen: string | null;
  channelStatus: string | null;
  compensationRequest: CompensationRequest | null;
  id: string;
  ownerAdminId: string | null;
  platformAmountFen: string | null;
  platformStatus: string | null;
  repairPreflight: RepairPreflight | null;
  runbookPath: string;
  status: (typeof RECONCILIATION_STATUSES)[number];
  version: number;
}>;

export type ReconciliationDirectory = Readonly<{
  items: readonly ReconciliationItem[];
  nextCursor: string | null;
  sourceUpdatedAt: string;
}>;

export type InvoiceTransitionPreview = Readonly<{
  expiresAt: string;
  impact: string;
  preflightToken: string;
  to: InvoiceTransition;
}>;

export type InvoiceItem = Readonly<{
  allowedTransitions: readonly InvoiceTransitionPreview[];
  amountFen: string;
  assignedAdminIds: readonly string[];
  attachments: readonly Readonly<{
    fileId: string;
    mimeType: 'application/pdf' | 'image/jpeg' | 'image/png';
    name: string;
    sizeBytes: number;
    uploadedAt: string;
  }>[];
  certificate: Readonly<{ expiresAt: string; serialMasked: string }> | null;
  id: string;
  ownerAdminId: string | null;
  status: InvoiceStatus;
  taxIdentifierMasked: string;
  title: string;
  version: number;
}>;

export type InvoiceDirectory = Readonly<{
  items: readonly InvoiceItem[];
  nextCursor: string | null;
  sourceUpdatedAt: string;
}>;

type BaseRequest = Readonly<{
  requestContext: OutboundRequestContext;
  scope: DataScope;
  trustedSessionToken: string;
}>;

export interface FinanceOperationsPort {
  listOrders(
    input: BaseRequest & Readonly<{ cursor?: string; query?: string; status?: string }>,
  ): Promise<unknown>;
  getOrder(input: BaseRequest & Readonly<{ orderId: string }>): Promise<unknown>;
  executeOrderOperation(
    input: BaseRequest &
      Readonly<{
        actorId: string;
        audit: Readonly<{ idempotencyKey: string; reason: string }>;
        confirmed: true;
        expectedVersion: number;
        operation: OrderOperation;
        orderId: string;
        preflightToken: string;
      }>,
  ): Promise<unknown>;
  listLedger(input: BaseRequest & Readonly<{ cursor?: string; query?: string }>): Promise<unknown>;
  listReconciliation(
    input: BaseRequest & Readonly<{ category?: string; cursor?: string; status?: string }>,
  ): Promise<unknown>;
  getReconciliationCase(input: BaseRequest & Readonly<{ caseId: string }>): Promise<unknown>;
  createCompensationRequest(
    input: BaseRequest &
      Readonly<{
        actorId: string;
        audit: Readonly<{ idempotencyKey: string; reason: string }>;
        caseId: string;
        confirmed: true;
        expectedVersion: number;
        preflightToken: string;
        requiredApprovals: 2;
      }>,
  ): Promise<unknown>;
  approveCompensationRequest(
    input: BaseRequest &
      Readonly<{
        actorId: string;
        approverId: string;
        audit: Readonly<{ idempotencyKey: string; reason: string }>;
        caseId: string;
        confirmed: true;
        expectedVersion: number;
        preflightToken: string;
        requestId: string;
      }>,
  ): Promise<unknown>;
  listInvoices(
    input: BaseRequest & Readonly<{ cursor?: string; query?: string; status?: string }>,
  ): Promise<unknown>;
  getInvoice(input: BaseRequest & Readonly<{ invoiceId: string }>): Promise<unknown>;
  executeInvoiceTransition(
    input: BaseRequest &
      Readonly<{
        actorId: string;
        audit: Readonly<{ idempotencyKey: string; reason: string }>;
        confirmed: true;
        expectedStatus: InvoiceStatus;
        expectedVersion: number;
        invoiceId: string;
        preflightToken: string;
        transition: InvoiceTransition;
        issuanceMetadata?: Readonly<{
          attachment: InvoiceItem['attachments'][number];
          certificate: NonNullable<InvoiceItem['certificate']>;
        }>;
      }>,
  ): Promise<unknown>;
}

function exactRecord(value: unknown, keys: readonly string[]): ExactRecord | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value))
      return null;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || keys.some((key) => !ownKeys.includes(key))) return null;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function exactArray(value: unknown, maximum: number): readonly unknown[] | null {
  try {
    if (
      !Array.isArray(value) ||
      utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum
    )
      return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol' || (key !== 'length' && !/^\d+$/u.test(key))))
      return null;
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return null;
  }
}

function member<T extends readonly string[]>(value: unknown, values: T): T[number] | null {
  return typeof value === 'string' && values.includes(value) ? (value as T[number]) : null;
}

function safeText(value: unknown, maximum = 256): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\p{C}]/u.test(value)
    ? value
    : null;
}

function utc(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function unsignedIntegerString(value: unknown): string | null {
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,30})$/u.test(value) ? value : null;
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function nullableCursor(value: unknown): string | null | undefined {
  return value === null ? null : (safeText(value, 512) ?? undefined);
}

function uuidList(value: unknown): readonly string[] | null {
  const source = exactArray(value, 100);
  if (!source || !source.every(isUuidV7)) return null;
  const output = source as string[];
  if (new Set(output.map((id) => id.toLowerCase())).size !== output.length) return null;
  return Object.freeze([...output]);
}

const SENSITIVE_OPERATIONAL_TEXT =
  /(?:(?:authorization|cookie|set-cookie|wechatpay-signature|signature)\s*[:=]|(?:api[-_ ]?key|access[-_ ]?token|secret|password|private[-_ ]?key)\s*[:=]|[?&#](?:signature|token|key|secret)=)/iu;

function safeOperationalText(value: unknown, maximum: number): string | null {
  const text = safeText(value, maximum);
  return text && !SENSITIVE_OPERATIONAL_TEXT.test(text) ? text : null;
}

function parseOrderItem(value: unknown): FinanceOrder | null {
  const order = exactRecord(value, [
    'allowedOperations',
    'amountFen',
    'assignedAdminIds',
    'callbackSummary',
    'currency',
    'exceptionSummary',
    'id',
    'operationPreviews',
    'ownerAdminId',
    'refundSummary',
    'status',
    'timeline',
    'userIdMasked',
    'version',
  ]);
  const amountFen = unsignedIntegerString(order?.amountFen);
  const assignedAdminIds = uuidList(order?.assignedAdminIds);
  const currency = member(order?.currency, CURRENCY_CODES);
  const status = member(order?.status, ORDER_STATUSES);
  const userIdMasked = safeText(order?.userIdMasked, 80);
  const version = integer(order?.version, 0, Number.MAX_SAFE_INTEGER);
  const timelineSource = exactArray(order?.timeline, 200);
  const operationsSource = exactArray(order?.allowedOperations, ORDER_OPERATIONS.length);
  const previewsSource = exactArray(order?.operationPreviews, ORDER_OPERATIONS.length);
  const callback = exactRecord(order?.callbackSummary, [
    'duplicate',
    'eventId',
    'status',
    'verifiedAt',
  ]);
  const callbackStatus = member(callback?.status, ['MISSING', 'VERIFIED', 'REJECTED'] as const);
  const callbackEventId = safeOperationalText(callback?.eventId, 160);
  const callbackVerifiedAt = callback?.verifiedAt === null ? null : utc(callback?.verifiedAt);
  const refund = exactRecord(order?.refundSummary, [
    'amountFen',
    'currency',
    'gatewayStatus',
    'refundId',
    'walletStatus',
  ]);
  const refundAmountFen = unsignedIntegerString(refund?.amountFen);
  const refundCurrency = member(refund?.currency, CURRENCY_CODES);
  const gatewayStatus = member(refund?.gatewayStatus, [
    'NOT_REQUESTED',
    'PENDING',
    'SUCCEEDED',
    'FAILED',
  ] as const);
  const walletStatus = member(refund?.walletStatus, [
    'NOT_REQUESTED',
    'PENDING',
    'CREDITED',
    'FAILED',
  ] as const);
  const refundId = refund?.refundId === null ? null : safeOperationalText(refund?.refundId, 160);
  const exceptionRecord =
    order?.exceptionSummary === null
      ? null
      : exactRecord(order?.exceptionSummary, ['at', 'code', 'message']);
  const exceptionAt = exceptionRecord === null ? null : utc(exceptionRecord.at);
  const exceptionCode =
    exceptionRecord === null ? null : safeOperationalText(exceptionRecord.code, 80);
  const exceptionMessage =
    exceptionRecord === null ? null : safeOperationalText(exceptionRecord.message, 500);
  if (
    !order ||
    !amountFen ||
    !assignedAdminIds ||
    !currency ||
    !isUuidV7(order.id) ||
    (order.ownerAdminId !== null && !isUuidV7(order.ownerAdminId)) ||
    !status ||
    !userIdMasked ||
    version === null ||
    !timelineSource ||
    !operationsSource ||
    !previewsSource ||
    !callback ||
    typeof callback.duplicate !== 'boolean' ||
    !callbackStatus ||
    !callbackEventId ||
    (callback.verifiedAt !== null && !callbackVerifiedAt) ||
    (callbackStatus === 'MISSING' && callbackVerifiedAt !== null) ||
    !refund ||
    !refundAmountFen ||
    refundAmountFen !== amountFen ||
    !refundCurrency ||
    !gatewayStatus ||
    !walletStatus ||
    (refund.refundId !== null && !refundId) ||
    (gatewayStatus === 'NOT_REQUESTED' && refundId !== null) ||
    (status === 'REFUNDED' &&
      (gatewayStatus !== 'SUCCEEDED' || walletStatus !== 'CREDITED' || refundId === null)) ||
    (order.exceptionSummary !== null &&
      (!exceptionRecord || !exceptionAt || !exceptionCode || !exceptionMessage))
  )
    return null;
  const allowedOperations = operationsSource.map((operation) =>
    member(operation, ORDER_OPERATIONS),
  );
  if (
    allowedOperations.some((operation) => !operation) ||
    new Set(allowedOperations).size !== allowedOperations.length
  )
    return null;
  const operationPreviews = previewsSource.map((value) => {
    const preview = exactRecord(value, [
      'expiresAt',
      'impact',
      'operation',
      'preflightToken',
      'resultStatus',
    ]);
    const expiresAt = utc(preview?.expiresAt);
    const impact = safeOperationalText(preview?.impact, 1000);
    const operation = member(preview?.operation, ORDER_OPERATIONS);
    const preflightToken = safeText(preview?.preflightToken, 500);
    const resultStatus = member(preview?.resultStatus, ORDER_STATUSES);
    if (!preview || !expiresAt || !impact || !operation || !preflightToken || !resultStatus)
      return null;
    return Object.freeze({ expiresAt, impact, operation, preflightToken, resultStatus });
  });
  if (
    operationPreviews.some((preview) => !preview) ||
    operationPreviews.length !== allowedOperations.length ||
    new Set(operationPreviews.map((preview) => preview?.operation)).size !==
      operationPreviews.length ||
    operationPreviews.some((preview) => !allowedOperations.includes(preview?.operation ?? 'CLOSE'))
  )
    return null;
  const timeline = timelineSource.map((value) => {
    const event = exactRecord(value, ['actor', 'at', 'event', 'id', 'note', 'traceId']);
    const actor = safeOperationalText(event?.actor, 120);
    const at = utc(event?.at);
    const kind = member(event?.event, ORDER_EVENTS);
    const note = safeOperationalText(event?.note, 500);
    if (
      !event ||
      !actor ||
      !at ||
      !kind ||
      !isUuidV7(event.id) ||
      !note ||
      !isTraceId(event.traceId)
    )
      return null;
    return Object.freeze({ actor, at, event: kind, id: event.id, note, traceId: event.traceId });
  });
  if (timeline.some((event) => !event)) return null;
  for (let index = 1; index < timeline.length; index += 1) {
    if (Date.parse(timeline[index - 1]?.at ?? '') > Date.parse(timeline[index]?.at ?? ''))
      return null;
  }
  return Object.freeze({
    allowedOperations: Object.freeze(allowedOperations as OrderOperation[]),
    amountFen,
    assignedAdminIds,
    callbackSummary: Object.freeze({
      duplicate: callback.duplicate,
      eventId: callbackEventId,
      status: callbackStatus,
      verifiedAt: callbackVerifiedAt,
    }),
    currency,
    exceptionSummary:
      exceptionRecord === null
        ? null
        : Object.freeze({
            at: exceptionAt as string,
            code: exceptionCode as string,
            message: exceptionMessage as string,
          }),
    id: order.id,
    operationPreviews: Object.freeze(
      operationPreviews as FinanceOrder['operationPreviews'] extends readonly (infer T)[]
        ? T[]
        : never,
    ),
    ownerAdminId: order.ownerAdminId,
    refundSummary: Object.freeze({
      amountFen: refundAmountFen,
      currency: refundCurrency,
      gatewayStatus,
      refundId,
      walletStatus,
    }),
    status,
    timeline: Object.freeze(timeline as OrderTimelineEvent[]),
    userIdMasked,
    version,
  });
}

export function parseOrder(value: unknown): FinanceOrder {
  const order = parseOrderItem(value);
  if (!order) throw new Error('订单详情响应无效');
  return order;
}

export function parseOrderDirectory(value: unknown): OrderDirectory {
  const payload = exactRecord(value, ['items', 'nextCursor', 'sourceUpdatedAt']);
  const itemsSource = exactArray(payload?.items, 200);
  const nextCursor = nullableCursor(payload?.nextCursor);
  const sourceUpdatedAt = utc(payload?.sourceUpdatedAt);
  const items = itemsSource?.map(parseOrderItem);
  if (
    !payload ||
    !items ||
    items.some((item) => !item) ||
    nextCursor === undefined ||
    !sourceUpdatedAt
  )
    throw new Error('订单响应无效');
  return Object.freeze({
    items: Object.freeze(items as FinanceOrder[]),
    nextCursor,
    sourceUpdatedAt,
  });
}

function parseLedgerEntry(value: unknown): LedgerEntry | null {
  const entry = exactRecord(value, ['account', 'credit', 'debit', 'id']);
  const account = member(entry?.account, ACCOUNT_CODES);
  const credit = unsignedIntegerString(entry?.credit);
  const debit = unsignedIntegerString(entry?.debit);
  if (
    !entry ||
    !account ||
    !credit ||
    !debit ||
    !isUuidV7(entry.id) ||
    (credit === '0') === (debit === '0')
  )
    return null;
  return Object.freeze({ account, credit, debit, id: entry.id });
}

function parseLedgerTransaction(value: unknown): LedgerTransaction | null {
  const transaction = exactRecord(value, ['businessKey', 'createdAt', 'entries', 'id', 'traceId']);
  const businessKey = safeText(transaction?.businessKey, 200);
  const createdAt = utc(transaction?.createdAt);
  const entriesSource = exactArray(transaction?.entries, 100);
  const entries = entriesSource?.map(parseLedgerEntry);
  if (
    !transaction ||
    !businessKey ||
    !createdAt ||
    !entries ||
    entries.length < 2 ||
    entries.some((entry) => !entry) ||
    !isUuidV7(transaction.id) ||
    !isTraceId(transaction.traceId)
  )
    return null;
  const parsed = entries as LedgerEntry[];
  const debit = parsed.reduce((sum, entry) => sum + BigInt(entry.debit), 0n);
  const credit = parsed.reduce((sum, entry) => sum + BigInt(entry.credit), 0n);
  if (debit !== credit) return null;
  return Object.freeze({
    businessKey,
    createdAt,
    entries: Object.freeze(parsed),
    id: transaction.id,
    traceId: transaction.traceId,
  });
}

export function parseLedgerDirectory(value: unknown): LedgerDirectory {
  const payload = exactRecord(value, ['items', 'nextCursor', 'sourceUpdatedAt', 'totals']);
  const itemsSource = exactArray(payload?.items, 200);
  const items = itemsSource?.map(parseLedgerTransaction);
  const nextCursor = nullableCursor(payload?.nextCursor);
  const sourceUpdatedAt = utc(payload?.sourceUpdatedAt);
  const totals = exactRecord(payload?.totals, ['credit', 'debit']);
  const credit = unsignedIntegerString(totals?.credit);
  const debit = unsignedIntegerString(totals?.debit);
  if (
    !payload ||
    !items ||
    items.some((item) => !item) ||
    nextCursor === undefined ||
    !sourceUpdatedAt ||
    !totals ||
    !credit ||
    !debit ||
    BigInt(credit) !== BigInt(debit)
  )
    throw new Error('账本响应无效');
  return Object.freeze({
    items: Object.freeze(items as LedgerTransaction[]),
    nextCursor,
    sourceUpdatedAt,
    totals: Object.freeze({ credit, debit }),
  });
}

function parseRepairPreflight(value: unknown): RepairPreflight | null {
  const preview = exactRecord(value, ['approvalPolicy', 'expiresAt', 'impact', 'preflightToken']);
  const approvalPolicy = exactRecord(preview?.approvalPolicy, [
    'prohibitRequesterApproval',
    'requiredApprovals',
  ]);
  const expiresAt = utc(preview?.expiresAt);
  const impact = safeText(preview?.impact, 1000);
  const preflightToken = safeText(preview?.preflightToken, 500);
  if (
    !preview ||
    !approvalPolicy ||
    approvalPolicy.prohibitRequesterApproval !== true ||
    approvalPolicy.requiredApprovals !== 2 ||
    !expiresAt ||
    !impact ||
    !preflightToken
  )
    return null;
  return Object.freeze({
    approvalPolicy: Object.freeze({
      prohibitRequesterApproval: true,
      requiredApprovals: 2,
    }),
    expiresAt,
    impact,
    preflightToken,
  });
}

function parseCompensationRequest(value: unknown): CompensationRequest | null {
  const request = exactRecord(value, [
    'allowedApproval',
    'approvals',
    'id',
    'requestedById',
    'status',
  ]);
  const status = member(request?.status, [
    'PENDING_APPROVAL',
    'APPROVED',
    'POSTED',
    'REJECTED',
  ] as const);
  const approvalsSource = exactArray(request?.approvals, 2);
  const requestedById = request && isUuidV7(request.requestedById) ? request.requestedById : null;
  if (!request || !isUuidV7(request.id) || !requestedById || !status || !approvalsSource)
    return null;
  const approvals = approvalsSource.map((value) => {
    const approval = exactRecord(value, ['approvedAt', 'approverId']);
    const approvedAt = utc(approval?.approvedAt);
    if (!approval || !approvedAt || !isUuidV7(approval.approverId)) return null;
    return Object.freeze({ approvedAt, approverId: approval.approverId });
  });
  if (
    approvals.some((approval) => !approval) ||
    new Set(approvals.map((approval) => approval?.approverId.toLowerCase())).size !==
      approvals.length ||
    approvals.some((approval) => approval?.approverId.toLowerCase() === requestedById.toLowerCase())
  )
    return null;
  const allowedRecord =
    request.allowedApproval === null
      ? null
      : exactRecord(request.allowedApproval, [
          'expiresAt',
          'impact',
          'preflightToken',
          'resultStatus',
        ]);
  const expiresAt = allowedRecord === null ? null : utc(allowedRecord.expiresAt);
  const impact = allowedRecord === null ? null : safeText(allowedRecord.impact, 1000);
  const preflightToken =
    allowedRecord === null ? null : safeText(allowedRecord.preflightToken, 500);
  const resultStatus =
    allowedRecord === null
      ? null
      : member(allowedRecord.resultStatus, ['PENDING_APPROVAL', 'APPROVED'] as const);
  if (
    (request.allowedApproval !== null &&
      (!allowedRecord || !expiresAt || !impact || !preflightToken || !resultStatus)) ||
    (status === 'PENDING_APPROVAL' && (approvals.length > 1 || request.allowedApproval === null)) ||
    (status === 'PENDING_APPROVAL' &&
      resultStatus !== (approvals.length === 0 ? 'PENDING_APPROVAL' : 'APPROVED')) ||
    ((status === 'APPROVED' || status === 'POSTED') &&
      (approvals.length !== 2 || request.allowedApproval !== null)) ||
    (status === 'REJECTED' && request.allowedApproval !== null)
  )
    return null;
  return Object.freeze({
    allowedApproval:
      allowedRecord === null
        ? null
        : Object.freeze({
            expiresAt: expiresAt as string,
            impact: impact as string,
            preflightToken: preflightToken as string,
            resultStatus: resultStatus as 'PENDING_APPROVAL' | 'APPROVED',
          }),
    approvals: Object.freeze(approvals as Readonly<{ approvedAt: string; approverId: string }>[]),
    id: request.id,
    requestedById,
    status,
  });
}

function parseReconciliationItem(value: unknown): ReconciliationItem | null {
  const item = exactRecord(value, [
    'assignedAdminIds',
    'category',
    'channelAmountFen',
    'channelStatus',
    'compensationRequest',
    'id',
    'ownerAdminId',
    'platformAmountFen',
    'platformStatus',
    'repairPreflight',
    'runbookPath',
    'status',
    'version',
  ]);
  const assignedAdminIds = uuidList(item?.assignedAdminIds);
  const category = member(item?.category, RECONCILIATION_CATEGORIES);
  const status = member(item?.status, RECONCILIATION_STATUSES);
  const version = integer(item?.version, 0, Number.MAX_SAFE_INTEGER);
  const channelAmountFen =
    item?.channelAmountFen === null ? null : unsignedIntegerString(item?.channelAmountFen);
  const platformAmountFen =
    item?.platformAmountFen === null ? null : unsignedIntegerString(item?.platformAmountFen);
  const channelStatus = item?.channelStatus === null ? null : safeText(item?.channelStatus, 40);
  const platformStatus = item?.platformStatus === null ? null : safeText(item?.platformStatus, 40);
  const runbookPath = safeText(item?.runbookPath, 200);
  const repairPreflight =
    item?.repairPreflight === null ? null : parseRepairPreflight(item?.repairPreflight);
  const compensationRequest =
    item?.compensationRequest === null ? null : parseCompensationRequest(item?.compensationRequest);
  const channelAmountValid = item?.channelAmountFen === null || channelAmountFen !== null;
  const platformAmountValid = item?.platformAmountFen === null || platformAmountFen !== null;
  const channelStatusValid = item?.channelStatus === null || channelStatus !== null;
  const platformStatusValid = item?.platformStatus === null || platformStatus !== null;
  if (
    !item ||
    !assignedAdminIds ||
    !category ||
    !isUuidV7(item.id) ||
    (item.ownerAdminId !== null && !isUuidV7(item.ownerAdminId)) ||
    !channelAmountValid ||
    !platformAmountValid ||
    !channelStatusValid ||
    !platformStatusValid ||
    (item.repairPreflight !== null && !repairPreflight) ||
    !runbookPath ||
    (item.compensationRequest !== null && !compensationRequest) ||
    (repairPreflight !== null && compensationRequest !== null) ||
    runbookPath !== '/runbooks/wallet-payment#reconciliation' ||
    !status ||
    version === null
  )
    return null;
  if (
    (category === 'PLATFORM_ONLY' && (platformAmountFen === null || channelAmountFen !== null)) ||
    (category === 'CHANNEL_ONLY' && (channelAmountFen === null || platformAmountFen !== null)) ||
    ((category === 'AMOUNT_MISMATCH' || category === 'STATUS_MISMATCH') &&
      (channelAmountFen === null || platformAmountFen === null))
  )
    return null;
  return Object.freeze({
    assignedAdminIds,
    category,
    channelAmountFen,
    channelStatus,
    compensationRequest,
    id: item.id,
    ownerAdminId: item.ownerAdminId,
    platformAmountFen,
    platformStatus,
    repairPreflight,
    runbookPath,
    status,
    version,
  });
}

export function parseReconciliationDirectory(value: unknown): ReconciliationDirectory {
  const payload = exactRecord(value, ['items', 'nextCursor', 'sourceUpdatedAt']);
  const itemsSource = exactArray(payload?.items, 200);
  const items = itemsSource?.map(parseReconciliationItem);
  const nextCursor = nullableCursor(payload?.nextCursor);
  const sourceUpdatedAt = utc(payload?.sourceUpdatedAt);
  if (
    !payload ||
    !items ||
    items.some((item) => !item) ||
    nextCursor === undefined ||
    !sourceUpdatedAt
  )
    throw new Error('对账响应无效');
  return Object.freeze({
    items: Object.freeze(items as ReconciliationItem[]),
    nextCursor,
    sourceUpdatedAt,
  });
}

export function parseReconciliationCase(value: unknown): ReconciliationItem {
  const item = parseReconciliationItem(value);
  if (!item) throw new Error('对账案例响应无效');
  return item;
}

function transitionIsValid(from: InvoiceStatus, to: InvoiceTransition): boolean {
  return (
    (from === 'APPLIED' && (to === 'APPROVED' || to === 'REJECTED')) ||
    (from === 'APPROVED' && to === 'ISSUED')
  );
}

function parseInvoiceItem(value: unknown): InvoiceItem | null {
  const item = exactRecord(value, [
    'allowedTransitions',
    'amountFen',
    'assignedAdminIds',
    'attachments',
    'certificate',
    'id',
    'ownerAdminId',
    'status',
    'taxIdentifierMasked',
    'title',
    'version',
  ]);
  const amountFen = unsignedIntegerString(item?.amountFen);
  const assignedAdminIds = uuidList(item?.assignedAdminIds);
  const status = member(item?.status, INVOICE_STATUSES);
  const taxIdentifierMasked = safeText(item?.taxIdentifierMasked, 40);
  const title = safeText(item?.title, 160);
  const version = integer(item?.version, 0, Number.MAX_SAFE_INTEGER);
  const transitionsSource = exactArray(item?.allowedTransitions, 4);
  const attachmentsSource = exactArray(item?.attachments, 20);
  if (
    !item ||
    !amountFen ||
    !assignedAdminIds ||
    !isUuidV7(item.id) ||
    (item.ownerAdminId !== null && !isUuidV7(item.ownerAdminId)) ||
    !status ||
    !taxIdentifierMasked ||
    !/^[A-Za-z0-9*]{8,40}$/u.test(taxIdentifierMasked) ||
    !taxIdentifierMasked.includes('*') ||
    !title ||
    version === null ||
    !transitionsSource ||
    !attachmentsSource
  )
    return null;
  const allowedTransitions = transitionsSource.map((value) => {
    const transition = exactRecord(value, ['expiresAt', 'impact', 'preflightToken', 'to']);
    const expiresAt = utc(transition?.expiresAt);
    const impact = safeText(transition?.impact, 1000);
    const preflightToken = safeText(transition?.preflightToken, 500);
    const to = member(transition?.to, INVOICE_TRANSITIONS);
    if (
      !transition ||
      !expiresAt ||
      !impact ||
      !preflightToken ||
      !to ||
      !transitionIsValid(status, to)
    )
      return null;
    return Object.freeze({ expiresAt, impact, preflightToken, to });
  });
  if (
    allowedTransitions.some((transition) => !transition) ||
    new Set(allowedTransitions.map((transition) => transition?.to)).size !==
      allowedTransitions.length
  )
    return null;
  const attachments = attachmentsSource.map((value) => {
    const attachment = exactRecord(value, [
      'fileId',
      'mimeType',
      'name',
      'sizeBytes',
      'uploadedAt',
    ]);
    const mimeType = member(attachment?.mimeType, [
      'application/pdf',
      'image/jpeg',
      'image/png',
    ] as const);
    const name = safeText(attachment?.name, 200);
    const sizeBytes = integer(attachment?.sizeBytes, 1, 20 * 1024 * 1024);
    const uploadedAt = utc(attachment?.uploadedAt);
    if (
      !attachment ||
      !isUuidV7(attachment.fileId) ||
      !mimeType ||
      !name ||
      !sizeBytes ||
      !uploadedAt
    )
      return null;
    return Object.freeze({ fileId: attachment.fileId, mimeType, name, sizeBytes, uploadedAt });
  });
  if (attachments.some((attachment) => !attachment)) return null;
  const certificateRecord =
    item.certificate === null ? null : exactRecord(item.certificate, ['expiresAt', 'serialMasked']);
  const certificateExpiresAt = certificateRecord === null ? null : utc(certificateRecord.expiresAt);
  const certificateSerial =
    certificateRecord === null ? null : safeText(certificateRecord.serialMasked, 32);
  if (
    item.certificate !== null &&
    (!certificateRecord ||
      !certificateExpiresAt ||
      !certificateSerial ||
      !/^\*{4,12}[A-Za-z0-9]{2,8}$/u.test(certificateSerial))
  )
    return null;
  if ((status === 'ISSUED') !== (certificateRecord !== null)) return null;
  return Object.freeze({
    allowedTransitions: Object.freeze(allowedTransitions as InvoiceTransitionPreview[]),
    amountFen,
    assignedAdminIds,
    attachments: Object.freeze(
      attachments as InvoiceItem['attachments'] extends readonly (infer T)[] ? T[] : never,
    ),
    certificate:
      certificateRecord === null
        ? null
        : Object.freeze({
            expiresAt: certificateExpiresAt as string,
            serialMasked: certificateSerial as string,
          }),
    id: item.id,
    ownerAdminId: item.ownerAdminId,
    status,
    taxIdentifierMasked,
    title,
    version,
  });
}

export function parseInvoiceDirectory(value: unknown): InvoiceDirectory {
  const payload = exactRecord(value, ['items', 'nextCursor', 'sourceUpdatedAt']);
  const itemsSource = exactArray(payload?.items, 200);
  const items = itemsSource?.map(parseInvoiceItem);
  const nextCursor = nullableCursor(payload?.nextCursor);
  const sourceUpdatedAt = utc(payload?.sourceUpdatedAt);
  if (
    !payload ||
    !items ||
    items.some((item) => !item) ||
    nextCursor === undefined ||
    !sourceUpdatedAt
  )
    throw new Error('发票响应无效');
  return Object.freeze({
    items: Object.freeze(items as InvoiceItem[]),
    nextCursor,
    sourceUpdatedAt,
  });
}

export function parseInvoice(value: unknown): InvoiceItem {
  const item = parseInvoiceItem(value);
  if (!item) throw new Error('发票详情响应无效');
  return item;
}

function optionalFilter(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = safeText(value, maximum);
  if (!parsed) throw new Error('财务筛选条件无效');
  return parsed;
}

function base(auth: Awaited<ReturnType<typeof requireAdminAuthorization>>): BaseRequest {
  return {
    requestContext: createOutboundRequestContext(),
    scope: auth.claims.dataScope,
    trustedSessionToken: auth.trustedSessionToken,
  };
}

export async function loadOrderDirectory(
  dependencies: Readonly<{
    context?: ServerGuardContext;
    cursor?: string;
    port: FinanceOperationsPort;
    query?: string;
    status?: string;
  }>,
): Promise<OrderDirectory> {
  const auth = await requireAdminAuthorization('finance:read', dependencies.context);
  if (auth.claims.dataScope !== 'ALL') throw new Error('全局财务数据仅允许全部数据范围');
  const cursor = optionalFilter(dependencies.cursor, 512);
  const query = optionalFilter(dependencies.query, 120);
  const status = optionalFilter(dependencies.status, 40);
  return parseOrderDirectory(
    await dependencies.port.listOrders({
      ...base(auth),
      ...(cursor ? { cursor } : {}),
      ...(query ? { query } : {}),
      ...(status ? { status } : {}),
    }),
  );
}

export async function loadLedgerDirectory(
  dependencies: Readonly<{
    context?: ServerGuardContext;
    cursor?: string;
    port: FinanceOperationsPort;
    query?: string;
  }>,
): Promise<LedgerDirectory> {
  const auth = await requireAdminAuthorization('finance:read', dependencies.context);
  if (auth.claims.dataScope !== 'ALL') throw new Error('全局财务数据仅允许全部数据范围');
  const cursor = optionalFilter(dependencies.cursor, 512);
  const query = optionalFilter(dependencies.query, 160);
  return parseLedgerDirectory(
    await dependencies.port.listLedger({
      ...base(auth),
      ...(cursor ? { cursor } : {}),
      ...(query ? { query } : {}),
    }),
  );
}

export async function loadReconciliationDirectory(
  dependencies: Readonly<{
    category?: string;
    context?: ServerGuardContext;
    cursor?: string;
    port: FinanceOperationsPort;
    status?: string;
  }>,
): Promise<ReconciliationDirectory> {
  const auth = await requireAdminAuthorization('finance:read', dependencies.context);
  if (auth.claims.dataScope === 'OWN') throw new Error('财务案件不支持本人数据范围');
  const category = optionalFilter(dependencies.category, 40);
  const cursor = optionalFilter(dependencies.cursor, 512);
  const status = optionalFilter(dependencies.status, 40);
  const result = parseReconciliationDirectory(
    await dependencies.port.listReconciliation({
      ...base(auth),
      ...(category ? { category } : {}),
      ...(cursor ? { cursor } : {}),
      ...(status ? { status } : {}),
    }),
  );
  if (auth.claims.dataScope === 'ASSIGNED') {
    for (const item of result.items) assertAdminDataScope(auth.claims, item);
  }
  return result;
}

export async function loadInvoiceDirectory(
  dependencies: Readonly<{
    context?: ServerGuardContext;
    cursor?: string;
    port: FinanceOperationsPort;
    query?: string;
    status?: string;
  }>,
): Promise<InvoiceDirectory> {
  const auth = await requireAdminAuthorization('finance:read', dependencies.context);
  if (auth.claims.dataScope === 'OWN') throw new Error('财务案件不支持本人数据范围');
  const cursor = optionalFilter(dependencies.cursor, 512);
  const query = optionalFilter(dependencies.query, 160);
  const status = optionalFilter(dependencies.status, 40);
  const result = parseInvoiceDirectory(
    await dependencies.port.listInvoices({
      ...base(auth),
      ...(cursor ? { cursor } : {}),
      ...(query ? { query } : {}),
      ...(status ? { status } : {}),
    }),
  );
  if (auth.claims.dataScope === 'ASSIGNED') {
    for (const item of result.items) assertAdminDataScope(auth.claims, item);
  }
  return result;
}

function formText(form: FormData, key: string, maximum: number): string | null {
  const value = form.get(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return safeText(trimmed, maximum);
}

function formOperationalText(form: FormData, key: string, maximum: number): string | null {
  const text = formText(form, key, maximum);
  return text ? safeOperationalText(text, maximum) : null;
}

function formVersion(form: FormData): number | null {
  const value = formText(form, 'expectedVersion', 16);
  if (!value || !/^\d{1,16}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseInvoiceMutationReceipt(
  value: unknown,
  invoiceId: string,
  idempotencyKey: string,
  expectedInvoiceStatus: InvoiceStatus,
): Readonly<Record<string, unknown>> {
  const receipt = exactRecord(value, [
    'auditRecordId',
    'idempotencyKey',
    'invoiceId',
    'ok',
    'requestId',
    'status',
    'version',
  ]);
  if (
    !receipt ||
    receipt.ok !== true ||
    receipt.invoiceId !== invoiceId ||
    receipt.idempotencyKey !== idempotencyKey ||
    !isUuidV7(receipt.auditRecordId) ||
    !isUuidV7(receipt.requestId) ||
    integer(receipt.version, 0, Number.MAX_SAFE_INTEGER) === null ||
    !member(receipt.status, INVOICE_STATUSES) ||
    receipt.status !== expectedInvoiceStatus
  )
    throw new Error('财务操作回执无效');
  return Object.freeze({ ...receipt });
}

function parseCompensationMutationReceipt(
  value: unknown,
  expected: Readonly<{
    caseId: string;
    compensationRequestId?: string;
    idempotencyKey: string;
    operation: 'APPROVE_COMPENSATION_REQUEST' | 'CREATE_COMPENSATION_REQUEST';
    status: 'APPROVED' | 'PENDING_APPROVAL';
  }>,
): Readonly<Record<string, unknown>> {
  const receipt = exactRecord(value, [
    'auditRecordId',
    'caseId',
    'compensationRequestId',
    'idempotencyKey',
    'ok',
    'operation',
    'requestId',
    'status',
    'version',
  ]);
  if (
    !receipt ||
    receipt.ok !== true ||
    receipt.caseId !== expected.caseId ||
    receipt.idempotencyKey !== expected.idempotencyKey ||
    receipt.operation !== expected.operation ||
    receipt.status !== expected.status ||
    !isUuidV7(receipt.compensationRequestId) ||
    (expected.compensationRequestId !== undefined &&
      receipt.compensationRequestId !== expected.compensationRequestId) ||
    !isUuidV7(receipt.auditRecordId) ||
    !isUuidV7(receipt.requestId) ||
    integer(receipt.version, 0, Number.MAX_SAFE_INTEGER) === null
  )
    throw new Error('财务操作回执无效');
  return Object.freeze({ ...receipt });
}

function parseOrderOperationReceipt(
  value: unknown,
  expected: Readonly<{
    idempotencyKey: string;
    operation: OrderOperation;
    orderId: string;
    resultStatus: FinanceOrder['status'];
  }>,
): Readonly<Record<string, unknown>> {
  const receipt = exactRecord(value, [
    'auditRecordId',
    'idempotencyKey',
    'ok',
    'operation',
    'orderId',
    'requestId',
    'status',
    'version',
  ]);
  if (
    !receipt ||
    receipt.ok !== true ||
    receipt.idempotencyKey !== expected.idempotencyKey ||
    receipt.operation !== expected.operation ||
    receipt.orderId !== expected.orderId ||
    receipt.status !== expected.resultStatus ||
    !isUuidV7(receipt.auditRecordId) ||
    !isUuidV7(receipt.requestId) ||
    integer(receipt.version, 0, Number.MAX_SAFE_INTEGER) === null
  )
    throw new Error('订单操作回执无效');
  return Object.freeze({ ...receipt });
}

const orderOperationPermission: Readonly<Record<OrderOperation, string>> = Object.freeze({
  CLOSE: 'finance:order-close',
  REFUND: 'finance:refund-create',
  RETRY_REFUND: 'finance:refund-retry',
});

export function createOrderOperationAction(
  dependencies: Readonly<{
    context?: ServerGuardContext;
    port: FinanceOperationsPort;
  }>,
) {
  return async (form: FormData) => {
    if (
      [...form.keys()].some(
        (key) =>
          ![
            'action',
            'confirmed',
            'expectedVersion',
            'intentId',
            'orderId',
            'preflightToken',
            'reason',
          ].includes(key),
      )
    )
      throw new Error('订单操作字段无效');
    const operation = member(formText(form, 'action', 24), ORDER_OPERATIONS);
    if (!operation) throw new Error('订单操作字段无效');
    const auth = await requireAdminAuthorization(
      orderOperationPermission[operation],
      dependencies.context,
    );
    if (auth.claims.dataScope !== 'ALL') throw new Error('订单操作仅允许全部数据范围');
    const orderId = formText(form, 'orderId', 64);
    const intentId = formText(form, 'intentId', 64);
    const preflightToken = formText(form, 'preflightToken', 500);
    const reason = formOperationalText(form, 'reason', 200);
    const expectedVersion = formVersion(form);
    if (
      !isUuidV7(orderId) ||
      !isUuidV7(intentId) ||
      !preflightToken ||
      !reason ||
      expectedVersion === null ||
      form.get('confirmed') !== 'true'
    )
      throw new Error('订单操作字段无效');
    const requestBase = base(auth);
    const order = parseOrder(await dependencies.port.getOrder({ ...requestBase, orderId }));
    const preview = order.operationPreviews.find((item) => item.operation === operation);
    if (
      order.version !== expectedVersion ||
      !order.allowedOperations.includes(operation) ||
      !preview ||
      preview.preflightToken !== preflightToken ||
      Date.parse(preview.expiresAt) <= Date.now()
    )
      throw new Error('订单操作预检已失效');
    const result = await dependencies.port.executeOrderOperation({
      ...requestBase,
      actorId: auth.claims.subjectId,
      audit: { idempotencyKey: intentId, reason },
      confirmed: true,
      expectedVersion,
      operation,
      orderId,
      preflightToken,
    });
    return parseOrderOperationReceipt(result, {
      idempotencyKey: intentId,
      operation,
      orderId,
      resultStatus: preview.resultStatus,
    });
  };
}

export function createCompensationRequestAction(
  dependencies: Readonly<{
    context?: ServerGuardContext;
    port: FinanceOperationsPort;
  }>,
) {
  return async (form: FormData) => {
    if (
      [...form.keys()].some(
        (key) =>
          ![
            'caseId',
            'confirmed',
            'expectedVersion',
            'intentId',
            'preflightToken',
            'reason',
          ].includes(key),
      )
    )
      throw new Error('补偿分录字段无效');
    const auth = await requireAdminAuthorization(
      'finance:reconciliation-repair',
      dependencies.context,
    );
    if (auth.claims.dataScope === 'OWN') throw new Error('财务案件不支持本人数据范围');
    const caseId = formText(form, 'caseId', 64);
    const intentId = formText(form, 'intentId', 64);
    const preflightToken = formText(form, 'preflightToken', 500);
    const reason = formOperationalText(form, 'reason', 200);
    const expectedVersion = formVersion(form);
    if (
      !isUuidV7(caseId) ||
      !isUuidV7(intentId) ||
      !preflightToken ||
      !reason ||
      expectedVersion === null ||
      form.get('confirmed') !== 'true'
    )
      throw new Error('补偿分录字段无效');
    const requestBase = base(auth);
    const item = parseReconciliationCase(
      await dependencies.port.getReconciliationCase({ ...requestBase, caseId }),
    );
    assertAdminDataScope(auth.claims, item);
    const preview = item.repairPreflight;
    if (
      item.version !== expectedVersion ||
      item.status === 'REPAIRED' ||
      item.compensationRequest !== null ||
      !preview ||
      preview.preflightToken !== preflightToken ||
      Date.parse(preview.expiresAt) <= Date.now()
    )
      throw new Error('补偿分录预检已失效');
    const result = await dependencies.port.createCompensationRequest({
      ...requestBase,
      actorId: auth.claims.subjectId,
      audit: { idempotencyKey: intentId, reason },
      caseId,
      confirmed: true,
      expectedVersion,
      preflightToken,
      requiredApprovals: 2,
    });
    return parseCompensationMutationReceipt(result, {
      caseId,
      idempotencyKey: intentId,
      operation: 'CREATE_COMPENSATION_REQUEST',
      status: 'PENDING_APPROVAL',
    });
  };
}

export function createCompensationApprovalAction(
  dependencies: Readonly<{
    context?: ServerGuardContext;
    port: FinanceOperationsPort;
  }>,
) {
  return async (form: FormData) => {
    if (
      [...form.keys()].some(
        (key) =>
          ![
            'caseId',
            'confirmed',
            'expectedVersion',
            'intentId',
            'preflightToken',
            'reason',
            'requestId',
          ].includes(key),
      )
    )
      throw new Error('补偿审批字段无效');
    const auth = await requireAdminAuthorization(
      'finance:reconciliation-approve',
      dependencies.context,
    );
    if (auth.claims.dataScope === 'OWN') throw new Error('财务案件不支持本人数据范围');
    const caseId = formText(form, 'caseId', 64);
    const requestId = formText(form, 'requestId', 64);
    const intentId = formText(form, 'intentId', 64);
    const preflightToken = formText(form, 'preflightToken', 500);
    const reason = formOperationalText(form, 'reason', 200);
    const expectedVersion = formVersion(form);
    if (
      !isUuidV7(caseId) ||
      !isUuidV7(requestId) ||
      !isUuidV7(intentId) ||
      !preflightToken ||
      !reason ||
      expectedVersion === null ||
      form.get('confirmed') !== 'true'
    )
      throw new Error('补偿审批字段无效');
    const requestBase = base(auth);
    const item = parseReconciliationCase(
      await dependencies.port.getReconciliationCase({ ...requestBase, caseId }),
    );
    assertAdminDataScope(auth.claims, item);
    const request = item.compensationRequest;
    const preview = request?.allowedApproval;
    if (
      item.version !== expectedVersion ||
      request?.id !== requestId ||
      request.status !== 'PENDING_APPROVAL' ||
      !preview ||
      preview.preflightToken !== preflightToken ||
      Date.parse(preview.expiresAt) <= Date.now()
    )
      throw new Error('补偿审批预检已失效');
    if (request.requestedById.toLowerCase() === auth.claims.subjectId.toLowerCase()) {
      throw new Error('补偿申请人不可审批自己的申请');
    }
    if (
      request.approvals.some(
        (approval) => approval.approverId.toLowerCase() === auth.claims.subjectId.toLowerCase(),
      )
    ) {
      throw new Error('同一复核人不可重复审批');
    }
    if (request.approvals.length >= 2) throw new Error('补偿审批已完成');
    const result = await dependencies.port.approveCompensationRequest({
      ...requestBase,
      actorId: auth.claims.subjectId,
      approverId: auth.claims.subjectId,
      audit: { idempotencyKey: intentId, reason },
      caseId,
      confirmed: true,
      expectedVersion,
      preflightToken,
      requestId,
    });
    return parseCompensationMutationReceipt(result, {
      caseId,
      compensationRequestId: requestId,
      idempotencyKey: intentId,
      operation: 'APPROVE_COMPENSATION_REQUEST',
      status: preview.resultStatus,
    });
  };
}

export const invoiceTransitionPermission: Readonly<Record<InvoiceTransition, string>> =
  Object.freeze({
    APPROVED: 'finance:invoice-review',
    ISSUED: 'finance:invoice-issue',
    REJECTED: 'finance:invoice-reject',
  });

function parseIssuanceMetadata(
  form: FormData,
): NonNullable<
  Parameters<FinanceOperationsPort['executeInvoiceTransition']>[0]['issuanceMetadata']
> {
  const certificateSerialMasked = formText(form, 'certificateSerialMasked', 32);
  const certificateExpiresAt = formText(form, 'certificateExpiresAt', 40);
  const attachmentFileId = formText(form, 'attachmentFileId', 64);
  const attachmentName = formText(form, 'attachmentName', 200);
  const attachmentMimeType = member(formText(form, 'attachmentMimeType', 32), [
    'application/pdf',
    'image/jpeg',
    'image/png',
  ] as const);
  const attachmentSizeBytesText = formText(form, 'attachmentSizeBytes', 12);
  const attachmentUploadedAt = formText(form, 'attachmentUploadedAt', 40);
  const attachmentSizeBytes =
    attachmentSizeBytesText && /^\d{1,12}$/u.test(attachmentSizeBytesText)
      ? Number(attachmentSizeBytesText)
      : null;
  if (
    !certificateSerialMasked ||
    !/^\*{4,12}[A-Za-z0-9]{2,8}$/u.test(certificateSerialMasked) ||
    !certificateExpiresAt ||
    !utc(certificateExpiresAt) ||
    !isUuidV7(attachmentFileId) ||
    !attachmentName ||
    !safeOperationalText(attachmentName, 200) ||
    !attachmentMimeType ||
    !Number.isSafeInteger(attachmentSizeBytes) ||
    (attachmentSizeBytes as number) < 1 ||
    (attachmentSizeBytes as number) > 20 * 1024 * 1024 ||
    !attachmentUploadedAt ||
    !utc(attachmentUploadedAt)
  )
    throw new Error('发票签发元数据无效');
  return Object.freeze({
    attachment: Object.freeze({
      fileId: attachmentFileId,
      mimeType: attachmentMimeType,
      name: attachmentName,
      sizeBytes: attachmentSizeBytes as number,
      uploadedAt: attachmentUploadedAt,
    }),
    certificate: Object.freeze({
      expiresAt: certificateExpiresAt,
      serialMasked: certificateSerialMasked,
    }),
  });
}

export function createInvoiceTransitionAction(
  dependencies: Readonly<{
    context?: ServerGuardContext;
    port: FinanceOperationsPort;
  }>,
) {
  return async (form: FormData) => {
    const transition = member(formText(form, 'to', 24), INVOICE_TRANSITIONS);
    if (!transition) throw new Error('发票迁移字段无效');
    const allowedKeys = [
      'confirmed',
      'expectedVersion',
      'from',
      'intentId',
      'invoiceId',
      'preflightToken',
      'reason',
      'to',
      ...(transition === 'ISSUED'
        ? [
            'attachmentFileId',
            'attachmentMimeType',
            'attachmentName',
            'attachmentSizeBytes',
            'attachmentUploadedAt',
            'certificateExpiresAt',
            'certificateSerialMasked',
          ]
        : []),
    ];
    if ([...form.keys()].some((key) => !allowedKeys.includes(key)))
      throw new Error('发票迁移字段无效');
    const auth = await requireAdminAuthorization(
      invoiceTransitionPermission[transition],
      dependencies.context,
    );
    if (auth.claims.dataScope === 'OWN') throw new Error('财务案件不支持本人数据范围');
    const invoiceId = formText(form, 'invoiceId', 64);
    const from = member(formText(form, 'from', 24), INVOICE_STATUSES);
    const intentId = formText(form, 'intentId', 64);
    const preflightToken = formText(form, 'preflightToken', 500);
    const reason = formOperationalText(form, 'reason', 200);
    const expectedVersion = formVersion(form);
    if (
      !isUuidV7(invoiceId) ||
      !from ||
      !isUuidV7(intentId) ||
      !preflightToken ||
      !reason ||
      expectedVersion === null ||
      form.get('confirmed') !== 'true' ||
      !transitionIsValid(from, transition)
    )
      throw new Error('发票迁移字段无效');
    const issuanceMetadata = transition === 'ISSUED' ? parseIssuanceMetadata(form) : undefined;
    const requestBase = base(auth);
    const invoice = parseInvoice(await dependencies.port.getInvoice({ ...requestBase, invoiceId }));
    assertAdminDataScope(auth.claims, invoice);
    const preview = invoice.allowedTransitions.find((item) => item.to === transition);
    if (
      invoice.status !== from ||
      invoice.version !== expectedVersion ||
      !preview ||
      preview.preflightToken !== preflightToken ||
      Date.parse(preview.expiresAt) <= Date.now()
    )
      throw new Error('发票迁移预检已失效');
    const result = await dependencies.port.executeInvoiceTransition({
      ...requestBase,
      actorId: auth.claims.subjectId,
      audit: { idempotencyKey: intentId, reason },
      confirmed: true,
      expectedStatus: from,
      expectedVersion,
      invoiceId,
      preflightToken,
      transition,
      ...(issuanceMetadata ? { issuanceMetadata } : {}),
    });
    return parseInvoiceMutationReceipt(result, invoiceId, intentId, transition);
  };
}

export function assertFinanceRequestContext(value: unknown): OutboundRequestContext {
  return parseOutboundRequestContext(value);
}
