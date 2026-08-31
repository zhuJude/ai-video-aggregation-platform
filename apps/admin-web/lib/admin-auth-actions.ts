import { passwordPreflightFailure, passwordPreflightRequired, publicPasswordStepResult, validateTotpInput } from './login-flow';
import type { AdminMfaChallengeClaims, AdminSessionClaims } from './session-auth';
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
  ADMIN_MFA_AUDIENCE,
  ADMIN_MFA_VERSION,
  createAdminMfaIdentifierBinding,
  deriveAdminMfaIdempotencyKey,
} from './session-auth';
import {
  type SafeTelemetryPort,
  consumeTechnicalFailure,
  createSafeTelemetryEvent,
  defaultSafeTelemetry,
  recordSafeTelemetry,
  recordTechnicalFailure,
} from './safe-telemetry';
import { createUuidV7, isUuidV7 } from './uuid-v7';

export type PasswordChallengeResult = Readonly<{
  challengeId: string;
  expiresAt: number;
  indeterminate?: true;
  rotateIntent?: true;
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

export type AdminAuthenticatedSubject = Omit<AdminSessionClaims, 'expiresAt' | 'sessionInstanceId'>;

export interface AdminAuthPort {
  beginPasswordChallenge(input: Readonly<{
    correlationId?: string;
    identifier: string;
    idempotencyKey?: string;
    password: string;
  }>): Promise<PasswordChallengeResult>;
  verifyTotp(input: Readonly<{
    challengeId: string;
    code: string;
    correlationId?: string;
    idempotencyKey?: string;
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
  createFlowId?: () => string;
  createSessionInstanceId?: () => string;
  telemetry?: SafeTelemetryPort;
  requirePreflight?: boolean;
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
  createFlowId = createUuidV7,
  createSessionInstanceId = createUuidV7,
  sessionSigningKey,
  telemetry = defaultSafeTelemetry,
  requirePreflight = false,
}: LoginActionDependencies) {
  if (
    !isValidAdminSigningKey(challengeSigningKey) ||
    !isValidAdminSigningKey(sessionSigningKey)
  ) {
    throw recordTechnicalFailure(
      telemetry,
      createSafeTelemetryEvent('login.config', 'INVALID_CONFIG'),
      new Error('Admin login configuration is unavailable'),
    );
  }

  async function storeChallenge(input: AdminMfaChallengeClaims): Promise<void> {
    const token = await signAdminMfaChallenge(input, challengeSigningKey);
    cookies.set(
      ADMIN_MFA_CHALLENGE_COOKIE,
      token,
      challengeCookieOptions(input.expiresAt),
    );
  }

  function recordActionTechnicalFailure(
    operation: 'login.password' | 'login.totp',
    reason: 'ACTION_FAILURE' | 'MALFORMED_RESPONSE' | 'UPSTREAM_FAILURE',
  ): void {
    recordSafeTelemetry(telemetry, createSafeTelemetryEvent(operation, reason));
  }

  async function passwordFlow(identifier: string, currentTime: number): Promise<Extract<AdminMfaChallengeClaims, { stage: 'PASSWORD' }>> {
    return {
      audience: ADMIN_MFA_AUDIENCE,
      correlationId: createFlowId(),
      expiresAt: currentTime + ADMIN_MFA_CHALLENGE_TTL_MS,
      identifierBinding: await createAdminMfaIdentifierBinding(identifier, challengeSigningKey),
      seed: createRandomAdminMfaChallengeId(),
      stage: 'PASSWORD',
      version: ADMIN_MFA_VERSION,
    };
  }

  return {
    async preparePassword(identifierInput: string) {
      const identifier = identifierInput.trim();
      if (!identifier || identifier.length > 254) return { status: 'ERROR' as const };
      const flow = await passwordFlow(identifier, now());
      await storeChallenge(flow);
      return { status: 'READY' as const };
    },

    async submitPassword(formData: FormData) {
      const currentTime = now();
      const identifier = formString(formData, 'identifier').trim();
      const password = formString(formData, 'password');
      if (!identifier || !password) return publicPasswordStepResult();
      const existing = await verifyAdminMfaChallenge(cookies.get(ADMIN_MFA_CHALLENGE_COOKIE), challengeSigningKey, currentTime);
      const expectedBinding = await createAdminMfaIdentifierBinding(identifier, challengeSigningKey);
      let flow = existing?.stage === 'PASSWORD' && existing.identifierBinding === expectedBinding ? existing : null;
      if (!flow && !requirePreflight) flow = await passwordFlow(identifier, currentTime);
      if (!flow) {
        recordSafeTelemetry(telemetry, createSafeTelemetryEvent('login.password', 'CHALLENGE_INVALID'));
        return passwordPreflightRequired();
      }

      try {
        const idempotencyKey = await deriveAdminMfaIdempotencyKey(flow.seed, `password:${identifier}:${password}`, challengeSigningKey);

        const result = await authPort.beginPasswordChallenge({
          correlationId: flow.correlationId,
          identifier,
          idempotencyKey,
          password,
        });
        if (result.indeterminate) {
          await storeChallenge(flow);
          return passwordPreflightFailure();
        }
        const challenge = normalizeChallenge(result, currentTime);
        if (result.rotateIntent) {
          await storeChallenge({ ...flow, seed: createRandomAdminMfaChallengeId() });
          return passwordPreflightFailure();
        }
        if (!challenge) {
          recordActionTechnicalFailure('login.password', 'MALFORMED_RESPONSE');
          await storeChallenge(flow);
          return passwordPreflightFailure();
        }
        await storeChallenge({ ...flow, ...challenge, stage: 'TOTP' });
      } catch (error) {
        if (!consumeTechnicalFailure(error)) {
          recordActionTechnicalFailure('login.password', 'UPSTREAM_FAILURE');
        }
        try {
          await storeChallenge(flow);
        } catch {
          cookies.delete(ADMIN_MFA_CHALLENGE_COOKIE);
          recordActionTechnicalFailure('login.password', 'ACTION_FAILURE');
        }
        return passwordPreflightFailure();
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
      if (!challenge || challenge.stage !== 'TOTP') {
        recordSafeTelemetry(telemetry, createSafeTelemetryEvent('login.totp', 'CHALLENGE_INVALID'));
        return genericTotpFailure;
      }
      if (!isValidAdminMfaChallengeId(challenge.challengeId)) return genericTotpFailure;

      try {
        const idempotencyKey = await deriveAdminMfaIdempotencyKey(challenge.seed, `totp:${challenge.challengeId}:${validatedCode.code}`, challengeSigningKey);
        const result = await authPort.verifyTotp({
          challengeId: challenge.challengeId,
          code: validatedCode.code,
          correlationId: challenge.correlationId,
          idempotencyKey,
        });
        if (result.kind === 'AUTHENTICATED' && result.expiresAt > currentTime) {
          const sessionInstanceId = createSessionInstanceId();
          if (!isUuidV7(sessionInstanceId)) throw new Error('Invalid session instance ID');
          const sessionToken = await signAdminSession(
            {
              dataScope: result.subject.dataScope,
              expiresAt: result.expiresAt,
              permissions: [...result.subject.permissions],
              sessionInstanceId,
              subjectId: result.subject.subjectId,
            },
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
      } catch (error) {
        if (!consumeTechnicalFailure(error)) {
          recordActionTechnicalFailure('login.totp', 'UPSTREAM_FAILURE');
        }
      }

      return genericTotpFailure;
    },
  };
}
