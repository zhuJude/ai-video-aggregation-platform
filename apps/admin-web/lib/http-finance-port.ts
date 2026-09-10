import {
  DEFAULT_UPSTREAM_DEADLINE_MS,
  SafeHttpRequestError,
  fetchWithDeadline,
  isValidDeadline,
} from './http-deadline';
import type { FinanceOperationsPort } from './finance-operations';
import { isOutboundRequestContext, type OutboundRequestContext } from './outbound-request-context';
import {
  consumeTechnicalFailure,
  createSafeTelemetryEvent,
  defaultSafeTelemetry,
  recordTechnicalFailure,
  type SafeTelemetryOperation,
  type SafeTelemetryPort,
} from './safe-telemetry';

type Environment = Readonly<{
  apiUrl?: string | undefined;
  kmsIdentityReference?: string | undefined;
}>;
type Options = Readonly<{
  deadlineMs?: number;
  fetchImpl?: typeof fetch;
  telemetry?: SafeTelemetryPort;
}>;

const KMS_REFERENCE = /^kms:\/\/[A-Za-z0-9][A-Za-z0-9/_-]{2,255}$/u;

export function createHttpFinanceOperationsPort(
  environment: Environment = {
    apiUrl: process.env.ADMIN_OPERATIONS_API_URL,
    kmsIdentityReference: process.env.ADMIN_OPERATIONS_KMS_IDENTITY_REF,
  },
  {
    deadlineMs = DEFAULT_UPSTREAM_DEADLINE_MS,
    fetchImpl = fetch,
    telemetry = defaultSafeTelemetry,
  }: Options = {},
): FinanceOperationsPort {
  if (
    !environment.apiUrl ||
    !environment.kmsIdentityReference ||
    !KMS_REFERENCE.test(environment.kmsIdentityReference)
  ) {
    throw recordTechnicalFailure(
      telemetry,
      createSafeTelemetryEvent('operations.config', 'INVALID_CONFIG'),
      new Error('财务服务配置无效'),
    );
  }
  const baseUrl = new URL(environment.apiUrl);
  if (
    baseUrl.protocol !== 'https:' ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    (baseUrl.pathname !== '/' && baseUrl.pathname !== '')
  ) {
    throw recordTechnicalFailure(
      telemetry,
      createSafeTelemetryEvent('operations.config', 'INVALID_CONFIG'),
      new Error('财务服务配置无效'),
    );
  }
  if (!isValidDeadline(deadlineMs)) throw new Error('财务服务配置无效');
  const kmsReference = environment.kmsIdentityReference;

  async function request(
    input: Readonly<{
      requestContext: OutboundRequestContext;
      scope: string;
      trustedSessionToken: string;
    }>,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
    operation: SafeTelemetryOperation = 'operations.finance.orders-read',
  ): Promise<unknown> {
    if (
      !isOutboundRequestContext(input.requestContext) ||
      !input.trustedSessionToken ||
      input.trustedSessionToken.length > 3000 ||
      !['ALL', 'ASSIGNED', 'OWN'].includes(input.scope)
    ) {
      throw recordTechnicalFailure(
        telemetry,
        createSafeTelemetryEvent(operation, 'DOWNSTREAM_DENIED'),
        new Error('受信财务请求上下文无效'),
      );
    }
    const headers = new Headers({
      Accept: 'application/json',
      'X-Admin-Data-Scope': input.scope,
      'X-Admin-Session-Token': input.trustedSessionToken,
      'X-Correlation-ID': input.requestContext.correlationId,
      'X-Service-Identity-Kms-Ref': kmsReference,
      'X-Trace-ID': input.requestContext.traceId,
    });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (idempotencyKey !== undefined) headers.set('Idempotency-Key', idempotencyKey);
    const init: RequestInit =
      body === undefined
        ? { cache: 'no-store', headers, method: 'GET' }
        : { body: JSON.stringify(body), cache: 'no-store', headers, method: 'POST' };
    try {
      return await fetchWithDeadline(
        fetchImpl,
        new URL(path, baseUrl),
        init,
        deadlineMs,
        async (response, signal) => {
          if (!response.ok) {
            throw recordTechnicalFailure(
              telemetry,
              createSafeTelemetryEvent(
                operation,
                response.status === 401 || response.status === 403
                  ? 'DOWNSTREAM_DENIED'
                  : 'UPSTREAM_FAILURE',
                input.requestContext,
              ),
              new Error('财务服务拒绝请求'),
            );
          }
          try {
            return (await response.json()) as unknown;
          } catch (error) {
            if (signal.aborted) throw error;
            throw recordTechnicalFailure(
              telemetry,
              createSafeTelemetryEvent(operation, 'MALFORMED_RESPONSE', input.requestContext),
              new Error('财务服务响应无效'),
            );
          }
        },
      );
    } catch (error) {
      if (consumeTechnicalFailure(error)) throw error;
      const reason = error instanceof SafeHttpRequestError ? error.reason : 'NETWORK_FAILURE';
      throw recordTechnicalFailure(
        telemetry,
        createSafeTelemetryEvent(operation, reason, input.requestContext),
        error instanceof Error ? error : new Error('财务服务请求失败'),
      );
    }
  }

  function queryPath(path: string, fields: Readonly<Record<string, string | undefined>>): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (value) query.set(key, value);
    }
    return query.size > 0 ? `${path}?${query.toString()}` : path;
  }

  return Object.freeze({
    approveCompensationRequest: (
      input: Parameters<FinanceOperationsPort['approveCompensationRequest']>[0],
    ) =>
      request(
        input,
        `/admin/finance/reconciliation/${encodeURIComponent(input.caseId)}/compensation-requests/${encodeURIComponent(input.requestId)}/approvals`,
        {
          actorId: input.actorId,
          approverId: input.approverId,
          audit: input.audit,
          confirmed: input.confirmed,
          expectedVersion: input.expectedVersion,
          preflightToken: input.preflightToken,
        },
        input.audit.idempotencyKey,
        'operations.finance.approval',
      ),
    createCompensationRequest: (
      input: Parameters<FinanceOperationsPort['createCompensationRequest']>[0],
    ) =>
      request(
        input,
        `/admin/finance/reconciliation/${encodeURIComponent(input.caseId)}/compensation-requests`,
        {
          actorId: input.actorId,
          audit: input.audit,
          confirmed: input.confirmed,
          expectedVersion: input.expectedVersion,
          preflightToken: input.preflightToken,
          requiredApprovals: input.requiredApprovals,
        },
        input.audit.idempotencyKey,
        'operations.finance.compensation-request',
      ),
    executeInvoiceTransition: (
      input: Parameters<FinanceOperationsPort['executeInvoiceTransition']>[0],
    ) =>
      request(
        input,
        `/admin/finance/invoices/${encodeURIComponent(input.invoiceId)}/transitions`,
        {
          actorId: input.actorId,
          audit: input.audit,
          confirmed: input.confirmed,
          expectedStatus: input.expectedStatus,
          expectedVersion: input.expectedVersion,
          preflightToken: input.preflightToken,
          transition: input.transition,
          ...(input.issuanceMetadata ? { issuanceMetadata: input.issuanceMetadata } : {}),
        },
        input.audit.idempotencyKey,
        'operations.finance.invoice-transition',
      ),
    executeOrderOperation: (input: Parameters<FinanceOperationsPort['executeOrderOperation']>[0]) =>
      request(
        input,
        `/admin/finance/orders/${encodeURIComponent(input.orderId)}/actions`,
        {
          actorId: input.actorId,
          audit: input.audit,
          confirmed: input.confirmed,
          expectedVersion: input.expectedVersion,
          operation: input.operation,
          preflightToken: input.preflightToken,
        },
        input.audit.idempotencyKey,
        'operations.finance.order-operation',
      ),
    getInvoice: (input: Parameters<FinanceOperationsPort['getInvoice']>[0]) =>
      request(
        input,
        `/admin/finance/invoices/${encodeURIComponent(input.invoiceId)}`,
        undefined,
        undefined,
        'operations.finance.invoice-detail-read',
      ),
    getReconciliationCase: (input: Parameters<FinanceOperationsPort['getReconciliationCase']>[0]) =>
      request(
        input,
        `/admin/finance/reconciliation/${encodeURIComponent(input.caseId)}`,
        undefined,
        undefined,
        'operations.finance.reconciliation-case-read',
      ),
    getOrder: (input: Parameters<FinanceOperationsPort['getOrder']>[0]) =>
      request(
        input,
        `/admin/finance/orders/${encodeURIComponent(input.orderId)}`,
        undefined,
        undefined,
        'operations.finance.order-detail-read',
      ),
    listInvoices: (input: Parameters<FinanceOperationsPort['listInvoices']>[0]) =>
      request(
        input,
        queryPath('/admin/finance/invoices', {
          cursor: input.cursor,
          query: input.query,
          status: input.status,
        }),
        undefined,
        undefined,
        'operations.finance.invoices-read',
      ),
    listLedger: (input: Parameters<FinanceOperationsPort['listLedger']>[0]) =>
      request(
        input,
        queryPath('/admin/finance/ledger', {
          cursor: input.cursor,
          query: input.query,
        }),
        undefined,
        undefined,
        'operations.finance.ledger-read',
      ),
    listOrders: (input: Parameters<FinanceOperationsPort['listOrders']>[0]) =>
      request(
        input,
        queryPath('/admin/finance/orders', {
          cursor: input.cursor,
          query: input.query,
          status: input.status,
        }),
        undefined,
        undefined,
        'operations.finance.orders-read',
      ),
    listReconciliation: (input: Parameters<FinanceOperationsPort['listReconciliation']>[0]) =>
      request(
        input,
        queryPath('/admin/finance/reconciliation', {
          category: input.category,
          cursor: input.cursor,
          status: input.status,
        }),
        undefined,
        undefined,
        'operations.finance.reconciliation-read',
      ),
  });
}
