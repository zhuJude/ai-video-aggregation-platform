import type { ResourceScopePort, UserStatusPort } from './protected-user-action';
import type {
  UserExportPort,
  WalletAdjustmentApprovalPreview,
  WalletAdjustmentApprovalRequest,
  WalletAdjustmentPreview,
  WalletAdjustmentRequestPort,
} from './user-operation-actions';
import {
  type UserDetailPort,
  type UserDetailTab,
  type UserDetailTabId,
  type UserDetailTabStatus,
  type UserDetailView,
  USER_DETAIL_TAB_IDS,
  UserDetailPortError,
} from './user-detail-view-loader';
import {
  isValidSearchHandle,
  isValidShortLivedSearchExpiry,
  validateUserFilters,
  type ExactPhoneLookupPort,
  type UserFilters,
} from './user-view-loaders';
import {
  DEFAULT_UPSTREAM_DEADLINE_MS,
  SafeHttpRequestError,
  fetchWithDeadline,
  isValidDeadline,
} from './http-deadline';
import {
  type SafeTelemetryEvent,
  type SafeTelemetryPort,
  createSafeTelemetryEvent,
  defaultSafeTelemetry,
  recordTechnicalFailure,
} from './safe-telemetry';
import { isSameUuidV7, isUuidV7 } from './uuid-v7';
import {
  isCoherentPointsAdjustment,
  isMainlandPhone,
  isMaskedMainlandPhone,
  isPointsString,
  isUtcIso8601Z,
} from './frozen-scalars';
import {
  createOutboundRequestContext,
  isOutboundRequestContext,
  parseOutboundRequestContext,
  type OutboundRequestContext,
} from './outbound-request-context';
import { containsSensitivePhoneLikeValue, isSafeDirectoryCursor } from './sensitive-query';
import { isPhoneFreeBoundedText, isPhoneFreeHttpsUrl } from './phone-free-egress';

type OperationsEnvironment = Readonly<{
  apiUrl?: string | undefined;
  kmsIdentityReference?: string | undefined;
}>;

type HttpUserOperationPortOptions = Readonly<{
  deadlineMs?: number;
  fetchImpl?: typeof fetch;
  telemetry?: SafeTelemetryPort;
}>;

export interface UserDirectoryPort {
  searchUsers(
    input: Readonly<{
      cursor?: string;
      filters?: UserFilters;
      query: string;
      requestContext?: OutboundRequestContext;
      trustedSessionToken: string;
    }>,
  ): Promise<Readonly<{ items: readonly unknown[]; nextCursor: string | null }>>;
}

const detailTabIds = new Set<UserDetailTabId>([
  'account',
  'tasks',
  'wallet',
  'orders',
  'tickets',
  'audit',
]);
const detailTabStatuses = new Set<UserDetailTabStatus>(['READY', 'EMPTY', 'ERROR']);
const directoryStatuses = new Set(['ACTIVE', 'SUSPENDED', 'CLOSED']);
const directoryRegistrationSources = new Set(['WEB', 'INVITE', 'PARTNER']);
const directorySpendingTiers = new Set(['LOW', 'MEDIUM', 'HIGH']);
const directoryTagPattern = /^[\p{L}\p{N}_ -]{1,64}$/u;
const TASK_STATUSES = [
  'QUOTED',
  'RESERVED',
  'QUEUED',
  'SUBMITTING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'EXPIRED',
  'SETTLED',
  'REFUNDED',
] as const;
const PAYMENT_STATUSES = ['PENDING', 'PAID', 'CLOSED', 'REFUNDED', 'FAILED'] as const;
const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
const taskStatuses: ReadonlySet<string> = new Set(TASK_STATUSES);
const paymentStatuses: ReadonlySet<string> = new Set(PAYMENT_STATUSES);
const ticketStatuses: ReadonlySet<string> = new Set(TICKET_STATUSES);

function boundedText(value: unknown, maxLength = 256): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

function phoneFreeText(value: unknown, maxLength = 256): string | null {
  return isPhoneFreeBoundedText(value, maxLength) ? value : null;
}

function detailRows(
  value: unknown,
  allowedStatuses: ReadonlySet<string>,
): readonly Readonly<{ createdAt: string; id: string; status: string }>[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const rows = value.map((item) => {
    if (!item || typeof item !== 'object') return null;
    const candidate = item as Record<string, unknown>;
    const id = boundedText(candidate.id, 128);
    const status = boundedText(candidate.status, 64);
    const createdAt = boundedText(candidate.createdAt, 64);
    return isUuidV7(id) && status && allowedStatuses.has(status) && isUtcIso8601Z(createdAt)
      ? { createdAt, id, status }
      : null;
  });
  return rows.every((row) => row !== null) ? rows : null;
}

function boundedList(
  value: unknown,
  map: (candidate: Record<string, unknown>) => object | null,
): readonly object[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const entries = value.map((item) =>
    item && typeof item === 'object' ? map(item as Record<string, unknown>) : null,
  );
  return entries.every((entry) => entry !== null) ? entries : null;
}

function parseDirectoryRows(value: unknown): readonly object[] | null {
  return boundedList(value, (row) => {
    const id = boundedText(row.id, 64);
    const displayName = phoneFreeText(row.displayName, 256);
    const phoneMasked = boundedText(row.phoneMasked, 32);
    const status = boundedText(row.status, 64);
    const registrationSource = row.registrationSource;
    const spendingTier = row.spendingTier;
    const tags = row.tags;
    if (
      !isUuidV7(id) ||
      !displayName ||
      !isMaskedMainlandPhone(phoneMasked) ||
      row.phone !== undefined ||
      !status ||
      !directoryStatuses.has(status) ||
      (registrationSource !== undefined &&
        (typeof registrationSource !== 'string' ||
          !directoryRegistrationSources.has(registrationSource))) ||
      (spendingTier !== undefined &&
        (typeof spendingTier !== 'string' || !directorySpendingTiers.has(spendingTier))) ||
      (tags !== undefined &&
        (!Array.isArray(tags) ||
          tags.length > 16 ||
          !tags.every(
            (tag) =>
              typeof tag === 'string' &&
              directoryTagPattern.test(tag) &&
              !containsSensitivePhoneLikeValue(tag),
          )))
    )
      return null;
    return {
      displayName,
      id,
      phoneMasked,
      status,
      ...(registrationSource === undefined ? {} : { registrationSource }),
      ...(spendingTier === undefined ? {} : { spendingTier }),
      ...(tags === undefined ? {} : { tags }),
    };
  });
}

