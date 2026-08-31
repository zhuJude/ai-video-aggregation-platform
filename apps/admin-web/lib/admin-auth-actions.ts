import { publicPasswordStepResult, validateTotpInput } from './login-flow';
import type { AdminSessionClaims } from './session-auth';
import {
  ADMIN_MFA_CHALLENGE_COOKIE,
  ADMIN_SESSION_COOKIE,
  signAdminMfaChallenge,
  signAdminSession,
  verifyAdminMfaChallenge,
  isValidAdminSigningKey,
  ADMIN_MFA_CHALLENGE_TTL_MS,
  createRandomAdminMfaChallengeId,
  isValidAdminMfaChallengeId,
} from './session-auth';
import {
  type SafeTelemetryPort,
  defaultSafeTelemetry,
  recordSafeTelemetry,
} from './safe-telemetry';

export type PasswordChallengeResult = Readonly<{
  challengeId: string;
  expiresAt: number;
}>;

export type TotpVerificationResult =
  | Readonly<{
      kind: 'AUTHENTICATED';
      subject: AdminAuthenticatedSubject;
      expiresAt: number;
    }>
  | Readonly<{
      kind: 'REJECTED';
      attemptsRemaining: number;
      lockedUntil?: number;
    }>
  | Readonly<{ kind: 'CONSUMED' }>;

export type AdminAuthenticatedSubject = Omit<AdminSessionClaims, 'expiresAt'>;

export interface AdminAuthPort {
  beginPasswordChallenge(input: Readonly<{
    identifier: string;
    password: string;
  }>): Promise<PasswordChallengeResult>;
  verifyTotp(input: Readonly<{
    challengeId: string;
    code: string;
  }>): Promise<TotpVerificationResult>;
}

export type CookieOptions = Readonly<{
  expires: Date;
  httpOnly: true;
  maxAge?: number;
  path: '/';
  sameSite: 'strict';
  secure: true;
}>;

export interface ServerCookiePort {
  get(name: string): string | undefined;
  set(name: string, value: string, options: CookieOptions): void;
  delete(name: string): void;
}

export type TotpActionResult =
  | Readonly<{
      status: 'INVALID_TOTP';
      message: string;
      cooldownSeconds: 0;
    }>
  | Readonly<{
      status: 'LOCKED';
      message: string;
      cooldownSeconds: number;
    }>
  | Readonly<{ status: 'AUTHENTICATED'; redirectTo: '/overview' }>;

type LoginActionDependencies = Readonly<{
  authPort: AdminAuthPort;
  cookies: ServerCookiePort;
  challengeSigningKey: string;
  sessionSigningKey: string;
  now?: () => number;
  telemetry?: SafeTelemetryPort;
}>;

const genericTotpFailure: TotpActionResult = {
  status: 'INVALID_TOTP',
  message: '验证失败，请重试',
  cooldownSeconds: 0,
};

const cookieOptions = (expiresAt: number): CookieOptions => ({
  expires: new Date(expiresAt),
  httpOnly: true,
  path: '/',
  sameSite: 'strict',
  secure: true,
});

const challengeCookieOptions = (expiresAt: number): CookieOptions => ({
  ...cookieOptions(expiresAt),
  maxAge: ADMIN_MFA_CHALLENGE_TTL_MS / 1000,
});

function localDecoyChallenge(now: () => number): PasswordChallengeResult {
  return {
    challengeId: createRandomAdminMfaChallengeId(),
    expiresAt: now() + ADMIN_MFA_CHALLENGE_TTL_MS,
  };
}

function normalizeChallenge(
  value: unknown,
  now: number,
): PasswordChallengeResult | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<PasswordChallengeResult>;
  if (
    !isValidAdminMfaChallengeId(candidate.challengeId) ||
    typeof candidate.expiresAt !== 'number' ||
    !Number.isFinite(candidate.expiresAt) ||
    candidate.expiresAt <= now
  ) {
    return null;
  }

  return {
    challengeId: candidate.challengeId,
    expiresAt: now + ADMIN_MFA_CHALLENGE_TTL_MS,
  };
}

