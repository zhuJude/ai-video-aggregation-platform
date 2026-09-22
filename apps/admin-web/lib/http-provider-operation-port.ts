import { types as utilTypes } from 'node:util';

import {
  DEFAULT_UPSTREAM_DEADLINE_MS,
  SafeHttpRequestError,
  fetchWithDeadline,
  isValidDeadline,
} from './http-deadline';
import { isOutboundRequestContext, type OutboundRequestContext } from './outbound-request-context';
import {
  parseProviderActionReceipt,
  parseProviderDetailPayload,
  parseProviderDirectoryPayload,
  parseProviderMetadata,
  type ProviderCommandPort,
  type ProviderDetailPort,
  type ProviderDirectoryPort,
  type ProviderMetadataPort,
} from './provider-operations';
import {
  consumeTechnicalFailure,
  createSafeTelemetryEvent,
  defaultSafeTelemetry,
  recordTechnicalFailure,
  type SafeTelemetryOperation,
  type SafeTelemetryPort,
} from './safe-telemetry';
import { isUuidV7 } from './uuid-v7';

type ProviderEnvironment = Readonly<{
  apiUrl?: string | undefined;
  kmsIdentityReference?: string | undefined;
}>;
type Options = Readonly<{
  deadlineMs?: number;
  fetchImpl?: typeof fetch;
  telemetry?: SafeTelemetryPort;
}>;
const KMS_REFERENCE_PATTERN = /^kms:\/\/[A-Za-z0-9][A-Za-z0-9/_-]{2,255}$/u;
const PROVIDER_COMMAND_KINDS = [
  'CIRCUIT_RESET',
  'CREDENTIAL_DISABLE',
  'CREDENTIAL_ROTATE',
  'HEALTH_PROBE',
  'PROVIDER_DISABLE',
  'PROVIDER_ENABLE',
] as const;

function safeEnvironment(
  environment: ProviderEnvironment,
): Readonly<{ apiUrl: URL; kmsIdentityReference: string }> {
  try {
    const snapshot = exactInputRecord(environment, ['apiUrl', 'kmsIdentityReference']);
    if (
      !snapshot ||
      typeof snapshot.apiUrl !== 'string' ||
      typeof snapshot.kmsIdentityReference !== 'string' ||
      !KMS_REFERENCE_PATTERN.test(snapshot.kmsIdentityReference)
    )
      throw new Error('invalid');
    const apiUrl = new URL(snapshot.apiUrl);
    if (
      apiUrl.protocol !== 'https:' ||
      apiUrl.username ||
      apiUrl.password ||
      apiUrl.search ||
      apiUrl.hash ||
      (apiUrl.pathname !== '/' && apiUrl.pathname !== '')
    )
      throw new Error('invalid');
    return Object.freeze({ apiUrl, kmsIdentityReference: snapshot.kmsIdentityReference });
  } catch {
    throw new Error('供应商服务配置无效');
  }
}

function trustedInput(input: unknown): input is object {
  return Boolean(input && typeof input === 'object' && !utilTypes.isProxy(input));
}

function exactInputRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> | null {
  try {
    if (!trustedInput(value) || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key)) ||
      requiredKeys.some((key) => !ownKeys.includes(key))
    )
      return null;
    const snapshot: Record<string, unknown> = {};
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
      snapshot[key as string] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
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

function isProviderCommandKind(value: unknown): value is (typeof PROVIDER_COMMAND_KINDS)[number] {
  return (
    typeof value === 'string' &&
    PROVIDER_COMMAND_KINDS.includes(value as (typeof PROVIDER_COMMAND_KINDS)[number])
  );
}

function isMetadataKind(value: unknown): value is 'CREATE' | 'EDIT' {
  return value === 'CREATE' || value === 'EDIT';
}

