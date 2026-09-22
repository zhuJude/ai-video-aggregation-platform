import type {
  AdminAuthenticatedSubject,
  AdminAuthPort,
  PasswordChallengeResult,
  TotpVerificationResult,
} from './admin-auth-actions';
import {
  DEFAULT_UPSTREAM_DEADLINE_MS,
  SafeHttpRequestError,
  fetchWithDeadline,
  isValidDeadline,
} from './http-deadline';
import {
  type SafeTelemetryEvent,
  type SafeTelemetryPort,
  consumeTechnicalFailure,
  createSafeTelemetryEvent,
  defaultSafeTelemetry,
  recordSafeTelemetry,
  recordTechnicalFailure,
} from './safe-telemetry';
import {
  ADMIN_MFA_CHALLENGE_TTL_MS,
  ADMIN_MFA_CHALLENGE_TTL_SECONDS,
  createRandomAdminMfaChallengeId,
  isValidAdminMfaChallengeId,
} from './session-auth';
import { createUuidV7, isUuidV7 } from './uuid-v7';
import {
  createOutboundRequestContext,
  parseOutboundRequestContext,
  type OutboundRequestContext,
} from './outbound-request-context';
import { isValidAdminPermissions } from './permissions';

export {
  ADMIN_MFA_CHALLENGE_TTL_MS,
  ADMIN_MFA_CHALLENGE_TTL_SECONDS,
} from './session-auth';

type AuthEnvironment = Readonly<{
  apiUrl?: string | undefined;
  kmsIdentityReference?: string | undefined;
}>;

type HttpAdminAuthPortOptions = Readonly<{
  createRequestContext?: (correlationId: string) => unknown;
  deadlineMs?: number;
  fetchImpl?: typeof fetch;
  maxLockoutTtlMs?: number;
  maxSessionTtlMs?: number;
  now?: () => number;
  telemetry?: SafeTelemetryPort;
}>;

const DEFAULT_MAX_LOCKOUT_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_SESSION_TTL_MS = 12 * 60 * 60_000;

export type ClassifiedAdminAuthFailureReason =
  | 'MALFORMED_RESPONSE'
  | 'NETWORK_FAILURE'
  | 'TIMEOUT'
  | 'UPSTREAM_FAILURE';

class ClassifiedAdminAuthFailure extends Error {
  readonly reason: ClassifiedAdminAuthFailureReason;

