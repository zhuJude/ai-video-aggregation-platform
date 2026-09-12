import { types as utilTypes } from 'node:util';

import {
  DEFAULT_UPSTREAM_DEADLINE_MS,
  SafeHttpRequestError,
  fetchWithDeadline,
  isValidDeadline,
} from './http-deadline';
import {
  parseCapabilityMutationReceipt,
  parseCapabilityValidationReceipt,
  parseStrictCapabilityDefinition,
  parseStrictCapabilityViewPayload,
  parseStrictModelDirectoryPayload,
  type CapabilityCommandKind,
  type ModelCapabilityCommandPort,
  type ModelCapabilityPort,
  type ModelDirectoryPort,
} from './model-capability-operations';
import { isOutboundRequestContext, type OutboundRequestContext } from './outbound-request-context';
import {
  consumeTechnicalFailure,
  createSafeTelemetryEvent,
  defaultSafeTelemetry,
  recordTechnicalFailure,
  type SafeTelemetryOperation,
  type SafeTelemetryPort,
} from './safe-telemetry';
import { isUuidV7 } from './uuid-v7';

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

function exactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value))
      return null;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      requiredKeys.some((key) => !ownKeys.includes(key))
    )
      return null;
    const snapshot: Record<string, unknown> = {};
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
      snapshot[key as string] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function safeEnvironment(value: Environment) {
  const snapshot = exactRecord(value, ['apiUrl', 'kmsIdentityReference']);
  if (
    !snapshot ||
    typeof snapshot.apiUrl !== 'string' ||
    typeof snapshot.kmsIdentityReference !== 'string' ||
    !KMS_REFERENCE.test(snapshot.kmsIdentityReference)
  )
    throw new Error('模型目录服务配置无效');
  const apiUrl = new URL(snapshot.apiUrl);
  if (
    apiUrl.protocol !== 'https:' ||
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.search ||
    apiUrl.hash ||
    (apiUrl.pathname !== '/' && apiUrl.pathname !== '')
  )
    throw new Error('模型目录服务配置无效');
  return Object.freeze({ apiUrl, kmsIdentityReference: snapshot.kmsIdentityReference });
}

function safeToken(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 3000 && !/[\p{C}]/u.test(value)
  );
}

function safeReason(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\p{C}]/u.test(value)
  );
}

function validScope(value: unknown): value is 'ALL' | 'ASSIGNED' | 'OWN' {
  return value === 'ALL' || value === 'ASSIGNED' || value === 'OWN';
}