function formString(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

export function createLoginActionHandlers({
  authPort,
  challengeSigningKey,
  cookies,
  now = Date.now,
  sessionSigningKey,
  telemetry = defaultSafeTelemetry,
}: LoginActionDependencies) {
  if (
    !isValidAdminSigningKey(challengeSigningKey) ||
    !isValidAdminSigningKey(sessionSigningKey)
  ) {
    recordSafeTelemetry(telemetry, {
      operation: 'login.config',
      reason: 'INVALID_CONFIG',
    });
    throw new Error('Admin login configuration is unavailable');
  }

  async function storeChallenge(input: {
    challengeId: string;
    expiresAt: number;
  }): Promise<void> {
    const token = await signAdminMfaChallenge(input, challengeSigningKey);
    cookies.set(
      ADMIN_MFA_CHALLENGE_COOKIE,
      token,
      challengeCookieOptions(input.expiresAt),
    );
  }

  return {
    async submitPassword(formData: FormData) {
      cookies.delete(ADMIN_MFA_CHALLENGE_COOKIE);

      try {
        const identifier = formString(formData, 'identifier').trim();
        const password = formString(formData, 'password');
        if (!identifier || !password) {
          return publicPasswordStepResult();
        }

        const result = await authPort.beginPasswordChallenge({
          identifier,
          password,
        });
        const currentTime = now();
        const challenge = normalizeChallenge(result, currentTime);
        if (challenge) {
          await storeChallenge(challenge);
        } else {
          recordSafeTelemetry(telemetry, {
            operation: 'login.password',
            reason: 'MALFORMED_RESPONSE',
          });
          await storeChallenge(localDecoyChallenge(() => currentTime));
        }
      } catch {
        recordSafeTelemetry(telemetry, {
          operation: 'login.password',
          reason: 'UPSTREAM_FAILURE',
        });
        try {
          await storeChallenge(localDecoyChallenge(now));
        } catch {
          cookies.delete(ADMIN_MFA_CHALLENGE_COOKIE);
          recordSafeTelemetry(telemetry, {
            operation: 'login.password',
            reason: 'ACTION_FAILURE',
          });
        }
      }

      return publicPasswordStepResult();
    },

    async submitTotp(formData: FormData): Promise<TotpActionResult> {
      const validatedCode = validateTotpInput(formString(formData, 'totp'));
      if (!validatedCode.ok) {
        return {
          status: 'INVALID_TOTP',
          message: validatedCode.message,
          cooldownSeconds: 0,
        };
      }

      const currentTime = now();
      const challenge = await verifyAdminMfaChallenge(
        cookies.get(ADMIN_MFA_CHALLENGE_COOKIE),
        challengeSigningKey,
        currentTime,
      );
      if (!challenge) {
        recordSafeTelemetry(telemetry, {
          operation: 'login.totp',
          reason: 'CHALLENGE_INVALID',
        });
        return genericTotpFailure;
      }

      try {
        const result = await authPort.verifyTotp({
          challengeId: challenge.challengeId,
          code: validatedCode.code,
        });
        if (result.kind === 'AUTHENTICATED' && result.expiresAt > currentTime) {
          const sessionToken = await signAdminSession(
            { ...result.subject, expiresAt: result.expiresAt },
            sessionSigningKey,
          );
          cookies.set(
            ADMIN_SESSION_COOKIE,
            sessionToken,
            cookieOptions(result.expiresAt),
          );
          cookies.delete(ADMIN_MFA_CHALLENGE_COOKIE);
          return { status: 'AUTHENTICATED', redirectTo: '/overview' };
        }

        if (result.kind === 'CONSUMED') {
          cookies.delete(ADMIN_MFA_CHALLENGE_COOKIE);
        }

        if (result.kind === 'REJECTED' && result.lockedUntil) {
          const cooldownSeconds = Math.ceil(
            (result.lockedUntil - currentTime) / 1000,
          );
          if (cooldownSeconds > 0) {
            return {
              status: 'LOCKED',
              message: `请在 ${String(cooldownSeconds)} 秒后重试`,
              cooldownSeconds,
            };
          }
        }
      } catch {
        recordSafeTelemetry(telemetry, {
          operation: 'login.totp',
          reason: 'UPSTREAM_FAILURE',
        });
      }

      return genericTotpFailure;
    },
  };
}
