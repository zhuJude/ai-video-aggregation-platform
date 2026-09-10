import { types as utilTypes } from 'node:util';

import {
  createOutboundRequestContext,
  parseOutboundRequestContext,
  type OutboundRequestContext,
} from './outbound-request-context';
import { hasPermission, type AdminPermission, type DataScope } from './permissions';
import {
  assertAdminDataScope,
  requireAdminAuthorization,
  type ServerGuardContext,
} from './server-guard';
import { isTraceId } from './trace-id';
import { isUuidV7 } from './uuid-v7';

const PROVIDER_STATUSES = ['ENABLED', 'DISABLED'] as const;
const PROVIDER_HEALTH = ['HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN'] as const;
const CIRCUIT_STATES = ['CLOSED', 'OPEN', 'HALF_OPEN'] as const;
const AUTH_METHODS = ['API_KEY', 'BEARER', 'HMAC_SHA256', 'OAUTH2_CLIENT'] as const;
const CALLBACK_MODES = ['NONE', 'SIGNED_WEBHOOK', 'POLLING'] as const;
const CREDENTIAL_STATUSES = ['ACTIVE', 'DISABLED', 'ROTATING'] as const;
const CREDENTIAL_SCOPES = [
  'BALANCE_READ',
  'CALLBACK_VERIFY',
  'TASK_CANCEL',
  'TASK_CREATE',
  'TASK_QUERY',
] as const;
const PARTIAL_FIELDS = ['balance', 'health', 'latency', 'rateLimits', 'successRate'] as const;
const SECRET_KEY_PATTERN = /(?:secret|password|private.?key|api.?key|access.?token|credential)/iu;
const SECRET_VALUE_PATTERN =
  /(?:sk|pk|api|token|secret|key)[_-](?:live|prod|test)?[_-]?[A-Za-z0-9]{8,}/iu;
const KMS_REFERENCE_PATTERN = /^kms:\/\/[A-Za-z0-9][A-Za-z0-9/_-]{2,255}$/u;
const MASKED_SECRET_PATTERN = /^(?:[A-Za-z0-9]{1,4}[_-]?)?\*{4,12}[A-Za-z0-9]{0,4}$/u;
const SAFE_UNIT_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/u;

type ProviderStatus = (typeof PROVIDER_STATUSES)[number];
type ProviderHealth = (typeof PROVIDER_HEALTH)[number];
type CircuitState = (typeof CIRCUIT_STATES)[number];
export type ProviderCommandKind =
  | 'CIRCUIT_RESET'
  | 'CREDENTIAL_DISABLE'
  | 'CREDENTIAL_ROTATE'
  | 'HEALTH_PROBE'
  | 'PROVIDER_DISABLE'
  | 'PROVIDER_ENABLE';

export type ProviderDirectoryRow = Readonly<{
  circuitState: CircuitState;
  health: ProviderHealth;
  id: string;
  latencyP95Ms: number;
  name: string;
  sourceUpdatedAt: string;
  status: ProviderStatus;
  successRateBps: number;
}>;

export type ProviderCredential = Readonly<{
  audit: Readonly<{ lastAccessedAt: string; lastAccessedBy: string }>;
  id: string;
  kmsReference: string;
  masked: string;
  rotatedAt: string;
  rotatedBy: string;
  scope: readonly (typeof CREDENTIAL_SCOPES)[number][];
  status: (typeof CREDENTIAL_STATUSES)[number];
}>;

export type ProviderCredentialOperationSummary = Readonly<{
  id: string;
  label: string;
  status: ProviderCredential['status'];
}>;

export type ProviderDetail = ProviderDirectoryRow &
  Readonly<{
    alert: Readonly<{ channels: readonly ('EMAIL' | 'PHONE' | 'SLS')[]; owner: string }>;
    assignedAdminIds: readonly string[];
    auth: Readonly<{ kmsIdentityReference: string; method: (typeof AUTH_METHODS)[number] }>;
    balance: Readonly<{ amount: string; threshold: string; unit: string }>;
    callback: Readonly<{
      configured: boolean;
      mode: (typeof CALLBACK_MODES)[number];
      verificationKmsReference: string | null;
    }>;
    credentials: readonly ProviderCredential[];
    interface: Readonly<{ baseUrl: string; protocol: 'REST_JSON'; timeoutMs: number }>;
    lastProbe: Readonly<{ checkedAt: string; message: string; traceId: string }>;
    maintenanceWindow: Readonly<{ endsAt: string; reason: string; startsAt: string } | null>;
    ownerAdminId: string | null;
    procurement: Readonly<{ costUnit: string; discountBps: number }>;
    rateLimits: Readonly<{ concurrency: number; requests: number; windowSeconds: number }>;
    version: number;
  }>;

