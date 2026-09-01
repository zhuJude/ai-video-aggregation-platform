import { createHash, createHmac, randomBytes as nodeRandomBytes } from 'node:crypto';

import { assertUuidV7, generateUuidV7 } from '../domain/uuid-v7.js';
import type { AdminAccessTokenIssuer } from '../ports/admin-access-token.js';
import type { AdminLoginThrottle } from '../ports/admin-login-throttle.js';
import type { PasswordHasher } from '../ports/password-hasher.js';
import type { SecretCipher } from '../ports/secret-cipher.js';
import type { TotpProvider } from '../ports/totp-provider.js';
import type {
  AdminAccountRecord,
  AdminAuthRepository,
  AdminSessionRecord,
  CompleteMfaResult,
  CreateAdminSessionInput,
  MfaChallengeState,
  RecoveryCodeInput,
  RotateAdminSessionResult,
} from './admin-auth.repository.js';

const MFA_CHALLENGE_LIFETIME_MS = 5 * 60 * 1_000;
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_MFA_ATTEMPTS = 5;
const MFA_FAILURE_WINDOW_MS = 15 * 60 * 1_000;
const MFA_LOCK_DURATION_MS = 15 * 60 * 1_000;
const RECOVERY_CODE_COUNT = 10;
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PASSWORD_INPUT_LENGTH = 1_024;
const OVERSIZED_PASSWORD_SENTINEL = 'iam-service:oversized-password-input:v1';

export interface AdminAuthServiceDependencies {
  readonly repository: AdminAuthRepository;
  readonly passwordHasher: PasswordHasher;
  readonly dummyPasswordHash: string;
  readonly secretCipher: SecretCipher;
  readonly totpProvider: TotpProvider;
  readonly accessTokenIssuer: AdminAccessTokenIssuer;
  readonly recoveryCodePepper?: Uint8Array;
  readonly recoveryCodePepperKeyring?: {
    readonly current: { readonly version: string; readonly key: Uint8Array };
    readonly previous?: readonly { readonly version: string; readonly key: Uint8Array }[];
  };
  readonly loginThrottle: AdminLoginThrottle;
  readonly cleanupObserver: AdminAuthCleanupObserver;
  readonly now?: () => Date;
  readonly randomBytes?: () => Uint8Array;
  readonly uuidV7?: () => string;
}

export interface AdminAuthCleanupObserver {
  recordCleanupFailure(event: {
    readonly operation: 'MFA_SESSION_RELEASE' | 'REFRESH_SESSION_RELEASE';
    readonly code: 'ADMIN_AUTH_CLEANUP_FAILED';
  }): void | Promise<void>;
}

export interface IssuedAdminSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly session: AdminSessionRecord;
}

type EnrolledAdmin = AdminAccountRecord & {
  readonly mfaEnabled: true;
  readonly totpSecretCiphertext: string;
  readonly recoveryGeneration: string;
};

export class AdminAuthService {
  private readonly repository: AdminAuthRepository;
  private readonly passwordHasher: PasswordHasher;
  private readonly dummyPasswordHash: string;
  private readonly secretCipher: SecretCipher;
  private readonly totpProvider: TotpProvider;
  private readonly accessTokenIssuer: AdminAccessTokenIssuer;
  private readonly recoveryCodePepperKeyring: readonly {
    readonly version: string;
    readonly key: Buffer;
  }[];
  private readonly loginThrottle: AdminLoginThrottle;
  private readonly cleanupObserver: AdminAuthCleanupObserver;
  private readonly now: () => Date;
  private readonly randomBytes: () => Uint8Array;
  private readonly uuidV7: () => string;