function parseUserDetail(payload: unknown): UserDetailView | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as Record<string, unknown>;
  if (
    !candidate.user ||
    typeof candidate.user !== 'object' ||
    !Array.isArray(candidate.tabs) ||
    candidate.tabs.length < 1 ||
    candidate.tabs.length > detailTabIds.size ||
    !Array.isArray(candidate.deniedTabs) ||
    typeof candidate.canRequestWalletAdjustment !== 'boolean' ||
    !Array.isArray(candidate.allowedStatusTransitions) ||
    !Array.isArray(candidate.eligibleApprovers)
  )
    return null;
  const user = candidate.user as Record<string, unknown>;
  const userId = boundedText(user.id, 64);
  const displayName = phoneFreeText(user.displayName, 256);
  const phoneMasked = boundedText(user.phoneMasked, 32);
  const identityStatus = boundedText(user.status, 64);
  if (
    !isUuidV7(userId) ||
    !displayName ||
    !isMaskedMainlandPhone(phoneMasked) ||
    user.phone !== undefined ||
    !identityStatus ||
    !directoryStatuses.has(identityStatus)
  )
    return null;
  const seen = new Set<string>();
  const tabs: UserDetailTab[] = [];
  for (const value of candidate.tabs) {
    if (!value || typeof value !== 'object') return null;
    const tab = value as Record<string, unknown>;
    const id = tab.id;
    const status = tab.status;
    if (
      typeof id !== 'string' ||
      !detailTabIds.has(id as UserDetailTabId) ||
      seen.has(id) ||
      typeof status !== 'string' ||
      !detailTabStatuses.has(status as UserDetailTabStatus)
    )
      return null;
    seen.add(id);
    if (id === 'account') {
      if (
        !tab.account ||
        typeof tab.account !== 'object' ||
        !tab.session ||
        typeof tab.session !== 'object'
      )
        return null;
      const account = tab.account as Record<string, unknown>;
      const session = tab.session as Record<string, unknown>;
      const accountDisplayName = phoneFreeText(account.displayName, 256);
      const accountPhoneMasked = boundedText(account.phoneMasked, 32);
      const accountStatus = boundedText(account.status, 64);
      const registrationSource = phoneFreeText(account.registrationSource, 64);
      const spendingTier = phoneFreeText(account.spendingTier, 64);
      const tags = boundedList(account.tags, (tag) => {
        const value = phoneFreeText(tag.value ?? tag.name, 64);
        return value ? { value } : null;
      });
      const createdAt = boundedText(account.createdAt, 64);
      const sessionStatus = phoneFreeText(session.status, 64);
      const lastActiveAt = boundedText(session.lastActiveAt, 64);
      const devices = boundedList(session.devices, (device) => {
        const deviceId = boundedText(device.id, 128);
        const platform = phoneFreeText(device.platform, 64);
        const deviceStatus = phoneFreeText(device.status, 64);
        const lastSeenAt = boundedText(device.lastSeenAt, 64);
        return isUuidV7(deviceId) && platform && deviceStatus && isUtcIso8601Z(lastSeenAt)
          ? { id: deviceId, lastSeenAt, platform, status: deviceStatus }
          : null;
      });
      const loginRecords = boundedList(session.loginRecords, (record) => {
        const recordId = boundedText(record.id, 128);
        const deviceLabel = phoneFreeText(record.deviceLabel, 128);
        const recordStatus = phoneFreeText(record.status, 64);
        const occurredAt = boundedText(record.occurredAt, 64);
        return isUuidV7(recordId) && deviceLabel && recordStatus && isUtcIso8601Z(occurredAt)
          ? { deviceLabel, id: recordId, occurredAt, status: recordStatus }
          : null;
      });
      if (
        !accountDisplayName ||
        !isMaskedMainlandPhone(accountPhoneMasked) ||
        account.phone !== undefined ||
        !accountStatus ||
        !directoryStatuses.has(accountStatus) ||
        accountStatus !== identityStatus ||
        !registrationSource ||
        !spendingTier ||
        !tags ||
        !isUtcIso8601Z(createdAt) ||
        !sessionStatus ||
        !isUtcIso8601Z(lastActiveAt) ||
        !devices ||
        !loginRecords
      )
        return null;
      tabs.push({
        account: {
          createdAt,
          displayName: accountDisplayName,
          phoneMasked: accountPhoneMasked,
          registrationSource,
          status: accountStatus as 'ACTIVE' | 'SUSPENDED' | 'CLOSED',
          spendingTier,
          tags: tags.map((tag) => (tag as { value: string }).value),
        },
        id,
        session: {
          devices: devices as never,
          lastActiveAt,
          loginRecords: loginRecords as never,
          status: sessionStatus,
        },
        status: status as UserDetailTabStatus,
      });
      continue;
    }
    if (id === 'wallet') {
      const balance = boundedText(tab.balance, 64);
      const frozenBalance = boundedText(tab.frozenBalance, 64);
      const history = (value: unknown, expectedDirection: 'CREDIT' | 'DEBIT') =>
        boundedList(value, (entry) => {
          const entryId = boundedText(entry.id, 128);
          const points = boundedText(entry.points, 64);
          const entryStatus = phoneFreeText(entry.status, 64);
          const occurredAt = boundedText(entry.occurredAt, 64);
          return isUuidV7(entryId) &&
            isPointsString(points) &&
            entryStatus &&
            isUtcIso8601Z(occurredAt) &&
            entry.direction === expectedDirection
            ? { direction: expectedDirection, id: entryId, occurredAt, points, status: entryStatus }
            : null;
        });
      const adjustmentHistory = boundedList(tab.adjustmentHistory, (entry) => {
        const entryId = boundedText(entry.id, 128);
        const points = boundedText(entry.points, 64);
        const entryStatus = phoneFreeText(entry.status, 64);
        const occurredAt = boundedText(entry.occurredAt, 64);
        const direction = entry.direction;
        const hasApprovalMetadata =
          entry.approverId !== undefined ||
          entry.requestedById !== undefined ||
          entry.version !== undefined;
        const validApprovalMetadata =
          isUuidV7(entry.approverId) &&
          isUuidV7(entry.requestedById) &&
          Number.isSafeInteger(entry.version) &&
          Number(entry.version) > 0;
        return isUuidV7(entryId) &&
          isPointsString(points) &&
          entryStatus &&
          isUtcIso8601Z(occurredAt) &&
          (direction === 'CREDIT' || direction === 'DEBIT') &&
          (!hasApprovalMetadata || validApprovalMetadata)
          ? {
              direction,
              id: entryId,
              occurredAt,
              points,
              status: entryStatus,
              ...(hasApprovalMetadata
                ? {
                    approverId: entry.approverId as string,
                    requestedById: entry.requestedById as string,
                    version: entry.version as number,
                  }
                : {}),
            }
          : null;
      });
      const rechargeHistory = history(tab.rechargeHistory, 'CREDIT');
      const consumptionHistory = history(tab.consumptionHistory, 'DEBIT');
      if (
        !isPointsString(balance) ||
        !isPointsString(frozenBalance) ||
        tab.unit !== 'POINTS' ||
        tab.currency !== undefined ||
        !rechargeHistory ||
        !consumptionHistory ||
        !adjustmentHistory
      )
        return null;
      tabs.push({
        adjustmentHistory: adjustmentHistory as never,
        balance,
        consumptionHistory: consumptionHistory as never,
        frozenBalance,
        id,
        rechargeHistory: rechargeHistory as never,
        status: status as UserDetailTabStatus,
        unit: 'POINTS',
      });
      continue;
    }
    if (id === 'audit') {
      if (!Array.isArray(tab.items) || tab.items.length > 100) return null;
      const items = tab.items.map((item) => {
        if (!item || typeof item !== 'object') return null;
        const audit = item as Record<string, unknown>;
        const action = phoneFreeText(audit.action, 128);
        const auditId = boundedText(audit.id, 128);
        const occurredAt = boundedText(audit.occurredAt, 64);
        return action && isUuidV7(auditId) && isUtcIso8601Z(occurredAt)
          ? { action, id: auditId, occurredAt }
          : null;
      });
      if (!items.every((item) => item !== null)) return null;
      tabs.push({ id, items, status: status as UserDetailTabStatus });
      continue;
    }
    const allowedStatuses =
      id === 'tasks' ? taskStatuses : id === 'orders' ? paymentStatuses : ticketStatuses;
    const items = detailRows(tab.items, allowedStatuses);
    if (!items) return null;
    tabs.push({ id, items, status: status as UserDetailTabStatus } as UserDetailTab);
  }
  const account = tabs.find(
    (tab): tab is Extract<UserDetailTab, { id: 'account' }> => tab.id === 'account',
  );
  if (
    !account ||
    account.account.displayName !== displayName ||
    account.account.phoneMasked !== phoneMasked ||
    account.account.status !== identityStatus
  )
    return null;
  const deniedTabValues = candidate.deniedTabs as unknown[];
  if (
    !deniedTabValues.every(
      (id): id is UserDetailTabId =>
        typeof id === 'string' && detailTabIds.has(id as UserDetailTabId),
    )
  )
    return null;
  const deniedTabs = deniedTabValues;
  if (
    new Set(deniedTabs).size !== deniedTabs.length ||
    deniedTabs.includes('account') ||
    deniedTabs.some((id) => seen.has(id)) ||
    new Set([...seen, ...deniedTabs]).size !== USER_DETAIL_TAB_IDS.length
  )
    return null;
  if (candidate.canRequestWalletAdjustment && !seen.has('wallet')) return null;
  const allowedStatusTransitions = candidate.allowedStatusTransitions;
  const expectedTransition =
    account.account.status === 'ACTIVE'
      ? 'SUSPENDED'
      : account.account.status === 'SUSPENDED'
        ? 'ACTIVE'
        : undefined;
  if (
    allowedStatusTransitions.length > 1 ||
    !allowedStatusTransitions.every(
      (transition) => transition === 'ACTIVE' || transition === 'SUSPENDED',
    ) ||
    (allowedStatusTransitions.length === 1 && allowedStatusTransitions[0] !== expectedTransition) ||
    (!expectedTransition && allowedStatusTransitions.length !== 0)
  )
    return null;
  const eligibleApprovers = boundedList(candidate.eligibleApprovers, (approver) => {
    const id = boundedText(approver.id, 128);
    const eligibleDisplayName = phoneFreeText(approver.displayName, 256);
    return isUuidV7(id) && eligibleDisplayName ? { displayName: eligibleDisplayName, id } : null;
  });
  if (
    !eligibleApprovers ||
    new Set(eligibleApprovers.map((approver) => (approver as { id: string }).id)).size !==
      eligibleApprovers.length
  )
    return null;
  return {
    allowedStatusTransitions: allowedStatusTransitions as readonly ('ACTIVE' | 'SUSPENDED')[],
    canRequestWalletAdjustment: candidate.canRequestWalletAdjustment,
    deniedTabs: deniedTabs as readonly UserDetailTabId[],
    eligibleApprovers: eligibleApprovers as readonly Readonly<{
      displayName: string;
      id: string;
    }>[],
    tabs,
    user: {
      displayName,
      id: userId,
      phoneMasked,
      status: identityStatus as 'ACTIVE' | 'SUSPENDED' | 'CLOSED',
    },
  };
}