export type ProviderDetailForClient = Omit<ProviderDetail, 'credentials'> &
  Readonly<{
    credentials: readonly (ProviderCredential | ProviderCredentialOperationSummary)[];
  }>;

export type ProviderDirectoryPayload = Readonly<{
  items: readonly ProviderDirectoryRow[];
  partialFields: readonly (typeof PARTIAL_FIELDS)[number][];
  sourceUpdatedAt: string;
}>;

export type ProviderActionReceipt = Readonly<{
  auditRecordId: string;
  ok: true;
  providerId: string;
  requestId: string;
  status: ProviderStatus;
  version: number;
}>;

type ExactRecord = Readonly<Record<string, unknown>>;

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

function safeText(value: unknown, maximum = 256): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\p{C}]/u.test(value) &&
    !SECRET_VALUE_PATTERN.test(value)
    ? value
    : null;
}

function utc(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function integerString(value: unknown): string | null {
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,30})$/u.test(value) ? value : null;
}

function member<T extends readonly string[]>(value: unknown, values: T): T[number] | null {
  return typeof value === 'string' && values.includes(value) ? (value as T[number]) : null;
}

function uuidList(value: unknown): readonly string[] | null {
  const source = exactArray(value, 100);
  if (!source || !source.every(isUuidV7)) return null;
  const ids = source.map((item) => item);
  return new Set(ids.map((id) => id.toLowerCase())).size === ids.length ? Object.freeze(ids) : null;
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      ? url.toString().replace(/\/$/u, '')
      : null;
  } catch {
    return null;
  }
}

function parseDirectoryRow(value: unknown): ProviderDirectoryRow | null {
  const row = exactRecord(value, [
    'circuitState',
    'health',
    'id',
    'latencyP95Ms',
    'name',
    'sourceUpdatedAt',
    'status',
    'successRateBps',
  ]);
  if (!row) return null;
  const circuitState = member(row.circuitState, CIRCUIT_STATES);
  const health = member(row.health, PROVIDER_HEALTH);
  const latencyP95Ms = integer(row.latencyP95Ms, 0, 86_400_000);
  const name = safeText(row.name, 120);
  const sourceUpdatedAt = utc(row.sourceUpdatedAt);
  const status = member(row.status, PROVIDER_STATUSES);
  const successRateBps = integer(row.successRateBps, 0, 10_000);
  if (
    !circuitState ||
    !health ||
    !isUuidV7(row.id) ||
    latencyP95Ms === null ||
    !name ||
    !sourceUpdatedAt ||
    !status ||
    successRateBps === null
  )
    return null;
  return Object.freeze({
    circuitState,
    health,
    id: row.id,
    latencyP95Ms,
    name,
    sourceUpdatedAt,
    status,
    successRateBps,
  });
}

export function parseProviderDirectoryPayload(value: unknown): ProviderDirectoryPayload {
  const payload = exactRecord(value, ['items', 'partialFields', 'sourceUpdatedAt']);
  const itemsSource = payload && exactArray(payload.items, 100);
  const partialSource = payload && exactArray(payload.partialFields, PARTIAL_FIELDS.length);
  const sourceUpdatedAt = payload && utc(payload.sourceUpdatedAt);
  if (!payload || !itemsSource || !partialSource || !sourceUpdatedAt)
    throw new Error('供应商目录响应无效');
  const items = itemsSource.map(parseDirectoryRow);
  const partialFields = partialSource.map((field) => member(field, PARTIAL_FIELDS));
  if (
    items.some((item) => !item) ||
    partialFields.some((field) => !field) ||
    new Set(partialFields).size !== partialFields.length
  )
    throw new Error('供应商目录响应无效');
  return Object.freeze({
    items: Object.freeze(items as ProviderDirectoryRow[]),
    partialFields: Object.freeze(partialFields as (typeof PARTIAL_FIELDS)[number][]),
    sourceUpdatedAt,
  });
}