  constructor(dependencies: AdminAuthServiceDependencies) {
    if (!dependencies.passwordHasher.isPolicyDigest(dependencies.dummyPasswordHash)) {
      throw stableError('INVALID_DUMMY_PASSWORD_HASH');
    }
    this.repository = dependencies.repository;
    this.passwordHasher = dependencies.passwordHasher;
    this.dummyPasswordHash = dependencies.dummyPasswordHash;
    this.secretCipher = dependencies.secretCipher;
    this.totpProvider = dependencies.totpProvider;
    this.accessTokenIssuer = dependencies.accessTokenIssuer;
    this.recoveryCodePepperKeyring = snapshotRecoveryPepperKeyring(
      dependencies.recoveryCodePepperKeyring,
      dependencies.recoveryCodePepper,
    );
    this.loginThrottle = dependencies.loginThrottle;
    this.cleanupObserver = dependencies.cleanupObserver;
    this.now = dependencies.now ?? (() => new Date());
    this.randomBytes = dependencies.randomBytes ?? (() => nodeRandomBytes(32));
    this.uuidV7 = dependencies.uuidV7 ?? generateUuidV7;
  }

  async startMfaEnrollment(
    adminId: string,
  ): Promise<{ readonly secret: string; readonly provisioningUri: string }> {
    const admin = await this.requireAdmin(adminId);
    if (admin.mfaEnabled) throw stableError('MFA_ALREADY_ENABLED');
    const secret = this.totpProvider.generateSecret();
    const ciphertext = await this.secretCipher.encrypt(admin.id, secret);
    if (!(await this.repository.savePendingTotpSecret(admin.id, ciphertext))) {
      throw stableError('ADMIN_NOT_ACTIVE');
    }
    return {
      secret,
      provisioningUri: this.totpProvider.provisioningUri(admin.email, secret),
    };
  }

  async confirmMfaEnrollment(adminId: string, token: string): Promise<string[]> {
    const admin = await this.requireAdmin(adminId);
    if (!admin.pendingTotpSecretCiphertext) throw stableError('MFA_ENROLLMENT_NOT_STARTED');
    const secret = await this.secretCipher.decrypt(admin.id, admin.pendingTotpSecretCiphertext);
    const now = this.now();
    const timeStep = await this.totpProvider.verify(secret, token, now, admin.lastTotpTimeStep);
    if (timeStep === null) throw stableError('INVALID_MFA');
    const recovery = this.generateRecoveryCodes(admin.id);
    const result = await this.repository.confirmMfaEnrollment({
      adminId: admin.id,
      expectedPendingCiphertext: admin.pendingTotpSecretCiphertext,
      timeStep,
      recoveryGeneration: recovery.generation,
      recoveryCodes: recovery.records,
      now,
    });
    if (result === 'replay') throw stableError('MFA_REPLAY_DETECTED');
    if (result !== 'confirmed') throw stableError('MFA_ENROLLMENT_CONFLICT');
    return recovery.plaintext;
  }

  async regenerateRecoveryCodes(adminId: string, token: string): Promise<string[]> {
    const admin = await this.requireEnrolledAdmin(adminId);
    const secret = await this.secretCipher.decrypt(admin.id, admin.totpSecretCiphertext);
    const now = this.now();
    const timeStep = await this.totpProvider.verify(secret, token, now, admin.lastTotpTimeStep);
    if (timeStep === null) throw stableError('INVALID_MFA');
    const recovery = this.generateRecoveryCodes(admin.id);
    const result = await this.repository.replaceRecoveryCodes({
      adminId: admin.id,
      timeStep,
      recoveryGeneration: recovery.generation,
      recoveryCodes: recovery.records,
      now,
    });
    if (result === 'replay') throw stableError('MFA_REPLAY_DETECTED');
    if (result !== 'replaced') throw stableError('ADMIN_NOT_ACTIVE');
    return recovery.plaintext;
  }