export function createHttpProviderOperationPorts(
  environment: ProviderEnvironment = {
    apiUrl: process.env.ADMIN_OPERATIONS_API_URL,
    kmsIdentityReference: process.env.ADMIN_OPERATIONS_KMS_IDENTITY_REF,
  },
  {
    deadlineMs = DEFAULT_UPSTREAM_DEADLINE_MS,
    fetchImpl = fetch,
    telemetry = defaultSafeTelemetry,
  }: Options = {},
): Readonly<{
  commandPort: ProviderCommandPort;
  detailPort: ProviderDetailPort;
  directoryPort: ProviderDirectoryPort;
  metadataPort: ProviderMetadataPort;
}> {
  const config = (() => {
    try {
      const parsed = safeEnvironment(environment);
      if (!isValidDeadline(deadlineMs)) throw new Error('invalid');
      return parsed;
    } catch (cause) {
      throw recordTechnicalFailure(
        telemetry,
        createSafeTelemetryEvent('operations.provider.config', 'INVALID_CONFIG'),
        new Error('供应商服务配置无效', { cause }),
      );
    }
  })();

  function requestHeaders(
    requestContext: OutboundRequestContext,
    trustedSessionToken: string,
    scope?: 'ALL' | 'ASSIGNED' | 'OWN',
  ): Headers {
    if (!isOutboundRequestContext(requestContext)) throw new Error('出站请求上下文无效');
    if (!safeToken(trustedSessionToken)) throw new Error('受信管理员会话无效');
    const headers = new Headers({
      Accept: 'application/json',
      'X-Admin-Session-Token': trustedSessionToken,
      'X-Correlation-ID': requestContext.correlationId,
      'X-Service-Identity-Kms-Ref': config.kmsIdentityReference,
      'X-Trace-ID': requestContext.traceId,
    });
    if (scope) headers.set('X-Admin-Data-Scope', scope);
    return headers;
  }

  async function protectedRequest<T>(
    path: string,
    init: RequestInit,
    operation: SafeTelemetryOperation,
    requestContext: OutboundRequestContext,
    parse: (payload: unknown) => T,
  ): Promise<T> {
    const url = new URL(path, config.apiUrl);
    try {
      return await fetchWithDeadline(
        fetchImpl,
        url,
        { ...init, cache: 'no-store' },
        deadlineMs,
        async (response, signal) => {
          if (!response.ok) {
            const reason =
              response.status === 401 || response.status === 403
                ? 'DOWNSTREAM_DENIED'
                : 'UPSTREAM_FAILURE';
            throw recordTechnicalFailure(
              telemetry,
              createSafeTelemetryEvent(operation, reason, requestContext),
              new Error('供应商操作被上游拒绝'),
            );
          }
          let payload: unknown;
          try {
            payload = await response.json();
          } catch (error) {
            if (signal.aborted) throw error;
            throw recordTechnicalFailure(
              telemetry,
              createSafeTelemetryEvent(operation, 'MALFORMED_RESPONSE', requestContext),
              new Error('供应商响应无效'),
            );
          }
          try {
            return parse(payload);
          } catch (error) {
            const failure = error instanceof Error ? error : new Error('供应商响应无效');
            throw recordTechnicalFailure(
              telemetry,
              createSafeTelemetryEvent(operation, 'MALFORMED_RESPONSE', requestContext),
              failure,
            );
          }
        },
      );
    } catch (error) {
      if (consumeTechnicalFailure(error)) throw error;
      const reason = error instanceof SafeHttpRequestError ? error.reason : 'NETWORK_FAILURE';
      throw recordTechnicalFailure(
        telemetry,
        createSafeTelemetryEvent(operation, reason, requestContext),
        error instanceof Error ? error : new Error('供应商请求失败'),
      );
    }
  }

  const directoryPort: ProviderDirectoryPort = Object.freeze({
    async listProviders(input: Parameters<ProviderDirectoryPort['listProviders']>[0]) {
      const query = exactInputRecord(input, ['requestContext', 'scope', 'trustedSessionToken']);
      if (
        !query ||
        !['ALL', 'ASSIGNED', 'OWN'].includes(query.scope as string) ||
        !safeToken(query.trustedSessionToken)
      )
        throw new Error('供应商查询上下文无效');
      if (!isOutboundRequestContext(query.requestContext)) throw new Error('出站请求上下文无效');
      const requestContext = query.requestContext;
      const headers = requestHeaders(
        requestContext,
        query.trustedSessionToken,
        query.scope as 'ALL' | 'ASSIGNED' | 'OWN',
      );
      return protectedRequest(
        '/v1/admin/providers',
        { headers, method: 'GET' },
        'operations.provider.directory-read',
        requestContext,
        parseProviderDirectoryPayload,
      );
    },
  });

  const detailPort: ProviderDetailPort = Object.freeze({
    async getProvider(input: Parameters<ProviderDetailPort['getProvider']>[0]) {
      const query = exactInputRecord(input, [
        'providerId',
        'requestContext',
        'scope',
        'trustedSessionToken',
      ]);
      if (
        !query ||
        !isUuidV7(query.providerId) ||
        !['ALL', 'ASSIGNED', 'OWN'].includes(query.scope as string) ||
        !safeToken(query.trustedSessionToken)
      )
        throw new Error('供应商查询上下文无效');
      if (!isOutboundRequestContext(query.requestContext)) throw new Error('出站请求上下文无效');
      const providerId = query.providerId;
      const requestContext = query.requestContext;
      const headers = requestHeaders(
        requestContext,
        query.trustedSessionToken,
        query.scope as 'ALL' | 'ASSIGNED' | 'OWN',
      );
      return protectedRequest(
        `/v1/admin/providers/${encodeURIComponent(providerId)}`,
        { headers, method: 'GET' },
        'operations.provider.detail-read',
        requestContext,
        parseProviderDetailPayload,
      );
    },
  });

  const commandPort: ProviderCommandPort = Object.freeze({
    async execute(input: Parameters<ProviderCommandPort['execute']>[0]) {
      const command = exactInputRecord(
        input,
        [
          'actorId',
          'audit',
          'expectedVersion',
          'kind',
          'providerId',
          'requestContext',
          'scope',
          'trustedSessionToken',
        ],
        ['credentialId', 'replacementSecret'],
      );
      const audit = exactInputRecord(command?.audit, ['idempotencyKey', 'reason']);
      if (
        !command ||
        !audit ||
        !isProviderCommandKind(command.kind) ||
        !isUuidV7(command.providerId) ||
        !isUuidV7(command.actorId) ||
        !isUuidV7(audit.idempotencyKey) ||
        !safeReason(audit.reason) ||
        !Number.isSafeInteger(command.expectedVersion) ||
        (command.expectedVersion as number) < 0 ||
        !isOutboundRequestContext(command.requestContext) ||
        !['ALL', 'ASSIGNED', 'OWN'].includes(command.scope as string) ||
        !safeToken(command.trustedSessionToken)
      )
        throw new Error('供应商命令上下文无效');
      const credentialOperation =
        command.kind === 'CREDENTIAL_DISABLE' || command.kind === 'CREDENTIAL_ROTATE';
      if (
        credentialOperation !== Boolean(command.credentialId) ||
        (command.credentialId !== undefined && !isUuidV7(command.credentialId))
      )
        throw new Error('供应商命令上下文无效');
      if (
        command.kind === 'CREDENTIAL_ROTATE'
          ? typeof command.replacementSecret !== 'string' ||
            command.replacementSecret.length < 12 ||
            command.replacementSecret.length > 4096 ||
            /[\p{C}]/u.test(command.replacementSecret)
          : command.replacementSecret !== undefined
      )
        throw new Error('供应商命令上下文无效');
      const requestContext = command.requestContext;
      const providerId = command.providerId;
      const expectedVersion = command.expectedVersion as number;
      const kind = command.kind;
      const headers = requestHeaders(
        requestContext,
        command.trustedSessionToken,
        command.scope as 'ALL' | 'ASSIGNED' | 'OWN',
      );
      headers.set('Content-Type', 'application/json');
      headers.set('Idempotency-Key', audit.idempotencyKey);
      const body = JSON.stringify({
        audit: { actorId: command.actorId, reason: audit.reason },
        ...(command.credentialId ? { credentialId: command.credentialId } : {}),
        expectedVersion,
        kind,
        ...(command.replacementSecret ? { replacementSecret: command.replacementSecret } : {}),
      });
      return protectedRequest(
        `/v1/admin/providers/${encodeURIComponent(providerId)}/commands`,
        { body, headers, method: 'POST' },
        'operations.provider.command',
        requestContext,
        (payload) =>
          parseProviderActionReceipt(payload, providerId, {
            kind,
            previousVersion: expectedVersion,
          }),
      );
    },
  });

  const metadataPort: ProviderMetadataPort = Object.freeze({
    async write(input: Parameters<ProviderMetadataPort['write']>[0]) {
      const command = exactInputRecord(
        input,
        ['actorId', 'audit', 'kind', 'metadata', 'requestContext', 'scope', 'trustedSessionToken'],
        ['expectedVersion', 'providerId'],
      );
      const audit = exactInputRecord(command?.audit, ['idempotencyKey', 'reason']);
      if (
        !command ||
        !audit ||
        !isUuidV7(command.actorId) ||
        !isUuidV7(audit.idempotencyKey) ||
        !safeReason(audit.reason) ||
        !['ALL', 'ASSIGNED', 'OWN'].includes(command.scope as string) ||
        !isMetadataKind(command.kind) ||
        !isOutboundRequestContext(command.requestContext) ||
        !safeToken(command.trustedSessionToken)
      )
        throw new Error('供应商元数据上下文无效');
      const metadata = parseProviderMetadata(command.metadata);
      const isEdit = command.kind === 'EDIT';
      if (
        isEdit
          ? !isUuidV7(command.providerId) ||
            !Number.isSafeInteger(command.expectedVersion) ||
            (command.expectedVersion as number) < 0
          : command.providerId !== undefined || command.expectedVersion !== undefined
      )
        throw new Error('供应商元数据上下文无效');
      const kind = command.kind;
      const providerId = command.providerId as string | undefined;
      const expectedVersion = command.expectedVersion as number | undefined;
      const requestContext = command.requestContext;
      const headers = requestHeaders(
        requestContext,
        command.trustedSessionToken,
        command.scope as 'ALL' | 'ASSIGNED' | 'OWN',
      );
      headers.set('Content-Type', 'application/json');
      headers.set('Idempotency-Key', audit.idempotencyKey);
      const body = JSON.stringify({
        audit: { actorId: command.actorId, reason: audit.reason },
        ...(isEdit ? { expectedVersion } : {}),
        metadata,
      });
      const path = isEdit
        ? `/v1/admin/providers/${encodeURIComponent(providerId as string)}/metadata`
        : '/v1/admin/providers';
      return protectedRequest(
        path,
        { body, headers, method: 'POST' },
        'operations.provider.metadata-write',
        requestContext,
        (payload) => {
          const receipt = exactInputRecord(payload, [
            'auditRecordId',
            'providerId',
            'requestId',
            'status',
            'version',
          ]);
          const rawProviderId = providerId ?? receipt?.providerId;
          if (!isUuidV7(rawProviderId)) throw new Error('供应商操作回执无效');
          return parseProviderActionReceipt(receipt, rawProviderId, {
            kind,
            ...(expectedVersion === undefined ? {} : { previousVersion: expectedVersion }),
          });
        },
      );
    },
  });

  return Object.freeze({ commandPort, detailPort, directoryPort, metadataPort });
}
