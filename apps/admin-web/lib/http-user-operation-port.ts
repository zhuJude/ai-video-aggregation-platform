import type {
  ResourceScopePort,
  UserOperationPort,
} from './protected-user-action';
import {
  DEFAULT_UPSTREAM_DEADLINE_MS,
  SafeHttpRequestError,
  fetchWithDeadline,
  isValidDeadline,
} from './http-deadline';
import {
  type SafeTelemetryEvent,
  type SafeTelemetryPort,
  defaultSafeTelemetry,
  recordSafeTelemetry,
} from './safe-telemetry';

type OperationsEnvironment = Readonly<{
  apiUrl?: string | undefined;
  kmsIdentityReference?: string | undefined;
}>;

type HttpUserOperationPortOptions = Readonly<{
  deadlineMs?: number;
  fetchImpl?: typeof fetch;
  telemetry?: SafeTelemetryPort;
}>;

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
  } catch {
    recordSafeTelemetry(telemetry, {
      operation: 'operations.config',
      reason: 'INVALID_CONFIG',
    });
    throw new Error('Admin operations configuration is unavailable');
  }
}

export function createHttpUserOperationPorts(
  environment: OperationsEnvironment = {
    apiUrl: process.env.ADMIN_OPERATIONS_API_URL,
    kmsIdentityReference: process.env.ADMIN_OPERATIONS_KMS_IDENTITY_REF,
  },
  options: HttpUserOperationPortOptions = {},
): Readonly<{
  scopePort: ResourceScopePort;
  operationPort: UserOperationPort;
}> {
  const config = configuration(environment, options);

  async function protectedFetch<T>(
    pathname: string,
    init: RequestInit,
    operation: SafeTelemetryEvent['operation'],
    consume: (response: Response, signal: AbortSignal) => Promise<T> | T,
  ): Promise<T> {
    try {
      return await fetchWithDeadline(
        config.fetchImpl,
        new URL(pathname, config.baseUrl),
        init,
        config.deadlineMs,
        consume,
      );
    } catch (error) {
      if (!(error instanceof SafeHttpRequestError)) {
        throw error;
      }
      recordSafeTelemetry(config.telemetry, {
        operation,
        reason: error.reason,
      });
      throw error;
    }
  }

  function baseHeaders(): Headers {
    return new Headers({
      Accept: 'application/json',
      'X-Service-Identity-Ref': config.kmsIdentityReference,
    });
  }

  return {
    scopePort: {
      async getUserScope(userId) {
        const operation = 'operations.scope.read';
        return protectedFetch(
          `/v1/admin/users/${encodeURIComponent(userId)}/authorization-scope`,
          {
            cache: 'no-store',
            headers: baseHeaders(),
          },
          operation,
          async (response, signal) => {
            if (!response.ok) {
              recordSafeTelemetry(config.telemetry, {
                operation,
                reason:
                  response.status === 401 || response.status === 403
                    ? 'DOWNSTREAM_DENIED'
                    : 'UPSTREAM_FAILURE',
              });
              throw new Error('Unable to resolve resource scope');
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
              recordSafeTelemetry(config.telemetry, {
                operation,
                reason: 'MALFORMED_RESPONSE',
              });
              throw new Error('Invalid resource scope response');
            }
            const candidate = payload as Partial<{
              ownerAdminId: string | null;
              assignedAdminIds: string[];
            }>;
            if (
              !Array.isArray(candidate.assignedAdminIds) ||
              !candidate.assignedAdminIds.every(
                (id) => typeof id === 'string',
              ) ||
              (candidate.ownerAdminId !== null &&
                typeof candidate.ownerAdminId !== 'string')
            ) {
              recordSafeTelemetry(config.telemetry, {
                operation,
                reason: 'MALFORMED_RESPONSE',
              });
              throw new Error('Invalid resource scope response');
            }

            return {
              ownerAdminId: candidate.ownerAdminId,
              assignedAdminIds: candidate.assignedAdminIds,
            };
          },
        );
      },
    },
    operationPort: {
      async refreshUser({ trustedSessionToken, userId }) {
        const operation = 'operations.user.refresh';
        if (!trustedSessionToken) {
          recordSafeTelemetry(config.telemetry, {
            operation,
            reason: 'DOWNSTREAM_DENIED',
          });
          throw new Error('Trusted admin session is required');
        }

        const headers = baseHeaders();
        headers.set('X-Admin-Session-Token', trustedSessionToken);
        return protectedFetch(
          `/v1/admin/users/${encodeURIComponent(userId)}/refresh`,
          {
            cache: 'no-store',
            headers,
            method: 'POST',
          },
          operation,
          (response) => {
            if (!response.ok) {
              recordSafeTelemetry(config.telemetry, {
                operation,
                reason:
                  response.status === 401 || response.status === 403
                    ? 'DOWNSTREAM_DENIED'
                    : 'UPSTREAM_FAILURE',
              });
              throw new Error('User refresh operation failed');
            }
          },
        );
      },
    },
  };
}