  constructor(reason: ClassifiedAdminAuthFailureReason) {
    super('Admin authentication dependency failed');
    this.name = 'ClassifiedAdminAuthFailure';
    this.reason = reason;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isAdminAuthenticatedSubject(
  value: unknown,
): value is AdminAuthenticatedSubject {
  if (!isPlainObject(value) || !hasExactKeys(value, ['dataScope', 'permissions', 'subjectId'])) {
    return false;
  }

  const candidate = value as Partial<AdminAuthenticatedSubject>;
  return (
    isUuidV7(candidate.subjectId) &&
    isValidAdminPermissions(candidate.permissions) &&
    (candidate.dataScope === 'ALL' ||
      candidate.dataScope === 'OWN' ||
      candidate.dataScope === 'ASSIGNED')
  );
}

function isValidTtl(value: number, now: number, maximumTtlMs: number): boolean {
  return (
    Number.isFinite(value) && value > now && value <= now + maximumTtlMs
  );
}

function localDecoyChallenge(now: () => number): PasswordChallengeResult {
  return {
    challengeId: createRandomAdminMfaChallengeId(),
    expiresAt: now() + ADMIN_MFA_CHALLENGE_TTL_MS,
  };
}

function configuration(
  environment: AuthEnvironment,
  options: HttpAdminAuthPortOptions,
): {
  baseUrl: URL;
  createRequestContext: (correlationId: string) => unknown;
  deadlineMs: number;
  fetchImpl: typeof fetch;
  maxLockoutTtlMs: number;
  maxSessionTtlMs: number;
  now: () => number;
  telemetry: SafeTelemetryPort;
} {
  const telemetry = options.telemetry ?? defaultSafeTelemetry;
  const deadlineMs = options.deadlineMs ?? DEFAULT_UPSTREAM_DEADLINE_MS;
  const maxLockoutTtlMs =
    options.maxLockoutTtlMs ?? DEFAULT_MAX_LOCKOUT_TTL_MS;
  const maxSessionTtlMs =
    options.maxSessionTtlMs ?? DEFAULT_MAX_SESSION_TTL_MS;

  try {
    if (!environment.apiUrl || !environment.kmsIdentityReference?.trim()) {
      throw new Error('missing');
    }
    const baseUrl = new URL(environment.apiUrl);
    if (
      baseUrl.protocol !== 'https:' ||
      baseUrl.username ||
      baseUrl.password ||
      !isValidDeadline(deadlineMs) ||
      !Number.isInteger(maxLockoutTtlMs) ||
      maxLockoutTtlMs <= 0 ||
      !Number.isInteger(maxSessionTtlMs) ||
      maxSessionTtlMs <= 0
    ) {
      throw new Error('invalid');
    }

    return {
      baseUrl,
      createRequestContext: options.createRequestContext ?? ((correlationId) =>
        createOutboundRequestContext(undefined, () => correlationId)),
      deadlineMs,
      fetchImpl: options.fetchImpl ?? fetch,
      maxLockoutTtlMs,
      maxSessionTtlMs,
      now: options.now ?? Date.now,
      telemetry,
    };
  } catch (cause) {
    throw recordTechnicalFailure(
      telemetry,
      createSafeTelemetryEvent('iam.config', 'INVALID_CONFIG'),
      new Error('Admin IAM configuration is unavailable', { cause }),
    );
  }
}

export function createHttpAdminAuthPort(
  environment: AuthEnvironment = {
    apiUrl: process.env.ADMIN_AUTH_API_URL,
    kmsIdentityReference: process.env.ADMIN_AUTH_KMS_IDENTITY_REF,
  },
  options: HttpAdminAuthPortOptions = {},
): AdminAuthPort {
  const config = configuration(environment, options);

  function commandContext(input: { correlationId?: string; idempotencyKey?: string }) {
    const correlationId = input.correlationId ?? createUuidV7();
    const idempotencyKey = input.idempotencyKey ?? createUuidV7();
    if (!isUuidV7(correlationId) || !isUuidV7(idempotencyKey)) throw new Error('Invalid MFA request context');
    return { correlationId, idempotencyKey };
  }

  async function postJson<T>(
    pathname: string,
    body: unknown,
    operation: SafeTelemetryEvent['operation'],
    command: Readonly<{ correlationId: string; idempotencyKey: string }>,
    consume: (
      response: Response,
      signal: AbortSignal,
      requestContext: OutboundRequestContext,
    ) => Promise<T> | T,
  ): Promise<T> {
    let requestContext: OutboundRequestContext;
    try {
      requestContext = parseOutboundRequestContext(
        config.createRequestContext(command.correlationId),
      );
    } catch {
      throw recordTechnicalFailure(
        config.telemetry,
        createSafeTelemetryEvent(operation, 'UPSTREAM_FAILURE'),
        new ClassifiedAdminAuthFailure('UPSTREAM_FAILURE'),
      );
    }
    try {
      return await fetchWithDeadline(
        config.fetchImpl,
        new URL(pathname, config.baseUrl),
        {
          body: JSON.stringify(body),
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': command.idempotencyKey,
            'X-Correlation-Id': requestContext.correlationId,
            'X-Service-Identity-Ref':
              environment.kmsIdentityReference as string,
            'X-Trace-Id': requestContext.traceId,
          },
          method: 'POST',
        },
        config.deadlineMs,
        (response, signal) => consume(response, signal, requestContext),
      );
    } catch (error) {
      if (error instanceof ClassifiedAdminAuthFailure) {
        throw error;
      }
      const reason = error instanceof SafeHttpRequestError
        ? error.reason
        : 'UPSTREAM_FAILURE';
      throw recordTechnicalFailure(
        config.telemetry,
        createSafeTelemetryEvent(operation, reason, requestContext),
        new ClassifiedAdminAuthFailure(reason),
      );
    }
  }

  function malformed(
    operation: SafeTelemetryEvent['operation'],
    requestContext: OutboundRequestContext,
  ): never {
    throw recordTechnicalFailure(
      config.telemetry,
      createSafeTelemetryEvent(operation, 'MALFORMED_RESPONSE', requestContext),
      new ClassifiedAdminAuthFailure('MALFORMED_RESPONSE'),
    );
  }

  return {
    async beginPasswordChallenge(input): Promise<PasswordChallengeResult> {
      const operation = 'iam.password.begin';
      const command = commandContext(input);
      try {
        return await postJson(
          '/v1/admin-auth/password/challenges',
          { identifier: input.identifier, password: input.password },
          operation,
          command,
          async (response, signal, requestContext) => {
            if (!response.ok) {
              if (response.status === 401) {
                let rejection: unknown;
                try {
                  rejection = await response.json();
                } catch (error) {
                  if (signal.aborted) throw error;
                  return malformed(operation, requestContext);
                }
                if (isPlainObject(rejection) && hasExactKeys(rejection, ['kind', 'reason']) && rejection.kind === 'REJECTED' && rejection.reason === 'INVALID_CREDENTIALS') {
                  return { ...localDecoyChallenge(config.now), rotateIntent: true };
                }
                return malformed(operation, requestContext);
              }
              throw recordTechnicalFailure(
                config.telemetry,
                createSafeTelemetryEvent(operation, 'UPSTREAM_FAILURE', requestContext),
                new ClassifiedAdminAuthFailure('UPSTREAM_FAILURE'),
              );
            }

            let payload: unknown;
            try {
              payload = await response.json();
            } catch (error) {
              if (signal.aborted) {
                throw error;
              }
              return malformed(operation, requestContext);
            }
            if (!isPlainObject(payload) || !hasExactKeys(payload, ['challengeId', 'expiresInSeconds'])) {
              return malformed(operation, requestContext);
            }
            const candidate = payload as Partial<{
              challengeId: string;
              expiresInSeconds: number;
            }>;
            if (
              !isValidAdminMfaChallengeId(candidate.challengeId) ||
              candidate.expiresInSeconds !== ADMIN_MFA_CHALLENGE_TTL_SECONDS
            ) {
              return malformed(operation, requestContext);
            }

            return {
              challengeId: candidate.challengeId,
              expiresAt: config.now() + ADMIN_MFA_CHALLENGE_TTL_MS,
            };
          },
        );
      } catch (error) {
        if (!consumeTechnicalFailure(error)) {
          const fallbackContext = createOutboundRequestContext(
            undefined,
            () => command.correlationId,
          );
          recordSafeTelemetry(config.telemetry, createSafeTelemetryEvent(operation, 'UPSTREAM_FAILURE', fallbackContext));
        }
        return { ...localDecoyChallenge(config.now), indeterminate: true };
      }
    },

    async verifyTotp(input): Promise<TotpVerificationResult> {
      const operation = 'iam.totp.verify';
      if (!isValidAdminMfaChallengeId(input.challengeId)) throw new Error('Invalid MFA challenge ID');
      const command = commandContext(input);
      return postJson(
        '/v1/admin-auth/totp/verifications',
        { challengeId: input.challengeId, code: input.code },
        operation,
        command,
          async (response, signal, requestContext) => {
            if (!response.ok) {
              if (response.status === 401 || response.status === 423) {
                let rejection: unknown;
                try {
                  rejection = await response.json();
                } catch (error) {
                  if (signal.aborted) throw error;
                  return malformed(operation, requestContext);
                }
                const currentTime = config.now();
                if (
                  isPlainObject(rejection) &&
                  hasExactKeys(rejection, ['attemptsRemaining', 'kind', 'reason']) &&
                  response.status === 401 &&
                  rejection.kind === 'REJECTED' &&
                  rejection.reason === 'INVALID_CODE' &&
                  Number.isInteger(rejection.attemptsRemaining) &&
                  (rejection.attemptsRemaining as number) >= 0
                ) return { kind: 'REJECTED', attemptsRemaining: rejection.attemptsRemaining as number };
                if (
                  isPlainObject(rejection) &&
                  hasExactKeys(rejection, ['attemptsRemaining', 'kind', 'lockedUntil', 'reason']) &&
                  response.status === 423 &&
                  rejection.kind === 'REJECTED' &&
                  rejection.reason === 'LOCKED' &&
                  rejection.attemptsRemaining === 0 &&
                  typeof rejection.lockedUntil === 'number' &&
                  isValidTtl(rejection.lockedUntil, currentTime, config.maxLockoutTtlMs)
                ) return { kind: 'REJECTED', attemptsRemaining: 0, lockedUntil: rejection.lockedUntil };
                return malformed(operation, requestContext);
              }
              throw recordTechnicalFailure(
                config.telemetry,
                createSafeTelemetryEvent(operation, 'UPSTREAM_FAILURE', requestContext),
                new ClassifiedAdminAuthFailure('UPSTREAM_FAILURE'),
              );
            }

          let payload: unknown;
          try {
            payload = await response.json();
          } catch (error) {
            if (signal.aborted) {
              throw error;
            }
            return malformed(operation, requestContext);
          }
          if (!isPlainObject(payload)) {
            return malformed(operation, requestContext);
          }
          const candidate = payload as Partial<{
            kind: 'AUTHENTICATED' | 'CONSUMED' | 'REJECTED';
            subject: unknown;
            expiresAt: number;
            attemptsRemaining: number;
            lockedUntil: number;
          }>;
          if (candidate.kind === 'CONSUMED') {
            if (!hasExactKeys(payload, ['kind'])) return malformed(operation, requestContext);
            return { kind: 'CONSUMED' };
          }

          const currentTime = config.now();
          if (candidate.kind === 'REJECTED') {
            const rejectionKeys = candidate.lockedUntil === undefined
              ? ['attemptsRemaining', 'kind']
              : ['attemptsRemaining', 'kind', 'lockedUntil'];
            if (
              !hasExactKeys(payload, rejectionKeys) ||
              typeof candidate.attemptsRemaining !== 'number' ||
              !Number.isInteger(candidate.attemptsRemaining) ||
              candidate.attemptsRemaining < 0 ||
              (candidate.lockedUntil !== undefined &&
                !isValidTtl(
                  candidate.lockedUntil,
                  currentTime,
                  config.maxLockoutTtlMs,
                ))
            ) {
              return malformed(operation, requestContext);
            }

            return {
              kind: 'REJECTED',
              attemptsRemaining: candidate.attemptsRemaining,
              ...(candidate.lockedUntil === undefined
                ? {}
                : { lockedUntil: candidate.lockedUntil }),
            };
          }

          if (
            candidate.kind !== 'AUTHENTICATED' ||
            !hasExactKeys(payload, ['expiresAt', 'kind', 'subject']) ||
            !isAdminAuthenticatedSubject(candidate.subject) ||
            typeof candidate.expiresAt !== 'number' ||
            !isValidTtl(
              candidate.expiresAt,
              currentTime,
              config.maxSessionTtlMs,
            )
          ) {
            return malformed(operation, requestContext);
          }

          return {
            kind: 'AUTHENTICATED',
            subject: {
              dataScope: candidate.subject.dataScope,
              permissions: [...candidate.subject.permissions],
              subjectId: candidate.subject.subjectId,
            },
            expiresAt: candidate.expiresAt,
          };
        },
      );
    },
  };
}