function parseCredential(value: unknown): ProviderCredential | null {
  const credential = exactRecord(value, [
    'audit',
    'id',
    'kmsReference',
    'masked',
    'rotatedAt',
    'rotatedBy',
    'scope',
    'status',
  ]);
  if (
    !credential ||
    !isUuidV7(credential.id) ||
    typeof credential.kmsReference !== 'string' ||
    !KMS_REFERENCE_PATTERN.test(credential.kmsReference) ||
    typeof credential.masked !== 'string' ||
    !MASKED_SECRET_PATTERN.test(credential.masked) ||
    SECRET_VALUE_PATTERN.test(credential.masked) ||
    !isUuidV7(credential.rotatedBy)
  )
    return null;
  const rotatedAt = utc(credential.rotatedAt);
  const status = member(credential.status, CREDENTIAL_STATUSES);
  const scopeSource = exactArray(credential.scope, CREDENTIAL_SCOPES.length);
  const audit = exactRecord(credential.audit, ['lastAccessedAt', 'lastAccessedBy']);
  const accessedAt = audit && utc(audit.lastAccessedAt);
  if (
    !rotatedAt ||
    !status ||
    !scopeSource ||
    !audit ||
    !accessedAt ||
    !isUuidV7(audit.lastAccessedBy)
  )
    return null;
  const scope = scopeSource.map((item) => member(item, CREDENTIAL_SCOPES));
  if (scope.some((item) => !item) || new Set(scope).size !== scope.length) return null;
  return Object.freeze({
    audit: Object.freeze({
      lastAccessedAt: accessedAt,
      lastAccessedBy: audit.lastAccessedBy,
    }),
    id: credential.id,
    kmsReference: credential.kmsReference,
    masked: credential.masked,
    rotatedAt,
    rotatedBy: credential.rotatedBy,
    scope: Object.freeze(scope as (typeof CREDENTIAL_SCOPES)[number][]),
    status,
  });
}