  async verifyPassword(
    emailInput: string,
    password: string,
  ): Promise<{ readonly challengeId: string }> {
    const email = normalizeEmail(emailInput);
    const now = this.now();
    const permit = await this.loginThrottle.reserve(email, now);
    if (!permit) throw stableError('AUTH_RATE_LIMITED');
    let settled = false;
    try {
      const admin = await this.repository.findAdminByEmail(email);
      const passwordOversized = password.length > MAX_PASSWORD_INPUT_LENGTH;
      const verification = await this.passwordHasher.verify(
        admin?.passwordHash ?? this.dummyPasswordHash,
        passwordOversized ? OVERSIZED_PASSWORD_SENTINEL : password,
      );
      if (!admin || admin.status !== 'ACTIVE' || passwordOversized || !verification.valid) {
        await this.loginThrottle.commitFailure(permit, now);
        settled = true;
        throw stableError('INVALID_CREDENTIALS');
      }
      if (!admin.mfaEnabled || !admin.totpSecretCiphertext) {
        await this.loginThrottle.commitSuccess(permit);
        settled = true;
        throw stableError('MFA_NOT_ENROLLED');
      }
      if (verification.needsRehash)
        await this.repository.updatePasswordHash(
          admin.id,
          await this.passwordHasher.hash(password),
        );
      const challengeId = this.opaqueToken();
      const id = this.nextUuid('INVALID_MFA_CHALLENGE_ID');
      const created = await this.repository.createMfaChallenge({
        id,
        adminId: admin.id,
        challengeDigest: digestToken(challengeId),
        expiresAt: new Date(now.getTime() + MFA_CHALLENGE_LIFETIME_MS),
        createdAt: now,
      });
      await this.loginThrottle.commitSuccess(permit);
      settled = true;
      if (created === 'locked') throw stableError('MFA_CHALLENGE_LOCKED');
      if (created !== 'created') throw stableError('ADMIN_NOT_ACTIVE');
      return { challengeId };
    } finally {
      if (!settled) {
        try {
          await this.loginThrottle.release(permit);
        } catch {
          /* preserve primary dependency failure */
        }
      }
    }
  }

  async verifyTotp(
    challengeId: string,
    token: string,
    deviceName: string,
  ): Promise<IssuedAdminSession> {
    const digest = digestOpaqueToken(challengeId, 'INVALID_MFA');
    const now = this.now();
    const snapshot = await this.requireUsableChallenge(digest, now);
    const secret = await this.secretCipher.decrypt(snapshot.id, snapshot.totpSecretCiphertext);
    const timeStep = await this.totpProvider.verify(secret, token, now, null);
    if (timeStep === null) {
      await this.recordInvalidAttempt(digest, now);
      throw stableError('INVALID_MFA');
    }
    return this.completeSecondFactor(
      now,
      deviceName,
      (session) =>
        this.repository.completeTotpChallenge({
          challengeDigest: digest,
          now,
          maxAttempts: MAX_MFA_ATTEMPTS,
          failureWindowMs: MFA_FAILURE_WINDOW_MS,
          lockDurationMs: MFA_LOCK_DURATION_MS,
          timeStep,
          session,
        }),
      snapshot.id,
      digest,
    );
  }

  async verifyRecoveryCode(
    challengeId: string,
    recoveryCode: string,
    deviceName: string,
  ): Promise<IssuedAdminSession> {
    const digest = digestOpaqueToken(challengeId, 'INVALID_MFA');
    const now = this.now();
    const admin = await this.requireUsableChallenge(digest, now);
    if (!isRecoveryCode(recoveryCode)) {
      await this.recordInvalidAttempt(digest, now);
      throw stableError('INVALID_MFA');
    }
    const recoveryCandidates = this.recoveryCodePepperKeyring.map((entry) => ({
      pepperVersion: entry.version,
      digest: this.digestRecoveryCode(admin.id, admin.recoveryGeneration, recoveryCode, entry),
    }));
    return this.completeSecondFactor(
      now,
      deviceName,
      (session) =>
        this.repository.completeRecoveryChallenge({
          challengeDigest: digest,
          now,
          maxAttempts: MAX_MFA_ATTEMPTS,
          failureWindowMs: MFA_FAILURE_WINDOW_MS,
          lockDurationMs: MFA_LOCK_DURATION_MS,
          recoveryGeneration: admin.recoveryGeneration,
          recoveryCandidates,
          session,
        }),
      admin.id,
      digest,
    );
  }