export function createHttpModelCapabilityPorts(
  environment: Environment = {
    apiUrl: process.env.ADMIN_CATALOG_API_URL,
    kmsIdentityReference: process.env.ADMIN_CATALOG_KMS_IDENTITY_REF,
  },
  {
    deadlineMs = DEFAULT_UPSTREAM_DEADLINE_MS,
    fetchImpl = fetch,
    telemetry = defaultSafeTelemetry,
  }: Options = {},
): Readonly<{
  commandPort: ModelCapabilityCommandPort;
  detailPort: ModelCapabilityPort;
  directoryPort: ModelDirectoryPort;
}> {
  const config = (() => {
    try {
      const parsed = safeEnvironment(environment);
      if (!isValidDeadline(deadlineMs)) throw new Error('invalid');
      return parsed;
    } catch (cause) {
      throw recordTechnicalFailure(
        telemetry,
        createSafeTelemetryEvent('catalog.config', 'INVALID_CONFIG'),
        new Error('模型目录服务配置无效', { cause }),
      );
    }
  })();

  function headers(
    context: OutboundRequestContext,
    token: string,
    scope: 'ALL' | 'ASSIGNED' | 'OWN',
  ) {
    if (!isOutboundRequestContext(context) || !safeToken(token))
      throw new Error('模型目录查询上下文无效');
    return new Headers({
      Accept: 'application/json',
      'X-Admin-Data-Scope': scope,
      'X-Admin-Session-Token': token,
      'X-Correlation-ID': context.correlationId,
      'X-Service-Identity-Kms-Ref': config.kmsIdentityReference,
      'X-Trace-ID': context.traceId,
    });
  }

  async function request<T>(
    path: string,
    init: RequestInit,
    operation: SafeTelemetryOperation,
    context: OutboundRequestContext,
    parse: (value: unknown) => T,
  ): Promise<T> {
    try {
      return await fetchWithDeadline(
        fetchImpl,
        new URL(path, config.apiUrl),
        { ...init, cache: 'no-store' },
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
                context,
              ),
              new Error('模型能力操作被上游拒绝'),
            );
          }
          let payload: unknown;
          try {
            payload = await response.json();
          } catch (cause) {
            if (signal.aborted) throw cause;
            throw recordTechnicalFailure(
              telemetry,
              createSafeTelemetryEvent(operation, 'MALFORMED_RESPONSE', context),
              new Error('模型能力响应无效'),
            );
          }
          try {
            return parse(payload);
          } catch (cause) {
            throw recordTechnicalFailure(
              telemetry,
              createSafeTelemetryEvent(operation, 'MALFORMED_RESPONSE', context),
              cause instanceof Error ? cause : new Error('模型能力响应无效'),
            );
          }
        },
      );
    } catch (cause) {
      if (consumeTechnicalFailure(cause)) throw cause;
      throw recordTechnicalFailure(
        telemetry,
        createSafeTelemetryEvent(
          operation,
          cause instanceof SafeHttpRequestError ? cause.reason : 'NETWORK_FAILURE',
          context,
        ),
        cause instanceof Error ? cause : new Error('模型能力请求失败'),
      );
    }
  }

  const directoryPort: ModelDirectoryPort = Object.freeze({
    async listModels(input: Parameters<ModelDirectoryPort['listModels']>[0]) {
      const query = exactRecord(input, ['requestContext', 'scope', 'trustedSessionToken']);
      if (
        !query ||
        !isOutboundRequestContext(query.requestContext) ||
        !validScope(query.scope) ||
        !safeToken(query.trustedSessionToken)
      )
        throw new Error('模型目录查询上下文无效');
      return request(
        '/v1/admin/models',
        {
          headers: headers(query.requestContext, query.trustedSessionToken, query.scope),
          method: 'GET',
        },
        'catalog.model.directory-read',
        query.requestContext,
        parseStrictModelDirectoryPayload,
      );
    },
  });

  const detailPort: ModelCapabilityPort = Object.freeze({
    async getCapability(input: Parameters<ModelCapabilityPort['getCapability']>[0]) {
      const query = exactRecord(input, [
        'modelId',
        'requestContext',
        'scope',
        'trustedSessionToken',
      ]);
      if (
        !query ||
        !isUuidV7(query.modelId) ||
        !isOutboundRequestContext(query.requestContext) ||
        !validScope(query.scope) ||
        !safeToken(query.trustedSessionToken)
      )
        throw new Error('模型能力查询上下文无效');
      const modelId = query.modelId;
      return request(
        `/v1/admin/models/${encodeURIComponent(modelId)}/capabilities`,
        {
          headers: headers(query.requestContext, query.trustedSessionToken, query.scope),
          method: 'GET',
        },
        'catalog.model.capability-read',
        query.requestContext,
        parseStrictCapabilityViewPayload,
      );
    },
  });

  const commandPort: ModelCapabilityCommandPort = Object.freeze({
    async previewRollback(input: Parameters<NonNullable<ModelCapabilityCommandPort['previewRollback']>>[0]) {
      const preview = exactRecord(input, [
        'expectedVersion',
        'modelId',
        'requestContext',
        'scope',
        'sourceVersionId',
        'targetVersionId',
        'trustedSessionToken',
      ]);
      if (
        !preview ||
        !Number.isSafeInteger(preview.expectedVersion) ||
        (preview.expectedVersion as number) < 1 ||
        !isUuidV7(preview.modelId) ||
        !isUuidV7(preview.sourceVersionId) ||
        !isUuidV7(preview.targetVersionId) ||
        !isOutboundRequestContext(preview.requestContext) ||
        !validScope(preview.scope) ||
        !safeToken(preview.trustedSessionToken)
      )
        throw new Error('模型能力回滚预检上下文无效');
      const requestHeaders = headers(
        preview.requestContext,
        preview.trustedSessionToken,
        preview.scope,
      );
      requestHeaders.set('Content-Type', 'application/json');
      return request(
        `/v1/admin/models/${encodeURIComponent(preview.modelId)}/capabilities/rollback-preview`,
        {
          body: JSON.stringify({
            expectedVersion: preview.expectedVersion,
            sourceVersionId: preview.sourceVersionId,
            targetVersionId: preview.targetVersionId,
          }),
          headers: requestHeaders,
          method: 'POST',
        },
        'catalog.model.capability-rollback-preview',
        preview.requestContext,
        (value) => value,
      );
    },
    async execute(input: Parameters<ModelCapabilityCommandPort['execute']>[0]) {
      const command = exactRecord(
        input,
        [
          'actorId',
          'audit',
          'expectedVersion',
          'kind',
          'modelId',
          'requestContext',
          'scope',
          'sourceVersionId',
          'trustedSessionToken',
        ],
        ['definition', 'preflightToken', 'targetVersionId'],
      );
      const audit = exactRecord(command?.audit, ['idempotencyKey', 'reason']);
      if (
        !command ||
        !audit ||
        !isUuidV7(command.actorId) ||
        !isUuidV7(command.modelId) ||
        !isUuidV7(command.sourceVersionId) ||
        !isUuidV7(audit.idempotencyKey) ||
        !safeReason(audit.reason) ||
        !Number.isSafeInteger(command.expectedVersion) ||
        (command.expectedVersion as number) < 1 ||
        !['CREATE_DRAFT', 'PUBLISH', 'ROLLBACK', 'SAVE', 'VALIDATE'].includes(
          command.kind as string,
        ) ||
        !isOutboundRequestContext(command.requestContext) ||
        !validScope(command.scope) ||
        !safeToken(command.trustedSessionToken)
      )
        throw new Error('模型能力命令上下文无效');
      const kind = command.kind as CapabilityCommandKind;
      const idempotencyKey = audit.idempotencyKey;
      const sourceVersionId = command.sourceVersionId;
      const targetVersionId =
        typeof command.targetVersionId === 'string' ? command.targetVersionId : undefined;
      const needsDefinition = kind === 'SAVE' || kind === 'VALIDATE';
      if (needsDefinition !== Boolean(command.definition))
        throw new Error('模型能力命令上下文无效');
      const definition = command.definition
        ? parseStrictCapabilityDefinition(command.definition)
        : undefined;
      if (
        kind === 'PUBLISH' || kind === 'ROLLBACK'
          ? typeof command.preflightToken !== 'string' ||
            !/^pf_[A-Za-z0-9_-]{24,256}$/u.test(command.preflightToken)
          : command.preflightToken !== undefined
      )
        throw new Error('模型能力命令上下文无效');
      if (
        kind === 'ROLLBACK'
          ? !isUuidV7(command.targetVersionId)
          : command.targetVersionId !== undefined
      )
        throw new Error('模型能力命令上下文无效');
      const requestContext = command.requestContext;
      const modelId = command.modelId;
      const expectedVersion = command.expectedVersion as number;
      const requestHeaders = headers(requestContext, command.trustedSessionToken, command.scope);
      requestHeaders.set('Content-Type', 'application/json');
      requestHeaders.set('Idempotency-Key', idempotencyKey);
      const body = JSON.stringify({
        audit: { actorId: command.actorId, reason: audit.reason },
        ...(definition ? { definition } : {}),
        expectedVersion,
        kind,
        sourceVersionId,
        ...(command.preflightToken ? { preflightToken: command.preflightToken } : {}),
        ...(targetVersionId ? { targetVersionId } : {}),
      });
      const operation = `catalog.model.capability-${kind.toLowerCase()}` as SafeTelemetryOperation;
      if (kind === 'VALIDATE') {
        return request(
          `/v1/admin/models/${encodeURIComponent(modelId)}/capabilities/commands`,
          { body, headers: requestHeaders, method: 'POST' },
          operation,
          requestContext,
          (value) => parseCapabilityValidationReceipt(value, modelId, expectedVersion),
        );
      }
      return request(
        `/v1/admin/models/${encodeURIComponent(modelId)}/capabilities/commands`,
        { body, headers: requestHeaders, method: 'POST' },
        operation,
        requestContext,
        (value) =>
          parseCapabilityMutationReceipt(value, modelId, expectedVersion, kind, {
            idempotencyKey,
            sourceVersionId,
            ...(targetVersionId ? { targetVersionId } : {}),
          }),
      );
    },
  });

  return Object.freeze({ commandPort, detailPort, directoryPort });
}