export function parseProviderDetailPayload(value: unknown): ProviderDetail {
  const keys = [
    'alert',
    'assignedAdminIds',
    'auth',
    'balance',
    'callback',
    'circuitState',
    'credentials',
    'health',
    'id',
    'interface',
    'lastProbe',
    'latencyP95Ms',
    'maintenanceWindow',
    'name',
    'ownerAdminId',
    'procurement',
    'rateLimits',
    'sourceUpdatedAt',
    'status',
    'successRateBps',
    'version',
  ];
  const payload = exactRecord(value, keys);
  if (!payload) throw new Error('供应商详情响应无效');
  const row = parseDirectoryRow({
    circuitState: payload.circuitState,
    health: payload.health,
    id: payload.id,
    latencyP95Ms: payload.latencyP95Ms,
    name: payload.name,
    sourceUpdatedAt: payload.sourceUpdatedAt,
    status: payload.status,
    successRateBps: payload.successRateBps,
  });
  const alert = exactRecord(payload.alert, ['channels', 'owner']);
  const channelsSource = alert && exactArray(alert.channels, 3);
  const channels = channelsSource?.map((item) => member(item, ['EMAIL', 'PHONE', 'SLS'] as const));
  const assignedAdminIds = uuidList(payload.assignedAdminIds);
  const auth = exactRecord(payload.auth, ['kmsIdentityReference', 'method']);
  const balance = exactRecord(payload.balance, ['amount', 'threshold', 'unit']);
  const callback = exactRecord(payload.callback, [
    'configured',
    'mode',
    'verificationKmsReference',
  ]);
  const credentialsSource = exactArray(payload.credentials, 20);
  const credentials = credentialsSource?.map(parseCredential);
  const interfaceMetadata = exactRecord(payload.interface, ['baseUrl', 'protocol', 'timeoutMs']);
  const lastProbe = exactRecord(payload.lastProbe, ['checkedAt', 'message', 'traceId']);
  const maintenance =
    payload.maintenanceWindow === null
      ? null
      : exactRecord(payload.maintenanceWindow, ['endsAt', 'reason', 'startsAt']);
  const procurement = exactRecord(payload.procurement, ['costUnit', 'discountBps']);
  const rateLimits = exactRecord(payload.rateLimits, ['concurrency', 'requests', 'windowSeconds']);
  const owner = safeText(alert?.owner, 120);
  const authMethod = member(auth?.method, AUTH_METHODS);
  const amount = integerString(balance?.amount);
  const threshold = integerString(balance?.threshold);
  const unit = safeText(balance?.unit, 32);
  const callbackMode = member(callback?.mode, CALLBACK_MODES);
  const baseUrl = safeHttpsUrl(interfaceMetadata?.baseUrl);
  const timeoutMs = integer(interfaceMetadata?.timeoutMs, 100, 30_000);
  const checkedAt = utc(lastProbe?.checkedAt);
  const probeMessage = safeText(lastProbe?.message, 256);
  const costUnit = safeText(procurement?.costUnit, 32);
  const discountBps = integer(procurement?.discountBps, 0, 10_000);
  const concurrency = integer(rateLimits?.concurrency, 1, 1_000_000);
  const requests = integer(rateLimits?.requests, 1, 1_000_000_000);
  const windowSeconds = integer(rateLimits?.windowSeconds, 1, 86_400);
  const version = integer(payload.version, 0, Number.MAX_SAFE_INTEGER);
  const verificationKmsReference = callback?.verificationKmsReference;
  const ownerAdminId = payload.ownerAdminId;
  const maintenanceStartsAt = maintenance && utc(maintenance.startsAt);
  const maintenanceEndsAt = maintenance && utc(maintenance.endsAt);
  const maintenanceReason = maintenance && safeText(maintenance.reason, 256);
  if (
    !row ||
    !alert ||
    !channels ||
    channels.some((item) => !item) ||
    new Set(channels).size !== channels.length ||
    !owner ||
    !assignedAdminIds ||
    !auth ||
    typeof auth.kmsIdentityReference !== 'string' ||
    !KMS_REFERENCE_PATTERN.test(auth.kmsIdentityReference) ||
    !authMethod ||
    !balance ||
    !amount ||
    !threshold ||
    !unit ||
    !SAFE_UNIT_PATTERN.test(unit) ||
    !callback ||
    typeof callback.configured !== 'boolean' ||
    !callbackMode ||
    (verificationKmsReference !== null &&
      (typeof verificationKmsReference !== 'string' ||
        !KMS_REFERENCE_PATTERN.test(verificationKmsReference))) ||
    !credentials ||
    credentials.some((item) => !item) ||
    !interfaceMetadata ||
    !baseUrl ||
    interfaceMetadata.protocol !== 'REST_JSON' ||
    timeoutMs === null ||
    !lastProbe ||
    !checkedAt ||
    !probeMessage ||
    !isTraceId(lastProbe.traceId) ||
    (ownerAdminId !== null && !isUuidV7(ownerAdminId)) ||
    !procurement ||
    !costUnit ||
    !SAFE_UNIT_PATTERN.test(costUnit) ||
    discountBps === null ||
    !rateLimits ||
    concurrency === null ||
    requests === null ||
    windowSeconds === null ||
    version === null ||
    (maintenance !== null &&
      (!maintenanceStartsAt ||
        !maintenanceEndsAt ||
        !maintenanceReason ||
        Date.parse(maintenanceStartsAt) >= Date.parse(maintenanceEndsAt)))
  )
    throw new Error('供应商详情响应无效');
  return Object.freeze({
    ...row,
    alert: Object.freeze({
      channels: Object.freeze(channels as ('EMAIL' | 'PHONE' | 'SLS')[]),
      owner,
    }),
    assignedAdminIds,
    auth: Object.freeze({ kmsIdentityReference: auth.kmsIdentityReference, method: authMethod }),
    balance: Object.freeze({ amount, threshold, unit }),
    callback: Object.freeze({
      configured: callback.configured,
      mode: callbackMode,
      verificationKmsReference: verificationKmsReference,
    }),
    credentials: Object.freeze(credentials as ProviderCredential[]),
    interface: Object.freeze({ baseUrl, protocol: 'REST_JSON' as const, timeoutMs }),
    lastProbe: Object.freeze({
      checkedAt,
      message: probeMessage,
      traceId: lastProbe.traceId,
    }),
    maintenanceWindow:
      maintenance === null
        ? null
        : Object.freeze({
            endsAt: maintenanceEndsAt as string,
            reason: maintenanceReason as string,
            startsAt: maintenanceStartsAt as string,
          }),
    ownerAdminId: ownerAdminId,
    procurement: Object.freeze({ costUnit, discountBps }),
    rateLimits: Object.freeze({ concurrency, requests, windowSeconds }),
    version,
  });
}

export interface ProviderDirectoryPort {
  listProviders(
    input: Readonly<{
      requestContext: OutboundRequestContext;
      scope: DataScope;
      trustedSessionToken: string;
    }>,
  ): Promise<unknown>;
}
export interface ProviderDetailPort {
  getProvider(
    input: Readonly<{
      providerId: string;
      requestContext: OutboundRequestContext;
      scope: DataScope;
      trustedSessionToken: string;
    }>,
  ): Promise<unknown>;
}
export interface ProviderCommandPort {
  execute(
    input: Readonly<{
      actorId: string;
      audit: Readonly<{ idempotencyKey: string; reason: string }>;
      credentialId?: string;
      expectedVersion: number;
      kind: ProviderCommandKind;
      providerId: string;
      replacementSecret?: string;
      requestContext: OutboundRequestContext;
      scope: DataScope;
      trustedSessionToken: string;
    }>,
  ): Promise<unknown>;
}
export type ProviderMetadata = Readonly<{
  authMethod: (typeof AUTH_METHODS)[number];
  baseUrl: string;
  callbackMode: (typeof CALLBACK_MODES)[number];
  maintenanceWindow: Readonly<{ endsAt: string; reason: string; startsAt: string }> | null;
  name: string;
  ownerAdminId: string;
}>;