  async rotateRefresh(refreshToken: string): Promise<IssuedAdminSession> {
    validateRefreshToken(refreshToken);
    const now = this.now();
    const successorToken = this.opaqueToken();
    const successorId = this.nextUuid('INVALID_ADMIN_SESSION_ID');
    const result = await this.repository.rotateSession({
      presentedDigest: digestToken(refreshToken),
      now,
      successor: {
        id: successorId,
        refreshTokenDigest: digestToken(successorToken),
        expiresAt: new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS),
        createdAt: now,
      },
    });
    if (result.kind !== 'rotated') throw stableError(refreshError(result));
    try {
      const accessToken = await this.accessTokenIssuer.issue({
        adminId: result.session.adminId,
        sessionId: result.session.id,
        issuedAt: now,
      });
      const finalizedAt = this.now();
      const finalized = await this.repository.finalizeRotatedSession({
        presentedDigest: digestToken(refreshToken),
        successorId: result.session.id,
        now: finalizedAt,
      });
      if (!finalized) throw stableError('ADMIN_SESSION_FINALIZATION_FAILED');
      return { accessToken, refreshToken: successorToken, session: finalized };
    } catch {
      try {
        await this.repository.releaseRotatedSession({
          presentedDigest: digestToken(refreshToken),
          successorId: result.session.id,
          now: this.now(),
        });
      } catch {
        await this.reportCleanupFailure('REFRESH_SESSION_RELEASE');
      }
      throw stableError('ADMIN_TOKEN_ISSUANCE_FAILED');
    }
  }

  async disableAdminAccess(adminId: string): Promise<'disabled' | 'not_found'> {
    assertUuidV7(adminId, 'INVALID_ADMIN_ID');
    const result = await this.repository.disableAdminAccess(adminId, this.now());
    if (result === 'last_super_admin') throw stableError('LAST_SUPER_ADMIN_PROTECTED');
    return result;
  }

  private async completeSecondFactor(
    now: Date,
    deviceName: string,
    complete: (session: CreateAdminSessionInput) => Promise<CompleteMfaResult>,
    adminId: string,
    challengeDigest: string,
  ): Promise<IssuedAdminSession> {
    validateDeviceName(deviceName);
    const refreshToken = this.opaqueToken();
    const session: CreateAdminSessionInput = {
      id: this.nextUuid('INVALID_ADMIN_SESSION_ID'),
      adminId,
      familyId: this.nextUuid('INVALID_ADMIN_SESSION_FAMILY_ID'),
      refreshTokenDigest: digestToken(refreshToken),
      deviceName: deviceName.trim(),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS),
      createdAt: now,
    };
    const result = await complete(session);
    if (result.kind !== 'authenticated') throw stableError(mfaError(result.kind));
    try {
      const accessToken = await this.accessTokenIssuer.issue({
        adminId,
        sessionId: session.id,
        issuedAt: now,
      });
      const finalizedAt = this.now();
      const finalized = await this.repository.finalizeMfaSession({
        adminId,
        sessionId: session.id,
        familyId: session.familyId,
        challengeDigest,
        now: finalizedAt,
      });
      if (!finalized) throw stableError('ADMIN_SESSION_FINALIZATION_FAILED');
      return { accessToken, refreshToken, session: finalized };
    } catch {
      try {
        await this.repository.releaseMfaSession({
          adminId,
          sessionId: session.id,
          familyId: session.familyId,
          challengeDigest,
          now: this.now(),
        });
      } catch {
        await this.reportCleanupFailure('MFA_SESSION_RELEASE');
      }
      throw stableError('ADMIN_TOKEN_ISSUANCE_FAILED');
    }
  }

  private async reportCleanupFailure(
    operation: 'MFA_SESSION_RELEASE' | 'REFRESH_SESSION_RELEASE',
  ): Promise<void> {
    const event = Object.freeze({ operation, code: 'ADMIN_AUTH_CLEANUP_FAILED' as const });
    try {
      await this.cleanupObserver.recordCleanupFailure(event);
    } catch {
      process.emitWarning(JSON.stringify(event), {
        code: 'IAM_CLEANUP_OBSERVER_FAILED',
        type: 'AdminAuthCleanupWarning',
      });
    }
  }

  private async requireAdmin(adminId: string): Promise<AdminAccountRecord> {
    const admin = await this.repository.findAdminById(adminId);
    if (!admin || admin.status !== 'ACTIVE') throw stableError('ADMIN_NOT_ACTIVE');
    return admin;
  }

  private async requireEnrolledAdmin(adminId: string): Promise<EnrolledAdmin> {
    const admin = await this.requireAdmin(adminId);
    if (!admin.mfaEnabled || !admin.totpSecretCiphertext || !admin.recoveryGeneration) {
      throw stableError('MFA_NOT_ENROLLED');
    }
    return admin as EnrolledAdmin;
  }

  private async requireUsableChallenge(digest: string, now: Date): Promise<EnrolledAdmin> {
    const snapshot = await this.repository.getMfaChallenge(digest);
    if (!snapshot) throw stableError('INVALID_MFA');
    const state = challengeState(snapshot.challenge, snapshot.admin, now);
    if (state) throw stableError(mfaError(state));
    return snapshot.admin as EnrolledAdmin;
  }

  private async recordInvalidAttempt(digest: string, now: Date): Promise<void> {
    const result = await this.repository.recordInvalidMfaAttempt(
      digest,
      now,
      MAX_MFA_ATTEMPTS,
      MFA_FAILURE_WINDOW_MS,
      MFA_LOCK_DURATION_MS,
    );
    if (result !== 'invalid') throw stableError(mfaError(result));
  }

  private generateRecoveryCodes(adminId: string): {
    readonly generation: string;
    readonly plaintext: string[];
    readonly records: RecoveryCodeInput[];
  } {
    const generation = this.nextUuid('INVALID_RECOVERY_GENERATION_ID');
    const plaintext: string[] = [];
    const records: RecoveryCodeInput[] = [];
    for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
      const entropy = this.randomBytes();
      if (entropy.byteLength < 16) throw stableError('INSUFFICIENT_RECOVERY_CODE_ENTROPY');
      const raw = Buffer.from(entropy).subarray(0, 16).toString('hex').toUpperCase();
      const code = raw.match(/.{1,8}/g)?.join('-');
      if (!code) throw stableError('RECOVERY_CODE_GENERATION_FAILED');
      plaintext.push(code);
      const currentPepper = this.recoveryCodePepperKeyring[0];
      if (!currentPepper) throw stableError('INVALID_RECOVERY_CODE_PEPPER');
      records.push({
        id: this.nextUuid('INVALID_RECOVERY_CODE_ID'),
        pepperVersion: currentPepper.version,
        digest: this.digestRecoveryCode(adminId, generation, code, currentPepper),
      });
    }
    return { generation, plaintext, records };
  }

  private digestRecoveryCode(
    adminId: string,
    generation: string,
    code: string,
    pepper: { readonly version: string; readonly key: Buffer },
  ): string {
    const context =
      pepper.version === 'legacy-v1'
        ? `iam-recovery:v1:${adminId}:${generation}:`
        : `iam-recovery:v2:${pepper.version}:${adminId}:${generation}:`;
    return createHmac('sha256', pepper.key)
      .update(context, 'utf8')
      .update(code, 'ascii')
      .digest('hex');
  }

  private opaqueToken(): string {
    const entropy = this.randomBytes();
    if (entropy.byteLength < 32) throw stableError('INSUFFICIENT_TOKEN_ENTROPY');
    return Buffer.from(entropy).subarray(0, 32).toString('base64url');
  }

  private nextUuid(code: string): string {
    const id = this.uuidV7();
    assertUuidV7(id, code);
    return id;
  }
}