function configuration(
  environment: OperationsEnvironment,
  options: HttpUserOperationPortOptions,
): {
  baseUrl: URL;
  deadlineMs: number;
  fetchImpl: typeof fetch;
  kmsIdentityReference: string;
  telemetry: SafeTelemetryPort;
} {
  const telemetry = options.telemetry ?? defaultSafeTelemetry;
  const deadlineMs = options.deadlineMs ?? DEFAULT_UPSTREAM_DEADLINE_MS;

  try {
    if (!environment.apiUrl || !environment.kmsIdentityReference?.trim()) {
      throw new Error('missing');
    }
    const baseUrl = new URL(environment.apiUrl);
    if (
      baseUrl.protocol !== 'https:' ||
      baseUrl.username ||
      baseUrl.password ||
      !isValidDeadline(deadlineMs)
    ) {
      throw new Error('invalid');
    }
    return {
      baseUrl,
      deadlineMs,
      fetchImpl: options.fetchImpl ?? fetch,
      kmsIdentityReference: environment.kmsIdentityReference,
      telemetry,
    };
  } catch (cause) {
    throw recordTechnicalFailure(
      telemetry,
      createSafeTelemetryEvent('operations.config', 'INVALID_CONFIG'),
      new Error('Admin operations configuration is unavailable', { cause }),
    );
  }
}

