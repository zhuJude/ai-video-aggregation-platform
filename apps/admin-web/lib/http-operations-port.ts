import { DEFAULT_UPSTREAM_DEADLINE_MS, fetchWithDeadline } from './http-deadline';
import type {
  PricingOperationsPort,
  RoutingOperationsPort,
  TaskOperationsPort,
} from './operations-server';

type Environment = Readonly<{
  apiUrl?: string | undefined;
  kmsIdentityReference?: string | undefined;
}>;
type Options = Readonly<{ deadlineMs?: number; fetchImpl?: typeof fetch }>;
const KMS_REFERENCE = /^kms:\/\/[A-Za-z0-9][A-Za-z0-9/_-]{2,255}$/u;

export function createHttpOperationsPorts(
  environment: Environment = {
    apiUrl: process.env.ADMIN_OPERATIONS_API_URL,
    kmsIdentityReference: process.env.ADMIN_OPERATIONS_KMS_IDENTITY_REF,
  },
  { deadlineMs = DEFAULT_UPSTREAM_DEADLINE_MS, fetchImpl = fetch }: Options = {},
): Readonly<{
  pricing: PricingOperationsPort;
  routing: RoutingOperationsPort;
  tasks: TaskOperationsPort;
}> {
  if (
    !environment.apiUrl ||
    !environment.kmsIdentityReference ||
    !KMS_REFERENCE.test(environment.kmsIdentityReference)
  )
    throw new Error('运营服务配置无效');
  const baseUrl = new URL(environment.apiUrl);
  if (
    baseUrl.protocol !== 'https:' ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    (baseUrl.pathname !== '/' && baseUrl.pathname !== '')
  )
    throw new Error('运营服务配置无效');
  const kmsReference = environment.kmsIdentityReference;

  async function request(
    input: {
      requestContext: { correlationId: string; traceId: string };
      scope: string;
      trustedSessionToken: string;
    },
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ) {
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
    return fetchWithDeadline(
      fetchImpl,
      new URL(path, baseUrl),
      init,
      deadlineMs,
      async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 401 || response.status === 403
              ? '运营服务拒绝访问'
              : '运营服务暂时不可用',
          );
        try {
          return (await response.json()) as unknown;
        } catch {
          throw new Error('运营服务响应无效');
        }
      },
    );
  }

  const pricing: PricingOperationsPort = Object.freeze({
    getPricing: (input: Parameters<PricingOperationsPort['getPricing']>[0]) =>
      request(input, '/admin/pricing/current'),
    save: (input: Parameters<PricingOperationsPort['save']>[0]) =>
      request(
        input,
        '/admin/pricing/draft',
        {
          actorId: input.actorId,
          audit: input.audit,
          effectiveAt: input.effectiveAt,
          expectedVersion: input.expectedVersion,
          markupBps: input.markupBps,
          ruleId: input.ruleId,
          salePoints: input.salePoints,
          strategy: input.strategy,
          tiers: input.tiers,
          versionId: input.versionId,
        },
        input.audit.idempotencyKey,
      ),
    preview: (input: Parameters<PricingOperationsPort['preview']>[0]) =>
      request(input, '/admin/pricing/preview', {
        effectiveAt: input.effectiveAt,
        expectedVersion: input.expectedVersion,
        markupBps: input.markupBps,
        ruleId: input.ruleId,
        salePoints: input.salePoints,
        strategy: input.strategy,
        tiers: input.tiers,
        versionId: input.versionId,
      }),
    publish: (input: Parameters<PricingOperationsPort['publish']>[0]) =>
      request(
        input,
        '/admin/pricing/publish',
        {
          actorId: input.actorId,
          audit: input.audit,
          confirmed: input.confirmed,
          expectedVersion: input.expectedVersion,
          previewToken: input.previewToken,
          versionId: input.versionId,
        },
        input.audit.idempotencyKey,
      ),
    rollback: (input: Parameters<PricingOperationsPort['rollback']>[0]) =>
      request(
        input,
        '/admin/pricing/rollback',
        {
          actorId: input.actorId,
          audit: input.audit,
          confirmed: input.confirmed,
          expectedVersion: input.expectedVersion,
          targetVersionId: input.targetVersionId,
          versionId: input.versionId,
        },
        input.audit.idempotencyKey,
      ),
  });
  const routing: RoutingOperationsPort = Object.freeze({
    getRouting: (input: Parameters<RoutingOperationsPort['getRouting']>[0]) =>
      request(input, '/admin/routing/current'),
    preview: (input: Parameters<RoutingOperationsPort['preview']>[0]) =>
      request(input, '/admin/routing/preview', {
        expectedVersion: input.expectedVersion,
        versionId: input.versionId,
      }),
    save: (input: Parameters<RoutingOperationsPort['save']>[0]) =>
      request(
        input,
        '/admin/routing/draft',
        {
          actorId: input.actorId,
          audit: input.audit,
          backupCapabilityMap: input.backupCapabilityMap,
          effectiveAt: input.effectiveAt,
          expectedVersion: input.expectedVersion,
          failoverMode: input.failoverMode,
          minimumMarginBps: input.minimumMarginBps,
          priceWeight: input.priceWeight,
          providerPriority: input.providerPriority,
          qualityWeight: input.qualityWeight,
          speedWeight: input.speedWeight,
          versionId: input.versionId,
        },
        input.audit.idempotencyKey,
      ),
    publish: (input: Parameters<RoutingOperationsPort['publish']>[0]) =>
      request(
        input,
        '/admin/routing/publish',
        {
          actorId: input.actorId,
          audit: input.audit,
          confirmed: input.confirmed,
          expectedVersion: input.expectedVersion,
          previewToken: input.previewToken,
          versionId: input.versionId,
        },
        input.audit.idempotencyKey,
      ),
    rollback: (input: Parameters<RoutingOperationsPort['rollback']>[0]) =>
      request(
        input,
        '/admin/routing/rollback',
        {
          actorId: input.actorId,
          audit: input.audit,
          confirmed: input.confirmed,
          expectedVersion: input.expectedVersion,
          targetVersionId: input.targetVersionId,
          versionId: input.versionId,
        },
        input.audit.idempotencyKey,
      ),
    simulate: (input: Parameters<RoutingOperationsPort['simulate']>[0]) =>
      request(input, '/admin/routing/simulate', { parameters: input.parameters }),
  });
  const tasks: TaskOperationsPort = Object.freeze({
    listTasks: (input: Parameters<NonNullable<TaskOperationsPort['listTasks']>>[0]) => {
      const query = new URLSearchParams();
      if (input.query) query.set('query', input.query);
      if (input.status) query.set('status', input.status);
      if (input.cursor) query.set('cursor', input.cursor);
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return request(input, `/admin/tasks${suffix}`);
    },
    getTask: (input: Parameters<TaskOperationsPort['getTask']>[0]) =>
      request(input, `/admin/tasks/${encodeURIComponent(input.taskId)}`),
    getRaw: (input: Parameters<NonNullable<TaskOperationsPort['getRaw']>>[0]) =>
      request(input, `/admin/tasks/${encodeURIComponent(input.taskId)}/raw`),
    execute: (input: Parameters<NonNullable<TaskOperationsPort['execute']>>[0]) =>
      request(
        input,
        `/admin/tasks/${encodeURIComponent(input.taskId)}/actions`,
        {
          action: input.action,
          actorId: input.actorId,
          audit: input.audit,
          confirmed: input.confirmed,
          expectedVersion: input.expectedVersion,
          impactToken: input.impactToken,
        },
        input.audit.idempotencyKey,
      ),
    executeQueue: (input: Parameters<NonNullable<TaskOperationsPort['executeQueue']>>[0]) =>
      request(
        input,
        '/admin/tasks/queue/actions',
        {
          action: input.action,
          actorId: input.actorId,
          audit: input.audit,
          confirmed: input.confirmed,
          expectedPaused: input.expectedPaused,
          expectedVersion: input.expectedVersion,
          impactToken: input.impactToken,
          ...(input.action === 'UPDATE_LIMITS'
            ? {
                concurrencyLimit: input.concurrencyLimit,
                defaultPriority: input.defaultPriority,
                rateLimitPerMinute: input.rateLimitPerMinute,
              }
            : {}),
        },
        input.audit.idempotencyKey,
      ),
  });
  return Object.freeze({ pricing, routing, tasks });
}