function challengeState(
  challenge: {
    readonly attempts: number;
    readonly expiresAt: Date;
    readonly consumedAt: Date | null;
  },
  admin: AdminAccountRecord,
  now: Date,
): MfaChallengeState | null {
  if (challenge.consumedAt) return 'used';
  if (challenge.expiresAt <= now) return 'expired';
  if (challenge.attempts >= MAX_MFA_ATTEMPTS) return 'locked';
  if (admin.mfaLockedUntil && admin.mfaLockedUntil > now) return 'locked';
  if (
    admin.status !== 'ACTIVE' ||
    !admin.mfaEnabled ||
    !admin.totpSecretCiphertext ||
    !admin.recoveryGeneration
  )
    return 'inactive';
  return null;
}

function normalizeEmail(input: string): string {
  const value = input.trim().toLowerCase();
  if (value.length > 254 || !EMAIL_PATTERN.test(value)) throw stableError('INVALID_CREDENTIALS');
  return value;
}

function digestToken(token: string): string {
  return createHash('sha256').update(token, 'ascii').digest('hex');
}

function digestOpaqueToken(token: string, code: string): string {
  if (!REFRESH_TOKEN_PATTERN.test(token)) throw stableError(code);
  return digestToken(token);
}

function validateRefreshToken(token: string): void {
  if (!REFRESH_TOKEN_PATTERN.test(token)) throw stableError('INVALID_REFRESH_TOKEN');
}