export function createHttpUserOperationPorts(
  environment: OperationsEnvironment = {
    apiUrl: process.env.ADMIN_OPERATIONS_API_URL,
    kmsIdentityReference: process.env.ADMIN_OPERATIONS_KMS_IDENTITY_REF,
  },
  options: HttpUserOperationPortOptions = {},
): Readonly<{
  adjustmentPort: WalletAdjustmentRequestPort;
  directoryPort: UserDirectoryPort;
  exportPort: UserExportPort;
  exactPhonePort: ExactPhoneLookupPort;
  detailPort: UserDetailPort;
  scopePort: ResourceScopePort;
  statusPort: UserStatusPort;
}> {
  const config = configuration(environment, options);

  async function protectedFetch<T>(
    pathname: string,
    init: RequestInit,
    operation: SafeTelemetryEvent['operation'],
    consume: (
      response: Response,
      signal: AbortSignal,
      requestContext: OutboundRequestContext,
    ) => Promise<T> | T,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    const requestContext = parseOutboundRequestContext({
      correlationId: headers.get('X-Correlation-Id') ?? '',
      traceId: headers.get('X-Trace-Id') ?? '',
    });
    try {
      return await fetchWithDeadline(
        config.fetchImpl,
        new URL(pathname, config.baseUrl),
        init,
        config.deadlineMs,
        (response, signal) => consume(response, signal, requestContext),
      );
    } catch (error) {
      if (!(error instanceof SafeHttpRequestError)) {
        throw error;
      }
      throw recordTechnicalFailure(
        config.telemetry,
        createSafeTelemetryEvent(operation, error.reason, requestContext),
        error,
      );
    }
  }

  function baseHeaders(
    requestContext: OutboundRequestContext | undefined,
    operation: SafeTelemetryEvent['operation'],
  ): Headers {
    const resolvedContext =
      requestContext === undefined ? createOutboundRequestContext() : requestContext;
    if (!isOutboundRequestContext(resolvedContext)) {
      throw recordedFailure(
        operation,
        'DOWNSTREAM_DENIED',
        undefined,
        new Error('Invalid outbound request context'),
      );
    }
    return new Headers({
      Accept: 'application/json',
      'X-Correlation-Id': resolvedContext.correlationId,
      'X-Service-Identity-Ref': config.kmsIdentityReference,
      'X-Trace-Id': resolvedContext.traceId,
    });
  }

  function recordedFailure<E extends Error>(
    operation: SafeTelemetryEvent['operation'],
    reason: SafeTelemetryEvent['reason'],
    requestContext: OutboundRequestContext | undefined,
    error: E,
  ): E {
    return recordTechnicalFailure(
      config.telemetry,
      createSafeTelemetryEvent(operation, reason, requestContext),
      error,
    );
  }

  function safeTelemetryContext(value: unknown): OutboundRequestContext | undefined {
    if (value === undefined) return undefined;
    try {
      return parseOutboundRequestContext(value);
    } catch {
      return undefined;
    }
  }

  return {
    exactPhonePort: {
      async lookupExactPhone(input) {
        const operation = 'operations.user.exact-phone-lookup';
        if (!input.trustedSessionToken || !isMainlandPhone(input.phone))
          throw new Error('Invalid exact phone lookup');
        const headers = baseHeaders(input.requestContext, operation);
        headers.set('Content-Type', 'application/json');
        headers.set('X-Admin-Session-Token', input.trustedSessionToken);
        return protectedFetch(
          '/v1/admin/users/exact-phone-lookups',
          {
            body: JSON.stringify({ phone: input.phone, scope: input.scope }),
            cache: 'no-store',
            headers,
            method: 'POST',
          },
          operation,
          async (response, signal, requestContext) => {
            if (!response.ok) {
              const reason =
                response.status === 401 || response.status === 403
                  ? 'DOWNSTREAM_DENIED'
                  : 'UPSTREAM_FAILURE';
              throw recordedFailure(
                operation,
                reason,
                requestContext,
                new Error('Exact phone lookup denied'),
              );
            }
            let payload: unknown;
            try {
              payload = await response.json();
            } catch (error) {
              if (signal.aborted) throw error;
              payload = null;
            }
            if (!payload || typeof payload !== 'object')
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid exact phone lookup response'),
              );
            const candidate = payload as Record<string, unknown>;
            const items = parseDirectoryRows(candidate.items);
            if (
              !items ||
              !isValidSearchHandle(candidate.searchHandle) ||
              !isValidShortLivedSearchExpiry(candidate.expiresAt)
            )
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid exact phone lookup response'),
              );
            return { expiresAt: candidate.expiresAt, items, searchHandle: candidate.searchHandle };
          },
        );
      },
    },
    detailPort: {
      async getUserDetail(input) {
        const operation = 'operations.user.detail-read';
        if (!input.trustedSessionToken || !isUuidV7(input.userId)) {
          throw recordedFailure(
            operation,
            'DOWNSTREAM_DENIED',
            safeTelemetryContext(input.requestContext),
            new UserDetailPortError('FORBIDDEN'),
          );
        }
        const headers = baseHeaders(input.requestContext, operation);
        headers.set('X-Admin-Session-Token', input.trustedSessionToken);
        return protectedFetch(
          `/v1/admin/users/${encodeURIComponent(input.userId)}/detail`,
          { cache: 'no-store', headers, method: 'GET' },
          operation,
          async (response, signal, requestContext) => {
            if (!response.ok) {
              const code =
                response.status === 404
                  ? 'NOT_FOUND'
                  : response.status === 401 || response.status === 403
                    ? 'FORBIDDEN'
                    : 'DEPENDENCY';
              if (code === 'NOT_FOUND') throw new UserDetailPortError(code);
              throw recordedFailure(
                operation,
                code === 'FORBIDDEN' ? 'DOWNSTREAM_DENIED' : 'UPSTREAM_FAILURE',
                requestContext,
                new UserDetailPortError(code),
              );
            }
            let payload: unknown;
            try {
              payload = await response.json();
            } catch (error) {
              if (signal.aborted) throw error;
              payload = null;
            }
            const view = parseUserDetail(payload);
            if (!view) {
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new UserDetailPortError('DEPENDENCY'),
              );
            }
            if (!isSameUuidV7(view.user.id, input.userId)) {
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new UserDetailPortError('DEPENDENCY'),
              );
            }
            return view;
          },
        );
      },
    },
    scopePort: {
      async getUserScope(input) {
        const operation = 'operations.scope.read';
        if (!input.trustedSessionToken || !isUuidV7(input.userId)) {
          throw recordedFailure(
            operation,
            'DOWNSTREAM_DENIED',
            safeTelemetryContext(input.requestContext),
            new Error('Invalid scope lookup context'),
          );
        }
        const headers = baseHeaders(input.requestContext, operation);
        headers.set('X-Admin-Session-Token', input.trustedSessionToken);
        return protectedFetch(
          `/v1/admin/users/${encodeURIComponent(input.userId)}/authorization-scope`,
          {
            cache: 'no-store',
            headers,
          },
          operation,
          async (response, signal, requestContext) => {
            if (!response.ok) {
              const reason =
                response.status === 401 || response.status === 403
                  ? 'DOWNSTREAM_DENIED'
                  : 'UPSTREAM_FAILURE';
              throw recordedFailure(
                operation,
                reason,
                requestContext,
                new Error('Unable to resolve resource scope'),
              );
            }

            let payload: unknown;
            try {
              payload = await response.json();
            } catch (error) {
              if (signal.aborted) {
                throw error;
              }
              payload = null;
            }
            if (!payload || typeof payload !== 'object') {
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid resource scope response'),
              );
            }
            const candidate = payload as Partial<{
              userId: string;
              ownerAdminId: string | null;
              assignedAdminIds: string[];
            }>;
            if (
              !isSameUuidV7(candidate.userId, input.userId) ||
              !isUuidV7(candidate.userId) ||
              !Array.isArray(candidate.assignedAdminIds) ||
              candidate.assignedAdminIds.length > 100 ||
              !candidate.assignedAdminIds.every((id) => isUuidV7(id)) ||
              new Set(candidate.assignedAdminIds.map((id) => id.toLowerCase())).size !==
                candidate.assignedAdminIds.length ||
              (candidate.ownerAdminId !== null && !isUuidV7(candidate.ownerAdminId))
            ) {
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid resource scope response'),
              );
            }

            return {
              ownerAdminId: candidate.ownerAdminId,
              assignedAdminIds: candidate.assignedAdminIds,
            };
          },
        );
      },
    },
    statusPort: {
      async requestStatusChange(input) {
        const operation = 'operations.user.status-change';
        if (
          !input.trustedSessionToken ||
          !isUuidV7(input.userId) ||
          !isUuidV7(input.audit.idempotencyKey) ||
          !isPhoneFreeBoundedText(input.reason, 200)
        )
          throw new Error('Invalid status change context');
        const headers = baseHeaders(input.requestContext, operation);
        headers.set('Content-Type', 'application/json');
        headers.set('Idempotency-Key', input.audit.idempotencyKey);
        headers.set('X-Admin-Session-Token', input.trustedSessionToken);
        return protectedFetch(
          `/v1/admin/users/${encodeURIComponent(input.userId)}/status-change-requests`,
          {
            body: JSON.stringify({ reason: input.reason, targetStatus: input.targetStatus }),
            cache: 'no-store',
            headers,
            method: 'POST',
          },
          operation,
          async (response, signal, requestContext) => {
            if (response.status !== 202) {
              const reason =
                response.status === 401 || response.status === 403 || response.status === 409
                  ? 'DOWNSTREAM_DENIED'
                  : 'UPSTREAM_FAILURE';
              throw recordedFailure(
                operation,
                reason,
                requestContext,
                new Error('Status change denied'),
              );
            }
            let payload: unknown;
            try {
              payload = await response.json();
            } catch (error) {
              if (signal.aborted) throw error;
              payload = null;
            }
            if (!payload || typeof payload !== 'object')
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid status change response'),
              );
            const candidate = payload as Record<string, unknown>;
            const auditRecordId = boundedText(candidate.auditRecordId, 128);
            const requestId = boundedText(candidate.requestId, 128);
            if (!isUuidV7(auditRecordId) || !isUuidV7(requestId) || candidate.status !== undefined)
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid status change response'),
              );
            return { auditRecordId, requestId };
          },
        );
      },
    },
    adjustmentPort: {
      async getAdjustmentRequest(input) {
        const operation = 'operations.user.wallet-adjustment-request-detail';
        if (!input.trustedSessionToken || !isUuidV7(input.userId) || !isUuidV7(input.requestId))
          throw new Error('Invalid adjustment request context');
        const headers = baseHeaders(input.requestContext, operation);
        headers.set('X-Admin-Session-Token', input.trustedSessionToken);
        return protectedFetch(
          `/v1/admin/users/${encodeURIComponent(input.userId)}/wallet-adjustment-requests/${encodeURIComponent(input.requestId)}`,
          { cache: 'no-store', headers, method: 'GET' },
          operation,
          async (response, signal, requestContext) => {
            if (!response.ok) {
              const reason =
                response.status === 401 || response.status === 403 || response.status === 409
                  ? 'DOWNSTREAM_DENIED'
                  : 'UPSTREAM_FAILURE';
              throw recordedFailure(
                operation,
                reason,
                requestContext,
                new Error('Adjustment request detail denied'),
              );
            }
            let payload: unknown;
            try {
              payload = await response.json();
            } catch (error) {
              if (signal.aborted) throw error;
              payload = null;
            }
            if (!payload || typeof payload !== 'object')
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid adjustment request detail'),
              );
            const candidate = payload as Record<string, unknown>;
            if (
              !isUuidV7(candidate.id) ||
              !isUuidV7(candidate.userId) ||
              !isUuidV7(candidate.requestedById) ||
              !isUuidV7(candidate.approverId) ||
              !isPointsString(candidate.points) ||
              candidate.points === '0' ||
              (candidate.direction !== 'CREDIT' && candidate.direction !== 'DEBIT') ||
              !['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED'].includes(
                String(candidate.status),
              ) ||
              !Number.isSafeInteger(candidate.version) ||
              Number(candidate.version) < 1
            )
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid adjustment request detail'),
              );
            return {
              approverId: candidate.approverId,
              direction: candidate.direction,
              id: candidate.id,
              points: candidate.points,
              requestedById: candidate.requestedById,
              status: candidate.status,
              userId: candidate.userId,
              version: candidate.version,
            } as WalletAdjustmentApprovalRequest;
          },
        );
      },
      async previewApproval(input) {
        const operation = 'operations.user.wallet-adjustment-approval-preview';
        if (
          !input.trustedSessionToken ||
          !isUuidV7(input.userId) ||
          !isUuidV7(input.requestId) ||
          !isUuidV7(input.audit.idempotencyKey) ||
          !Number.isSafeInteger(input.expectedVersion) ||
          input.expectedVersion < 1 ||
          !isPhoneFreeBoundedText(input.reason, 200)
        )
          throw new Error('Invalid approval preview context');
        const headers = baseHeaders(input.requestContext, operation);
        headers.set('Content-Type', 'application/json');
        headers.set('Idempotency-Key', input.audit.idempotencyKey);
        headers.set('X-Admin-Session-Token', input.trustedSessionToken);
        return protectedFetch(
          `/v1/admin/users/${encodeURIComponent(input.userId)}/wallet-adjustment-requests/${encodeURIComponent(input.requestId)}/approval-previews`,
          {
            body: JSON.stringify({
              audit: input.audit,
              expectedVersion: input.expectedVersion,
              reason: input.reason,
            }),
            cache: 'no-store',
            headers,
            method: 'POST',
          },
          operation,
          async (response, signal, requestContext) => {
            if (!response.ok) {
              const reason =
                response.status === 401 || response.status === 403 || response.status === 409
                  ? 'DOWNSTREAM_DENIED'
                  : 'UPSTREAM_FAILURE';
              throw recordedFailure(
                operation,
                reason,
                requestContext,
                new Error('Approval preview denied'),
              );
            }
            let payload: unknown;
            try {
              payload = await response.json();
            } catch (error) {
              if (signal.aborted) throw error;
              payload = null;
            }
            if (!payload || typeof payload !== 'object')
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid approval preview'),
              );
            const candidate = payload as Record<string, unknown>;
            const allowedKeys = new Set([
              'expiresAt',
              'impact',
              'preflightToken',
              'resultStatus',
              'resultVersion',
            ]);
            if (
              Object.keys(candidate).length !== allowedKeys.size ||
              !Object.keys(candidate).every((key) => allowedKeys.has(key)) ||
              !isUtcIso8601Z(candidate.expiresAt) ||
              !isPhoneFreeBoundedText(candidate.impact, 256) ||
              !isPhoneFreeBoundedText(candidate.preflightToken, 512) ||
              candidate.resultStatus !== 'APPROVED' ||
              !Number.isSafeInteger(candidate.resultVersion) ||
              Number(candidate.resultVersion) < 2
            )
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid approval preview'),
              );
            return {
              expiresAt: candidate.expiresAt,
              impact: candidate.impact,
              preflightToken: candidate.preflightToken,
              resultStatus: 'APPROVED',
              resultVersion: candidate.resultVersion as number,
            } satisfies WalletAdjustmentApprovalPreview;
          },
        );
      },
      async approveAdjustment(input) {
        const operation = 'operations.user.wallet-adjustment-approval';
        if (
          !input.trustedSessionToken ||
          !isUuidV7(input.userId) ||
          !isUuidV7(input.requestId) ||
          !isUuidV7(input.audit.idempotencyKey) ||
          !Number.isSafeInteger(input.expectedVersion) ||
          input.expectedVersion < 1 ||
          !isPhoneFreeBoundedText(input.reason, 200) ||
          !isPhoneFreeBoundedText(input.preflightToken, 512)
        )
          throw new Error('Invalid adjustment approval context');
        const headers = baseHeaders(input.requestContext, operation);
        headers.set('Content-Type', 'application/json');
        headers.set('Idempotency-Key', input.audit.idempotencyKey);
        headers.set('X-Admin-Session-Token', input.trustedSessionToken);
        return protectedFetch(
          `/v1/admin/users/${encodeURIComponent(input.userId)}/wallet-adjustment-requests/${encodeURIComponent(input.requestId)}/approvals`,
          {
            body: JSON.stringify({
              audit: input.audit,
              expectedVersion: input.expectedVersion,
              preflightToken: input.preflightToken,
              reason: input.reason,
            }),
            cache: 'no-store',
            headers,
            method: 'POST',
          },
          operation,
          async (response, signal, requestContext) => {
            if (!response.ok) {
              const reason =
                response.status === 401 || response.status === 403 || response.status === 409
                  ? 'DOWNSTREAM_DENIED'
                  : 'UPSTREAM_FAILURE';
              throw recordedFailure(
                operation,
                reason,
                requestContext,
                new Error('Adjustment approval denied'),
              );
            }
            let payload: unknown;
            try {
              payload = await response.json();
            } catch (error) {
              if (signal.aborted) throw error;
              payload = null;
            }
            if (!payload || typeof payload !== 'object')
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid adjustment approval receipt'),
              );
            const candidate = payload as Record<string, unknown>;
            if (
              !isUuidV7(candidate.auditRecordId) ||
              !isUuidV7(candidate.requestId) ||
              !isUuidV7(candidate.userId) ||
              candidate.status !== 'APPROVED' ||
              !Number.isSafeInteger(candidate.version) ||
              Number(candidate.version) < 2
            )
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid adjustment approval receipt'),
              );
            return {
              auditRecordId: candidate.auditRecordId,
              requestId: candidate.requestId,
              status: 'APPROVED' as const,
              userId: candidate.userId,
              version: candidate.version as number,
            };
          },
        );
      },
      async getEligibleApprovers(input) {
        const operation = 'operations.user.eligible-approvers';
        if (!input.trustedSessionToken || !isUuidV7(input.userId))
          throw new Error('Invalid eligible approver context');
        const headers = baseHeaders(input.requestContext, operation);
        headers.set('Content-Type', 'application/json');
        headers.set('X-Admin-Session-Token', input.trustedSessionToken);
        return protectedFetch(
          `/v1/admin/users/${encodeURIComponent(input.userId)}/eligible-approvers`,
          {
            body: JSON.stringify({ scope: input.dataScope }),
            cache: 'no-store',
            headers,
            method: 'POST',
          },
          operation,
          async (response, signal, requestContext) => {
            if (!response.ok) {
              const reason =
                response.status === 401 || response.status === 403
                  ? 'DOWNSTREAM_DENIED'
                  : 'UPSTREAM_FAILURE';
              throw recordedFailure(
                operation,
                reason,
                requestContext,
                new Error('Eligible approvers denied'),
              );
            }
            let payload: unknown;
            try {
              payload = await response.json();
            } catch (error) {
              if (signal.aborted) throw error;
              payload = null;
            }
            if (!Array.isArray(payload) || payload.length > 100)
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid eligible approvers'),
              );
            const approvers = payload.map((value) =>
              value && typeof value === 'object' ? (value as Record<string, unknown>) : null,
            );
            const normalizedIds = approvers.map((approver) =>
              typeof approver?.id === 'string' ? approver.id.toLowerCase() : '',
            );
            if (
              !approvers.every(
                (approver) =>
                  approver &&
                  isUuidV7(approver.id) &&
                  isPhoneFreeBoundedText(approver.displayName, 256),
              ) ||
              new Set(normalizedIds).size !== approvers.length
            )
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid eligible approvers'),
              );
            return approvers.map((approver) => ({
              displayName: (approver as Record<string, string>).displayName as string,
              id: (approver as Record<string, string>).id as string,
            }));
          },
        );
      },
      async previewAdjustment(input) {
        const operation = 'operations.user.wallet-adjustment-preview';
        const direction: unknown = input.direction;
        if (
          !input.trustedSessionToken ||
          !isUuidV7(input.userId) ||
          !isUuidV7(input.approverId) ||
          !isUuidV7(input.audit.idempotencyKey) ||
          (direction !== 'CREDIT' && direction !== 'DEBIT') ||
          input.points <= 0n ||
          !isPhoneFreeBoundedText(input.reason, 200)
        )
          throw new Error('Invalid adjustment preview context');
        const headers = baseHeaders(input.requestContext, operation);
        headers.set('Content-Type', 'application/json');
        headers.set('Idempotency-Key', input.audit.idempotencyKey);
        headers.set('X-Admin-Session-Token', input.trustedSessionToken);
        return protectedFetch(
          `/v1/admin/users/${encodeURIComponent(input.userId)}/wallet-adjustment-previews`,
          {
            body: JSON.stringify({
              approverId: input.approverId,
              direction,
              points: input.points.toString(),
              reason: input.reason,
            }),
            cache: 'no-store',
            headers,
            method: 'POST',
          },
          operation,
          async (response, signal, requestContext) => {
            if (!response.ok) {
              const reason =
                response.status === 401 || response.status === 403
                  ? 'DOWNSTREAM_DENIED'
                  : 'UPSTREAM_FAILURE';
              throw recordedFailure(
                operation,
                reason,
                requestContext,
                new Error('Wallet adjustment preview was denied'),
              );
            }
            let payload: unknown;
            try {
              payload = await response.json();
            } catch (error) {
              if (signal.aborted) throw error;
              payload = null;
            }
            if (!payload || typeof payload !== 'object')
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid wallet adjustment preview'),
              );
            const p = payload as Record<string, unknown>;
            if (
              !isPointsString(p.before) ||
              !isPointsString(p.after) ||
              !isPointsString(p.points) ||
              (p.direction !== 'CREDIT' && p.direction !== 'DEBIT') ||
              !isCoherentPointsAdjustment(p.before, p.after, p.points, p.direction) ||
              !isUtcIso8601Z(p.expiresAt) ||
              !isPhoneFreeBoundedText(p.impact, 512) ||
              !isPhoneFreeBoundedText(p.policy, 512) ||
              !isPhoneFreeBoundedText(p.previewToken, 512)
            )
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid wallet adjustment preview'),
              );
            return {
              after: p.after,
              before: p.before,
              direction: p.direction,
              expiresAt: p.expiresAt,
              impact: p.impact,
              points: p.points,
              policy: p.policy,
              previewToken: p.previewToken,
            } as WalletAdjustmentPreview;
          },
        );
      },
      async submitAdjustmentRequest(input) {
        const operation = 'operations.user.wallet-adjustment-request';
        const direction: unknown = input.direction;
        if (
          !input.trustedSessionToken ||
          !isUuidV7(input.userId) ||
          !isUuidV7(input.approverId) ||
          !isUuidV7(input.audit.idempotencyKey) ||
          (direction !== 'CREDIT' && direction !== 'DEBIT') ||
          input.points <= 0n ||
          !isPhoneFreeBoundedText(input.reason, 200) ||
          !isPhoneFreeBoundedText(input.previewToken, 512)
        ) {
          throw new Error('Trusted admin session is required');
        }
        const headers = baseHeaders(input.requestContext, operation);
        headers.set('Content-Type', 'application/json');
        headers.set('Idempotency-Key', input.audit.idempotencyKey);
        headers.set('X-Admin-Session-Token', input.trustedSessionToken);
        return protectedFetch(
          `/v1/admin/users/${encodeURIComponent(input.userId)}/wallet-adjustment-requests`,
          {
            body: JSON.stringify({
              approverId: input.approverId,
              direction,
              points: input.points.toString(),
              previewToken: input.previewToken,
              reason: input.reason,
            }),
            cache: 'no-store',
            headers,
            method: 'POST',
          },
          operation,
          async (response, signal, requestContext) => {
            if (!response.ok) {
              const reason =
                response.status === 401 || response.status === 403
                  ? 'DOWNSTREAM_DENIED'
                  : 'UPSTREAM_FAILURE';
              throw recordedFailure(
                operation,
                reason,
                requestContext,
                new Error('Wallet adjustment request was denied'),
              );
            }
            let payload: unknown;
            try {
              payload = await response.json();
            } catch (error) {
              if (signal.aborted) throw error;
              payload = null;
            }
            if (!payload || typeof payload !== 'object')
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid wallet adjustment request'),
              );
            const candidate = payload as Record<string, unknown>;
            const requestId = boundedText(candidate.requestId, 128);
            const auditRecordId = boundedText(candidate.auditRecordId, 128);
            if (
              !isUuidV7(requestId) ||
              !isUuidV7(auditRecordId) ||
              candidate.status !== 'PENDING_APPROVAL'
            )
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid wallet adjustment request'),
              );
            return { auditRecordId, requestId, status: 'PENDING_APPROVAL' as const };
          },
        );
      },
    },
    exportPort: {
      async requestCsvExport(input) {
        const operation = 'operations.user.csv-export';
        if (!input.trustedSessionToken || !isUuidV7(input.audit.idempotencyKey)) {
          throw new Error('Trusted admin session is required');
        }
        if (
          !isPhoneFreeBoundedText(input.reason, 200) ||
          [input.query, ...Object.values(input.filters ?? {})].some(containsSensitivePhoneLikeValue)
        )
          throw new Error('Sensitive CSV query is forbidden');
        if (
          input.searchHandle !== undefined &&
          (!isValidSearchHandle(input.searchHandle) ||
            input.query !== undefined ||
            input.filters !== undefined)
        ) {
          throw new Error('Invalid search handle');
        }
        const headers = baseHeaders(input.requestContext, operation);
        headers.set('Content-Type', 'application/json');
        headers.set('Idempotency-Key', input.audit.idempotencyKey);
        headers.set('X-Admin-Session-Token', input.trustedSessionToken);
        return protectedFetch(
          '/v1/admin/users/csv-export-requests',
          {
            body: JSON.stringify({
              filters: input.filters,
              query: input.query,
              reason: input.reason,
              searchHandle: input.searchHandle,
              scope: input.scope,
            }),
            cache: 'no-store',
            headers,
            method: 'POST',
          },
          operation,
          async (response, signal, requestContext) => {
            if (!response.ok) {
              const reason =
                response.status === 401 || response.status === 403
                  ? 'DOWNSTREAM_DENIED'
                  : 'UPSTREAM_FAILURE';
              throw recordedFailure(
                operation,
                reason,
                requestContext,
                new Error('CSV export request was denied'),
              );
            }
            let payload: unknown;
            try {
              payload = await response.json();
            } catch (error) {
              if (signal.aborted) {
                throw error;
              }
              payload = null;
            }
            const responsePayload =
              payload && typeof payload === 'object'
                ? (payload as {
                    auditRecordId?: unknown;
                    downloadUrl?: unknown;
                    expiresAt?: unknown;
                  })
                : undefined;
            const auditRecordId = responsePayload?.auditRecordId;
            const downloadUrl = responsePayload?.downloadUrl;
            const expiresAt = responsePayload?.expiresAt;
            if (
              !isUuidV7(auditRecordId) ||
              !isPhoneFreeHttpsUrl(downloadUrl) ||
              !isUtcIso8601Z(expiresAt)
            ) {
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid CSV export audit response'),
              );
            }
            return { auditRecordId, downloadUrl, expiresAt };
          },
        );
      },
    },
    directoryPort: {
      async searchUsers(input) {
        const operation = 'operations.user.directory-search';
        if (!input.trustedSessionToken) {
          throw new Error('Trusted admin session is required');
        }
        if (
          [input.query, input.cursor, ...Object.values(input.filters ?? {})].some(
            containsSensitivePhoneLikeValue,
          )
        )
          throw new Error('Sensitive user directory query is forbidden');
        if (input.cursor !== undefined && !isSafeDirectoryCursor(input.cursor))
          throw new Error('Invalid user directory cursor');
        if (isMainlandPhone(input.query.trim()))
          throw new Error('Use protected exact lookup for phone-shaped queries');
        const filters = validateUserFilters(input.filters ?? {});
        const parameters = new URLSearchParams({ query: input.query });
        if (filters.status) parameters.set('status', filters.status);
        if (filters.tag) parameters.set('tag', filters.tag);
        if (filters.registrationSource)
          parameters.set('registrationSource', filters.registrationSource);
        if (filters.spendingTier) parameters.set('spendingTier', filters.spendingTier);
        if (input.cursor) {
          parameters.set('cursor', input.cursor);
        }
        const headers = baseHeaders(input.requestContext, operation);
        headers.set('X-Admin-Session-Token', input.trustedSessionToken);
        return protectedFetch(
          `/v1/admin/users?${parameters.toString()}`,
          { cache: 'no-store', headers, method: 'GET' },
          operation,
          async (response, signal, requestContext) => {
            if (!response.ok) {
              const reason =
                response.status === 401 || response.status === 403
                  ? 'DOWNSTREAM_DENIED'
                  : 'UPSTREAM_FAILURE';
              throw recordedFailure(
                operation,
                reason,
                requestContext,
                new Error('User directory request was denied'),
              );
            }
            let payload: unknown;
            try {
              payload = await response.json();
            } catch (error) {
              if (signal.aborted) {
                throw error;
              }
              payload = null;
            }
            if (!payload || typeof payload !== 'object') {
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid user directory response'),
              );
            }
            const candidate = payload as Partial<{
              items: unknown;
              nextCursor: string | null;
            }>;
            const items = parseDirectoryRows(candidate.items);
            if (
              !items ||
              (candidate.nextCursor !== null && !isSafeDirectoryCursor(candidate.nextCursor))
            ) {
              throw recordedFailure(
                operation,
                'MALFORMED_RESPONSE',
                requestContext,
                new Error('Invalid user directory response'),
              );
            }
            return { items, nextCursor: candidate.nextCursor };
          },
        );
      },
    },
  };
}