export function parseProviderMetadata(value: unknown): ProviderMetadata {
  const metadata = exactRecord(value, [
    'authMethod',
    'baseUrl',
    'callbackMode',
    'maintenanceWindow',
    'name',
    'ownerAdminId',
  ]);
  const authMethod = member(metadata?.authMethod, AUTH_METHODS);
  const baseUrl = safeHttpsUrl(metadata?.baseUrl);
  const callbackMode = member(metadata?.callbackMode, CALLBACK_MODES);
  const name = safeText(metadata?.name, 120);
  const ownerAdminId = metadata?.ownerAdminId;
  const maintenanceSource =
    metadata?.maintenanceWindow === null
      ? null
      : exactRecord(metadata?.maintenanceWindow, ['endsAt', 'reason', 'startsAt']);
  const endsAt = maintenanceSource === null ? null : utc(maintenanceSource.endsAt);
  const maintenanceReason =
    maintenanceSource === null ? null : safeText(maintenanceSource.reason, 256);
  const startsAt = maintenanceSource === null ? null : utc(maintenanceSource.startsAt);

  if (
    !metadata ||
    !authMethod ||
    !baseUrl ||
    !callbackMode ||
    !name ||
    !isUuidV7(ownerAdminId) ||
    (metadata.maintenanceWindow !== null &&
      (!maintenanceSource ||
        !endsAt ||
        !maintenanceReason ||
        !startsAt ||
        Date.parse(startsAt) >= Date.parse(endsAt)))
  )
    throw new Error('供应商元数据上下文无效');

  return Object.freeze({
    authMethod,
    baseUrl,
    callbackMode,
    maintenanceWindow:
      maintenanceSource === null
        ? null
        : Object.freeze({
            endsAt: endsAt as string,
            reason: maintenanceReason as string,
            startsAt: startsAt as string,
          }),
    name,
    ownerAdminId,
  });
}

export interface ProviderMetadataPort {
  write(
    input: Readonly<{
      actorId: string;
      audit: Readonly<{ idempotencyKey: string; reason: string }>;
      expectedVersion?: number;
      kind: 'CREATE' | 'EDIT';
      metadata: ProviderMetadata;
      providerId?: string;
      requestContext: OutboundRequestContext;
      scope: DataScope;
      trustedSessionToken: string;
    }>,
  ): Promise<unknown>;
}

export async function loadProviderDirectoryView({
  context,
  createRequestContext = createOutboundRequestContext,
  port,
}: Readonly<{
  context?: ServerGuardContext;
  createRequestContext?: () => unknown;
  port: ProviderDirectoryPort;
}>) {
  const authorization = await requireAdminAuthorization('providers:read', context);
  const requestContext = parseOutboundRequestContext(createRequestContext());
  const payload = parseProviderDirectoryPayload(
    await port.listProviders({
      requestContext,
      scope: authorization.claims.dataScope,
      trustedSessionToken: authorization.trustedSessionToken,
    }),
  );
  return Object.freeze({
    ...payload,
    actorId: authorization.claims.subjectId,
    canCreate:
      authorization.claims.dataScope !== 'ASSIGNED' &&
      hasPermission(authorization.claims, 'providers:write'),
  });
}

export async function loadProviderDetailView(
  providerId: string,
  {
    context,
    createRequestContext = createOutboundRequestContext,
    port,
  }: Readonly<{
    context?: ServerGuardContext;
    createRequestContext?: () => unknown;
    port: ProviderDetailPort;
  }>,
) {
  if (!isUuidV7(providerId)) throw new Error('供应商标识无效');
  const authorization = await requireAdminAuthorization('providers:read', context);
  const requestContext = parseOutboundRequestContext(createRequestContext());
  const provider = parseProviderDetailPayload(
    await port.getProvider({
      providerId,
      requestContext,
      scope: authorization.claims.dataScope,
      trustedSessionToken: authorization.trustedSessionToken,
    }),
  );
  assertAdminDataScope(authorization.claims, {
    assignedAdminIds: provider.assignedAdminIds,
    ownerAdminId: provider.ownerAdminId,
  });
  const canReadCredentials = hasPermission(authorization.claims, 'credentials:read');
  const canOperateCredentials =
    hasPermission(authorization.claims, 'credentials:rotate') ||
    hasPermission(authorization.claims, 'credentials:disable');
  const credentials = canReadCredentials
    ? provider.credentials
    : canOperateCredentials
      ? Object.freeze(
          provider.credentials.map((credential, index) =>
            Object.freeze({
              id: credential.id,
              label: `凭证 ${String(index + 1)}`,
              status: credential.status,
            }),
          ),
        )
      : Object.freeze([]);
  const providerForClient: ProviderDetailForClient = Object.freeze({ ...provider, credentials });
  return Object.freeze({
    permissions: Object.freeze([...authorization.claims.permissions]),
    provider: providerForClient,
  });
}