function validateDeviceName(deviceName: string): void {
  const value = deviceName.trim();
  if (!value || value.length > 120) throw stableError('INVALID_DEVICE_NAME');
}

function isRecoveryCode(code: string): boolean {
  return /^(?:[0-9A-F]{8}-){3}[0-9A-F]{8}$/.test(code);
}

function mfaError(state: MfaChallengeState): string {
  return {
    not_found: 'INVALID_MFA',
    expired: 'MFA_CHALLENGE_EXPIRED',
    used: 'MFA_CHALLENGE_USED',
    locked: 'MFA_CHALLENGE_LOCKED',
    inactive: 'ADMIN_NOT_ACTIVE',
    invalid: 'INVALID_MFA',
    replay: 'MFA_REPLAY_DETECTED',
  }[state];
}

function refreshError(
  result: Exclude<RotateAdminSessionResult, { readonly kind: 'rotated' }>,
): string {
  return {
    invalid: 'INVALID_REFRESH_TOKEN',
    pending: 'REFRESH_IN_PROGRESS',
    reuse: 'REFRESH_REUSE_DETECTED',
    revoked: 'SESSION_REVOKED',
    expired: 'SESSION_EXPIRED',
    admin_inactive: 'ADMIN_NOT_ACTIVE',
  }[result.kind];
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function snapshotRecoveryPepperKeyring(
  keyring: AdminAuthServiceDependencies['recoveryCodePepperKeyring'],
  legacy: Uint8Array | undefined,
): readonly { readonly version: string; readonly key: Buffer }[] {
  try {
    const rawEntries: unknown[] = keyring
      ? [Reflect.get(keyring, 'current'), ...snapshotArray(Reflect.get(keyring, 'previous'))]
      : legacy
        ? [{ version: 'legacy-v1', key: legacy }]
        : [];
    const entries = rawEntries.map((raw) => {
      if (typeof raw !== 'object' || raw === null)
        throw stableError('INVALID_RECOVERY_CODE_PEPPER');
      const version = Reflect.get(raw, 'version') as unknown;
      const key = Reflect.get(raw, 'key') as unknown;
      if (typeof version !== 'string' || !(key instanceof Uint8Array))
        throw stableError('INVALID_RECOVERY_CODE_PEPPER');
      return Object.freeze({ version, key: Buffer.from(key) });
    });
    if (
      entries.length === 0 ||
      new Set(entries.map((entry) => entry.version)).size !== entries.length ||
      entries.some(
        (entry) => !/^[-A-Za-z0-9_.]{1,64}$/.test(entry.version) || entry.key.byteLength < 32,
      )
    )
      throw stableError('INVALID_RECOVERY_CODE_PEPPER');
    return Object.freeze(entries);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'code') === 'INVALID_RECOVERY_CODE_PEPPER'
    )
      throw error;
    throw stableError('INVALID_RECOVERY_CODE_PEPPER');
  }
}
function snapshotArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw stableError('INVALID_RECOVERY_CODE_PEPPER');
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1)
    result.push(Reflect.get(value, String(index)));
  return result;
}
