import {
  DEFAULT_UPSTREAM_DEADLINE_MS,
  SafeHttpRequestError,
  fetchWithDeadline,
  isValidDeadline,
} from './http-deadline';
import type { GovernanceOperationsPort } from './governance-operations';
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

export function createHttpGovernanceOperationsPort(
  environment: Environment = {
    apiUrl: process.env.ADMIN_OPERATIONS_API_URL,
    kmsIdentityReference: process.env.ADMIN_OPERATIONS_KMS_IDENTITY_REF,
  },
  {
    deadlineMs = DEFAULT_UPSTREAM_DEADLINE_MS,
    fetchImpl = fetch,
    telemetry = defaultSafeTelemetry,
  }: Options = {},
): GovernanceOperationsPort {
  if (
    !environment.apiUrl ||
    !environment.kmsIdentityReference ||
    !KMS_REFERENCE.test(environment.kmsIdentityReference)
  ) {
    throw recordTechnicalFailure(
      telemetry,
      createSafeTelemetryEvent('operations.config', 'INVALID_CONFIG'),
      new Error('治理服务配置无效'),
    );
  }
  const baseUrl = new URL(environment.apiUrl);
  if (
    baseUrl.protocol !== 'https:' ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    (baseUrl.pathname !== '/' && baseUrl.pathname !== '') ||
    !isValidDeadline(deadlineMs)
  ) {
    throw recordTechnicalFailure(
      telemetry,
      createSafeTelemetryEvent('operations.config', 'INVALID_CONFIG'),
      new Error('治理服务配置无效'),
    );
  }
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
    operation: SafeTelemetryOperation = 'operations.governance.read',
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
        new Error('受信治理请求上下文无效'),
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
          if (!response.ok)
            throw recordTechnicalFailure(
              telemetry,
              createSafeTelemetryEvent(
                operation,
                response.status === 401 || response.status === 403
                  ? 'DOWNSTREAM_DENIED'
                  : 'UPSTREAM_FAILURE',
                input.requestContext,
              ),
              new Error('治理服务拒绝请求'),
            );
          try {
            return (await response.json()) as unknown;
          } catch (error) {
            if (signal.aborted) throw error;
            throw recordTechnicalFailure(
              telemetry,
              createSafeTelemetryEvent(operation, 'MALFORMED_RESPONSE', input.requestContext),
              new Error('治理服务响应无效'),
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
        error instanceof Error ? error : new Error('治理服务请求失败'),
      );
    }
  }

  function pathWithQuery(path: string, fields: Readonly<Record<string, string | undefined>>) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) if (value) query.set(key, value);
    return query.size > 0 ? `${path}?${query.toString()}` : path;
  }

  return Object.freeze({
    addInternalNote: (input: Parameters<GovernanceOperationsPort['addInternalNote']>[0]) =>
      request(
        input,
        `/admin/tickets/${encodeURIComponent(input.ticketId)}/internal-notes`,
        {
          actorId: input.actorId,
          attachmentFileIds: input.attachmentFileIds,
          audit: input.audit,
          body: input.body,
          confirmed: input.confirmed,
          expectedVersion: input.expectedVersion,
          preflightToken: input.preflightToken,
        },
        input.audit.idempotencyKey,
        'operations.governance.mutation',
      ),
    addPublicReply: (input: Parameters<GovernanceOperationsPort['addPublicReply']>[0]) =>
      request(
        input,
        `/admin/tickets/${encodeURIComponent(input.ticketId)}/public-replies`,
        {
          actorId: input.actorId,
          attachmentFileIds: input.attachmentFileIds,
          audit: input.audit,
          body: input.body,
          confirmed: input.confirmed,
          expectedVersion: input.expectedVersion,
          preflightToken: input.preflightToken,
        },
        input.audit.idempotencyKey,
        'operations.governance.mutation',
      ),
    executeContentOperation: (
      input: Parameters<GovernanceOperationsPort['executeContentOperation']>[0],
    ) =>
      request(
        input,
        `/admin/content/${encodeURIComponent(input.contentId)}/operations`,
        {
          actorId: input.actorId,
          audit: input.audit,
          confirmed: input.confirmed,
          expectedVersion: input.expectedVersion,
          operation: input.operation,
          preflightToken: input.preflightToken,
        },
        input.audit.idempotencyKey,
        'operations.governance.mutation',
      ),
    executeSystemOperation: (
      input: Parameters<GovernanceOperationsPort['executeSystemOperation']>[0],
    ) =>
      request(
        input,
        `/admin/system/resources/${encodeURIComponent(input.resourceId)}/operations`,
        {
          actorId: input.actorId,
          audit: input.audit,
          confirmed: input.confirmed,
          expectedVersion: input.expectedVersion,
          operation: input.operation,
          preflightToken: input.preflightToken,
          ...(input.draft ? { draft: input.draft } : {}),
        },
        input.audit.idempotencyKey,
        'operations.governance.mutation',
      ),
    getAuditExportPreview: (
      input: Parameters<GovernanceOperationsPort['getAuditExportPreview']>[0],
    ) =>
      request(
        input,
        pathWithQuery('/admin/audit/export-preview', {
          action: input.action,
          actor: input.actor,
          format: input.format,
          from: input.from,
          resource: input.resource,
          to: input.to,
          traceId: input.traceId,
        }),
        undefined,
        undefined,
        'operations.governance.export',
      ),
    getContent: (input: Parameters<GovernanceOperationsPort['getContent']>[0]) =>
      request(input, `/admin/content/${encodeURIComponent(input.contentId)}`),
    getIamDirectory: (input: Parameters<GovernanceOperationsPort['getIamDirectory']>[0]) =>
      request(input, '/admin/iam'),
    getSystemSnapshot: (input: Parameters<GovernanceOperationsPort['getSystemSnapshot']>[0]) =>
      request(input, '/admin/system'),
    getTicket: (input: Parameters<GovernanceOperationsPort['getTicket']>[0]) =>
      request(input, `/admin/tickets/${encodeURIComponent(input.ticketId)}`),
    listAudit: (input: Parameters<GovernanceOperationsPort['listAudit']>[0]) =>
      request(
        input,
        pathWithQuery('/admin/audit', {
          action: input.action,
          actor: input.actor,
          cursor: input.cursor,
          from: input.from,
          resource: input.resource,
          to: input.to,
          traceId: input.traceId,
        }),
      ),
    listContent: (input: Parameters<GovernanceOperationsPort['listContent']>[0]) =>
      request(
        input,
        pathWithQuery('/admin/content', { cursor: input.cursor, status: input.status }),
      ),
    listTickets: (input: Parameters<GovernanceOperationsPort['listTickets']>[0]) =>
      request(
        input,
        pathWithQuery('/admin/tickets', {
          cursor: input.cursor,
          query: input.query,
          status: input.status,
        }),
      ),
    requestAuditExport: (input: Parameters<GovernanceOperationsPort['requestAuditExport']>[0]) =>
      request(
        input,
        '/admin/audit/exports',
        {
          action: input.action,
          actor: input.actor,
          actorId: input.actorId,
          audit: input.audit,
          confirmed: input.confirmed,
          filterFingerprint: input.filterFingerprint,
          format: input.format,
          from: input.from,
          preflightToken: input.preflightToken,
          resource: input.resource,
          to: input.to,
          traceId: input.traceId,
        },
        input.audit.idempotencyKey,
        'operations.governance.export',
      ),
    saveContentDraft: (input: Parameters<GovernanceOperationsPort['saveContentDraft']>[0]) =>
      request(
        input,
        `/admin/content/${encodeURIComponent(input.contentId)}/draft`,
        {
          actorId: input.actorId,
          audit: input.audit,
          body: input.body,
          confirmed: input.confirmed,
          expectedVersion: input.expectedVersion,
          planPoints: input.planPoints,
          preflightToken: input.preflightToken,
          title: input.title,
        },
        input.audit.idempotencyKey,
        'operations.governance.mutation',
      ),
    transitionTicket: (input: Parameters<GovernanceOperationsPort['transitionTicket']>[0]) =>
      request(
        input,
        `/admin/tickets/${encodeURIComponent(input.ticketId)}/transitions`,
        {
          actorId: input.actorId,
          audit: input.audit,
          confirmed: input.confirmed,
          expectedStatus: input.expectedStatus,
          expectedVersion: input.expectedVersion,
          preflightToken: input.preflightToken,
          to: input.to,
        },
        input.audit.idempotencyKey,
        'operations.governance.mutation',
      ),
    updateRole: (input: Parameters<GovernanceOperationsPort['updateRole']>[0]) =>
      request(
        input,
        `/admin/iam/roles/${encodeURIComponent(input.roleId)}`,
        {
          actorId: input.actorId,
          audit: input.audit,
          confirmed: input.confirmed,
          dataScope: input.dataScope,
          expectedVersion: input.expectedVersion,
          operation: input.operation,
          permissions: input.permissions,
          preflightToken: input.preflightToken,
        },
        input.audit.idempotencyKey,
        'operations.governance.mutation',
      ),
    updateAdmin: (input: Parameters<GovernanceOperationsPort['updateAdmin']>[0]) =>
      request(
        input,
        `/admin/iam/admins/${encodeURIComponent(input.adminId)}`,
        {
          actorId: input.actorId,
          audit: input.audit,
          confirmed: input.confirmed,
          dataScope: input.dataScope,
          expectedVersion: input.expectedVersion,
          operation: input.operation,
          preflightToken: input.preflightToken,
          roleIds: input.roleIds,
          status: input.status,
        },
        input.audit.idempotencyKey,
        'operations.governance.mutation',
      ),
    validateContentDraft: (
      input: Parameters<GovernanceOperationsPort['validateContentDraft']>[0],
    ) =>
      request(
        input,
        `/admin/content/${encodeURIComponent(input.contentId)}/validate`,
        {
          actorId: input.actorId,
          audit: input.audit,
          confirmed: input.confirmed,
          expectedVersion: input.expectedVersion,
          preflightToken: input.preflightToken,
        },
        input.audit.idempotencyKey,
        'operations.governance.mutation',
      ),
  });
}