const commandPermissions: Readonly<Record<ProviderCommandKind, AdminPermission>> = Object.freeze({
  CIRCUIT_RESET: 'providers:circuit-reset',
  CREDENTIAL_DISABLE: 'credentials:disable',
  CREDENTIAL_ROTATE: 'credentials:rotate',
  HEALTH_PROBE: 'providers:probe',
  PROVIDER_DISABLE: 'providers:disable',
  PROVIDER_ENABLE: 'providers:enable',
});

function formString(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === 'string' ? value : null;
}

export function parseProviderActionReceipt(
  value: unknown,
  expectedProviderId: string,
  expectation?: Readonly<{
    kind?: ProviderCommandKind | 'CREATE' | 'EDIT';
    previousVersion?: number;
  }>,
): ProviderActionReceipt {
  const upstreamReceipt = exactRecord(value, [
    'auditRecordId',
    'providerId',
    'requestId',
    'status',
    'version',
  ]);
  const internalReceipt = upstreamReceipt
    ? null
    : exactRecord(value, ['auditRecordId', 'ok', 'providerId', 'requestId', 'status', 'version']);
  const receipt = upstreamReceipt ?? internalReceipt;
  const status = member(receipt?.status, PROVIDER_STATUSES);
  const version = integer(receipt?.version, 0, Number.MAX_SAFE_INTEGER);
  const expectedStatus =
    expectation?.kind === 'PROVIDER_DISABLE'
      ? 'DISABLED'
      : expectation?.kind === 'PROVIDER_ENABLE'
        ? 'ENABLED'
        : undefined;
  if (
    !receipt ||
    (internalReceipt !== null && internalReceipt.ok !== true) ||
    !isUuidV7(receipt.auditRecordId) ||
    !isUuidV7(receipt.requestId) ||
    !isUuidV7(receipt.providerId) ||
    receipt.providerId.toLowerCase() !== expectedProviderId.toLowerCase() ||
    !status ||
    version === null ||
    (expectedStatus !== undefined && status !== expectedStatus) ||
    (expectation?.previousVersion !== undefined && version <= expectation.previousVersion) ||
    (expectation?.kind === 'CREATE' && version < 1)
  )
    throw new Error('供应商操作回执无效');
  return Object.freeze({
    auditRecordId: receipt.auditRecordId,
    ok: true,
    providerId: receipt.providerId,
    requestId: receipt.requestId,
    status,
    version,
  });
}

