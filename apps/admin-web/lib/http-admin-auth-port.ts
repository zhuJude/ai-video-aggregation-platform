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
  defaultSafeTelemetry,
  recordSafeTelemetry,
} from './safe-telemetry';
import {
  ADMIN_MFA_CHALLENGE_TTL_MS,
  ADMIN_MFA_CHALLENGE_TTL_SECONDS,
  createRandomAdminMfaChallengeId,
  isValidAdminMfaChallengeId,
} from './session-auth';

export {
  ADMIN_MFA_CHALLENGE_TTL_MS,
  ADMIN_MFA_CHALLENGE_TTL_SECONDS,
} from './session-auth';

type AuthEnvironment = Readonly<{
  apiUrl?: string | undefined;
  kmsIdentityReference?: string | undefined;
}>;

type HttpAdminAuthPortOptions = Readonly<{
  deadlineMs?: number;
  fetchImpl?: typeof fetch;
  maxLockoutTtlMs?: number;
  maxSessionTtlMs?: number;
  now?: () => number;
  telemetry?: SafeTelemetryPort;
}>;

const DEFAULT_MAX_LOCKOUT_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_SESSION_TTL_MS = 12 * 60 * 60_000;

class InvalidAdminAuthResponseError extends Error {}

function isAdminAuthenticatedSubject(
  value: unknown,
): value is AdminAuthenticatedSubject {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<AdminAuthenticatedSubject>;
  return (
    typeof candidate.subjectId === 'string' &&
    candidate.subjectId.length > 0 &&
    Array.isArray(candidate.permissions) &&
    candidate.permissions.every(
      (permission) => typeof permission === 'string',
    ) &&
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
      deadlineMs,
      fetchImpl: options.fetchImpl ?? fetch,
      maxLockoutTtlMs,
      maxSessionTtlMs,
      now: options.now ?? Date.now,
      telemetry,
    };
  } catch {
    recordSafeTelemetry(telemetry, {
      operation: 'iam.config',
      reason: 'INVALID_CONFIG',
    });
    throw new Error('Admin IAM configuration is unavailable');
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

  async function postJson<T>(
    pathname: string,
    body: unknown,
    operation: SafeTelemetryEvent['operation'],
    consume: (response: Response, signal: AbortSignal) => Promise<T> | T,
  ): Promise<T> {
    try {
      return await fetchWithDeadline(
        config.fetchImpl,
        new URL(pathname, config.baseUrl),
        {
          body: JSON.stringify(body),
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Identity-Ref':
              environment.kmsIdentityReference as string,
          },
          method: 'POST',
        },
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

  function malformed(operation: SafeTelemetryEvent['operation']): never {
    recordSafeTelemetry(config.telemetry, {
      operation,
      reason: 'MALFORMED_RESPONSE',
    });
    throw new InvalidAdminAuthResponseError('Admin IAM response is invalid');
  }

  return {
    async beginPasswordChallenge(input): Promise<PasswordChallengeResult> {
      const operation = 'iam.password.begin';
      try {
        return await postJson(
          '/v1/admin-auth/password/challenges',
          input,
          operation,
          async (response, signal) => {
            if (!response.ok) {
              recordSafeTelemetry(config.telemetry, {
                operation,
                reason: 'UPSTREAM_FAILURE',
              });
              throw new InvalidAdminAuthResponseError(
                'Admin IAM challenge request failed',
              );
            }

            let payload: unknown;
            try {
              payload = await response.json();
            } catch (error) {
              if (signal.aborted) {
                throw error;
              }
              return malformed(operation);
            }
            if (!payload || typeof payload !== 'object') {
              return malformed(operation);
            }
            const candidate = payload as Partial<{
              challengeId: string;
              expiresInSeconds: number;
            }>;
            if (
              !isValidAdminMfaChallengeId(candidate.challengeId) ||
              candidate.expiresInSeconds !== ADMIN_MFA_CHALLENGE_TTL_SECONDS
            ) {
              return malformed(operation);
            }

            return {
              challengeId: candidate.challengeId,
              expiresAt: config.now() + ADMIN_MFA_CHALLENGE_TTL_MS,
            };
          },
        );
      } catch (error) {
        if (
          !(error instanceof SafeHttpRequestError) &&
          !(error instanceof InvalidAdminAuthResponseError)
        ) {
          recordSafeTelemetry(config.telemetry, {
            operation,
            reason: 'UPSTREAM_FAILURE',
          });
        }
        return localDecoyChallenge(config.now);
      }
    },

    async verifyTotp(input): Promise<TotpVerificationResult> {
      const operation = 'iam.totp.verify';
      return postJson(
        '/v1/admin-auth/totp/verifications',
        input,
        operation,
        async (response, signal) => {
          if (!response.ok) {
            recordSafeTelemetry(config.telemetry, {
              operation,
              reason: 'UPSTREAM_FAILURE',
            });
            throw new Error('Admin IAM TOTP request failed');
          }

          let payload: unknown;
          try {
            payload = await response.json();
          } catch (error) {
            if (signal.aborted) {
              throw error;
            }
            return malformed(operation);
          }
          if (!payload || typeof payload !== 'object') {
            return malformed(operation);
          }
          const candidate = payload as Partial<{
            kind: 'AUTHENTICATED' | 'CONSUMED' | 'REJECTED';
            subject: unknown;
            expiresAt: number;
            attemptsRemaining: number;
            lockedUntil: number;
          }>;
          if (candidate.kind === 'CONSUMED') {
            return { kind: 'CONSUMED' };
          }

          const currentTime = config.now();
          if (candidate.kind === 'REJECTED') {
            if (
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
              return malformed(operation);
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
            !isAdminAuthenticatedSubject(candidate.subject) ||
            typeof candidate.expiresAt !== 'number' ||
            !isValidTtl(
              candidate.expiresAt,
              currentTime,
              config.maxSessionTtlMs,
            )
          ) {
            return malformed(operation);
          }

          return {
            kind: 'AUTHENTICATED',
            subject: candidate.subject,
            expiresAt: candidate.expiresAt,
          };
        },
      );
    },
  };
}