export function createProviderCommandAction({
  context,
  createRequestContext = createOutboundRequestContext,
  detailPort,
  port,
}: Readonly<{
  context?: ServerGuardContext;
  createRequestContext?: () => unknown;
  detailPort: ProviderDetailPort;
  port: ProviderCommandPort;
}>) {
  return async function providerCommandAction(formData: FormData): Promise<ProviderActionReceipt> {
    const allowedKeys = new Set([
      'confirmed',
      'credentialId',
      'expectedVersion',
      'intentId',
      'kind',
      'providerId',
      'reason',
      'replacementSecret',
    ]);
    if ([...formData.keys()].some((key) => !allowedKeys.has(key)))
      throw new Error('供应商操作字段无效');
    const kind = formString(formData, 'kind') as ProviderCommandKind | null;
    if (!kind || !(kind in commandPermissions)) throw new Error('供应商操作无效');
    const authorization = await requireAdminAuthorization(commandPermissions[kind], context);
    const providerId = formString(formData, 'providerId');
    const credentialId = formString(formData, 'credentialId');
    const reason = formString(formData, 'reason')?.trim();
    const intent = formString(formData, 'intentId');
    const expectedVersionText = formString(formData, 'expectedVersion');
    if (!isUuidV7(providerId)) throw new Error('供应商标识无效');
    if (!reason || !safeText(reason, 200)) throw new Error('请填写操作原因');
    if (formString(formData, 'confirmed') !== 'true') throw new Error('请确认高风险操作');
    if (!isUuidV7(intent)) throw new Error('幂等操作标识无效');
    if (!expectedVersionText || !/^(?:0|[1-9]\d{0,15})$/u.test(expectedVersionText))
      throw new Error('权威版本无效');
    const expectedVersion = Number(expectedVersionText);
    if (!Number.isSafeInteger(expectedVersion)) throw new Error('权威版本无效');
    const isCredentialCommand = kind === 'CREDENTIAL_DISABLE' || kind === 'CREDENTIAL_ROTATE';
    if (isCredentialCommand !== Boolean(credentialId) || (credentialId && !isUuidV7(credentialId)))
      throw new Error('凭证标识无效');
    const replacementSecret = formString(formData, 'replacementSecret');
    if (kind === 'CREDENTIAL_ROTATE') {
      if (
        !replacementSecret ||
        replacementSecret.length < 12 ||
        replacementSecret.length > 4096 ||
        /[\p{C}]/u.test(replacementSecret)
      )
        throw new Error('替换密钥无效');
    } else if (replacementSecret !== null) throw new Error('供应商操作字段无效');
    const requestContext = parseOutboundRequestContext(createRequestContext());
    const current = parseProviderDetailPayload(
      await detailPort.getProvider({
        providerId,
        requestContext,
        scope: authorization.claims.dataScope,
        trustedSessionToken: authorization.trustedSessionToken,
      }),
    );
    assertAdminDataScope(authorization.claims, {
      assignedAdminIds: current.assignedAdminIds,
      ownerAdminId: current.ownerAdminId,
    });
    if (current.version !== expectedVersion) throw new Error('供应商配置已更新，请刷新后重试');
    if (kind === 'PROVIDER_DISABLE' && current.status !== 'ENABLED')
      throw new Error('供应商状态不允许停用');
    if (kind === 'PROVIDER_ENABLE' && current.status !== 'DISABLED')
      throw new Error('供应商状态不允许启用');
    const credential = credentialId
      ? current.credentials.find((item) => item.id.toLowerCase() === credentialId.toLowerCase())
      : undefined;
    if (credentialId && !credential) throw new Error('凭证不属于当前供应商');
    if (kind === 'CREDENTIAL_DISABLE' && credential?.status === 'DISABLED')
      throw new Error('凭证已经停用');
    if (kind === 'CREDENTIAL_ROTATE' && credential?.status === 'ROTATING')
      throw new Error('凭证正在轮换');
    const result = await port.execute({
      actorId: authorization.claims.subjectId,
      audit: Object.freeze({ idempotencyKey: intent, reason }),
      ...(credentialId ? { credentialId } : {}),
      expectedVersion,
      kind,
      providerId,
      ...(replacementSecret ? { replacementSecret } : {}),
      requestContext,
      scope: authorization.claims.dataScope,
      trustedSessionToken: authorization.trustedSessionToken,
    });
    return parseProviderActionReceipt(result, providerId, {
      kind,
      previousVersion: expectedVersion,
    });
  };
}

export function createProviderMetadataAction({
  context,
  createRequestContext = createOutboundRequestContext,
  detailPort,
  port,
}: Readonly<{
  context?: ServerGuardContext;
  createRequestContext?: () => unknown;
  detailPort: ProviderDetailPort;
  port: ProviderMetadataPort;
}>) {
  return async function providerMetadataAction(formData: FormData): Promise<ProviderActionReceipt> {
    const allowedKeys = new Set([
      'authMethod',
      'baseUrl',
      'callbackMode',
      'confirmed',
      'expectedVersion',
      'intentId',
      'kind',
      'maintenanceEndsAt',
      'maintenanceReason',
      'maintenanceStartsAt',
      'name',
      'ownerAdminId',
      'providerId',
      'reason',
    ]);
    if ([...formData.keys()].some((key) => !allowedKeys.has(key)))
      throw new Error('供应商元数据字段无效');
    const authorization = await requireAdminAuthorization('providers:write', context);
    const kind = formString(formData, 'kind');
    if (kind !== 'CREATE' && kind !== 'EDIT') throw new Error('供应商元数据操作无效');
    const name = safeText(formString(formData, 'name'), 120);
    const baseUrl = safeHttpsUrl(formString(formData, 'baseUrl'));
    const authMethod = member(formString(formData, 'authMethod'), AUTH_METHODS);
    const callbackMode = member(formString(formData, 'callbackMode'), CALLBACK_MODES);
    const ownerAdminId = formString(formData, 'ownerAdminId');
    const reason = formString(formData, 'reason')?.trim();
    const intentId = formString(formData, 'intentId');
    if (!name || !baseUrl || !authMethod || !callbackMode || !isUuidV7(ownerAdminId))
      throw new Error('供应商元数据字段无效');
    if (
      authorization.claims.dataScope === 'OWN' &&
      ownerAdminId.toLowerCase() !== authorization.claims.subjectId.toLowerCase()
    )
      throw new Error('数据范围不允许目标负责人');
    if (authorization.claims.dataScope === 'ASSIGNED' && kind === 'CREATE')
      throw new Error('已分配范围不能创建供应商');
    if (!reason || !safeText(reason, 200)) throw new Error('请填写操作原因');
    if (formString(formData, 'confirmed') !== 'true') throw new Error('请确认高风险操作');
    if (!isUuidV7(intentId)) throw new Error('幂等操作标识无效');
    const startsText = formString(formData, 'maintenanceStartsAt');
    const endsText = formString(formData, 'maintenanceEndsAt');
    const maintenanceReasonText = formString(formData, 'maintenanceReason');
    const hasMaintenance = Boolean(startsText || endsText || maintenanceReasonText);
    const startsAt = hasMaintenance ? utc(startsText) : null;
    const endsAt = hasMaintenance ? utc(endsText) : null;
    const maintenanceReason = hasMaintenance ? safeText(maintenanceReasonText, 256) : null;
    if (
      hasMaintenance &&
      (!startsAt || !endsAt || !maintenanceReason || Date.parse(startsAt) >= Date.parse(endsAt))
    )
      throw new Error('维护窗口无效');
    const providerId = formString(formData, 'providerId');
    const expectedVersionText = formString(formData, 'expectedVersion');
    let expectedVersion: number | undefined;
    if (kind === 'EDIT') {
      if (
        !isUuidV7(providerId) ||
        !expectedVersionText ||
        !/^(?:0|[1-9]\d{0,15})$/u.test(expectedVersionText)
      )
        throw new Error('权威版本无效');
      expectedVersion = Number(expectedVersionText);
      if (!Number.isSafeInteger(expectedVersion)) throw new Error('权威版本无效');
    } else if (providerId || expectedVersionText) throw new Error('供应商元数据字段无效');
    const requestContext = parseOutboundRequestContext(createRequestContext());
    if (kind === 'EDIT') {
      const current = parseProviderDetailPayload(
        await detailPort.getProvider({
          providerId: providerId as string,
          requestContext,
          scope: authorization.claims.dataScope,
          trustedSessionToken: authorization.trustedSessionToken,
        }),
      );
      assertAdminDataScope(authorization.claims, {
        assignedAdminIds: current.assignedAdminIds,
        ownerAdminId: current.ownerAdminId,
      });
      if (
        authorization.claims.dataScope === 'ASSIGNED' &&
        ownerAdminId.toLowerCase() !== current.ownerAdminId?.toLowerCase()
      )
        throw new Error('数据范围不允许变更目标负责人');
      if (current.version !== expectedVersion) throw new Error('供应商配置已更新，请刷新后重试');
    }
    const metadata = Object.freeze({
      authMethod,
      baseUrl,
      callbackMode,
      maintenanceWindow: hasMaintenance
        ? Object.freeze({
            endsAt: endsAt as string,
            reason: maintenanceReason as string,
            startsAt: startsAt as string,
          })
        : null,
      name,
      ownerAdminId,
    });
    const result = await port.write({
      actorId: authorization.claims.subjectId,
      audit: Object.freeze({ idempotencyKey: intentId, reason }),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      kind,
      metadata,
      ...(providerId ? { providerId } : {}),
      requestContext,
      scope: authorization.claims.dataScope,
      trustedSessionToken: authorization.trustedSessionToken,
    });
    const expectedProviderId =
      providerId ??
      (exactRecord(result, ['auditRecordId', 'providerId', 'requestId', 'status', 'version'])
        ?.providerId as string);
    if (!isUuidV7(expectedProviderId)) throw new Error('供应商操作回执无效');
    return parseProviderActionReceipt(result, expectedProviderId, {
      kind,
      ...(expectedVersion === undefined ? {} : { previousVersion: expectedVersion }),
    });
  };
}

export function containsForbiddenSecretKey(value: unknown): boolean {
  try {
    if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) return false;
    return Reflect.ownKeys(value).some(
      (key) => typeof key === 'string' && SECRET_KEY_PATTERN.test(key),
    );
  } catch {
    return true;
  }
}
