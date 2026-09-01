export type AdminStatus = 'ACTIVE' | 'DISABLED';

export interface AdminAccountRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly status: AdminStatus;
  readonly mfaEnabled: boolean;
  readonly pendingTotpSecretCiphertext: string | null;
  readonly totpSecretCiphertext: string | null;
  readonly lastTotpTimeStep: number | null;
  readonly recoveryGeneration: string | null;
  readonly mfaFailureCount: number;
  readonly mfaFailureWindowStartedAt: Date | null;
  readonly mfaLockedUntil: Date | null;
}

export interface MfaChallengeRecord {
  readonly id: string;
  readonly adminId: string;
  readonly challengeDigest: string;
  readonly expiresAt: Date;
  readonly attempts: number;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
}

export interface AdminSessionRecord {
  readonly id: string;
  readonly adminId: string;
  readonly familyId: string;
  readonly refreshTokenDigest: string;
  readonly deviceName: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly status: 'PENDING' | 'ACTIVE' | 'CANCELLED';
  readonly pendingExpiresAt: Date | null;
  readonly pendingKind: 'MFA_TOTP' | 'MFA_RECOVERY' | 'REFRESH' | null;
  readonly pendingChallengeId: string | null;
  readonly pendingRecoveryCodeId: string | null;
  readonly pendingTotpTimeStep: number | null;
  readonly pendingPredecessorId: string | null;
}

export interface RecoveryCodeInput {
  readonly id: string;
  readonly digest: string;
  readonly pepperVersion: string;
}
export interface RecoveryCodeCandidate {
  readonly pepperVersion: string;
  readonly digest: string;
}

export interface MfaChallengeSnapshot {
  readonly challenge: MfaChallengeRecord;
  readonly admin: AdminAccountRecord;
}

export type MfaChallengeState =
  'not_found' | 'expired' | 'used' | 'locked' | 'inactive' | 'invalid' | 'replay';

export interface CreateAdminSessionInput {
  readonly id: string;
  readonly adminId: string;
  readonly familyId: string;
  readonly refreshTokenDigest: string;
  readonly deviceName: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export type CompleteMfaResult =
  | { readonly kind: 'authenticated'; readonly session: AdminSessionRecord }
  | { readonly kind: MfaChallengeState };

export type RotateAdminSessionResult =
  | { readonly kind: 'rotated'; readonly session: AdminSessionRecord }
  | { readonly kind: 'invalid' | 'pending' | 'reuse' | 'revoked' | 'expired' | 'admin_inactive' };

export interface AdminAuthRepository {
  findAdminByEmail(email: string): Promise<AdminAccountRecord | null>;
  findAdminById(adminId: string): Promise<AdminAccountRecord | null>;
  updatePasswordHash(adminId: string, passwordHash: string): Promise<void>;
  savePendingTotpSecret(adminId: string, ciphertext: string): Promise<boolean>;
  confirmMfaEnrollment(input: {
    readonly adminId: string;
    readonly expectedPendingCiphertext: string;
    readonly timeStep: number;
    readonly recoveryGeneration: string;
    readonly recoveryCodes: readonly RecoveryCodeInput[];
    readonly now: Date;
  }): Promise<'confirmed' | 'invalid' | 'replay'>;
  replaceRecoveryCodes(input: {
    readonly adminId: string;
    readonly timeStep: number;
    readonly recoveryGeneration: string;
    readonly recoveryCodes: readonly RecoveryCodeInput[];
    readonly now: Date;
  }): Promise<'replaced' | 'invalid' | 'replay'>;
  createMfaChallenge(
    input: Omit<MfaChallengeRecord, 'attempts' | 'consumedAt'>,
  ): Promise<'created' | 'inactive' | 'locked'>;
  getMfaChallenge(challengeDigest: string): Promise<MfaChallengeSnapshot | null>;
  recordInvalidMfaAttempt(
    challengeDigest: string,
    now: Date,
    maxAttempts: number,
    failureWindowMs: number,
    lockDurationMs: number,
  ): Promise<MfaChallengeState>;
  completeTotpChallenge(input: {
    readonly challengeDigest: string;
    readonly now: Date;
    readonly maxAttempts: number;
    readonly failureWindowMs: number;
    readonly lockDurationMs: number;
    readonly timeStep: number;
    readonly session: CreateAdminSessionInput;
  }): Promise<CompleteMfaResult>;
  completeRecoveryChallenge(input: {
    readonly challengeDigest: string;
    readonly now: Date;
    readonly maxAttempts: number;
    readonly failureWindowMs: number;
    readonly lockDurationMs: number;
    readonly recoveryGeneration: string;
    readonly recoveryCandidates: readonly RecoveryCodeCandidate[];
    readonly session: CreateAdminSessionInput;
  }): Promise<CompleteMfaResult>;
  rotateSession(input: {
    readonly presentedDigest: string;
    readonly now: Date;
    readonly successor: Pick<
      CreateAdminSessionInput,
      'id' | 'refreshTokenDigest' | 'expiresAt' | 'createdAt'
    >;
  }): Promise<RotateAdminSessionResult>;
  finalizeMfaSession(input: {
    readonly adminId: string;
    readonly sessionId: string;
    readonly familyId: string;
    readonly challengeDigest: string;
    readonly now: Date;
  }): Promise<AdminSessionRecord | null>;
  releaseMfaSession(input: {
    readonly adminId: string;
    readonly sessionId: string;
    readonly familyId: string;
    readonly challengeDigest: string;
    readonly now: Date;
  }): Promise<void>;
  finalizeRotatedSession(input: {
    readonly presentedDigest: string;
    readonly successorId: string;
    readonly now: Date;
  }): Promise<AdminSessionRecord | null>;
  releaseRotatedSession(input: {
    readonly presentedDigest: string;
    readonly successorId: string;
    readonly now: Date;
  }): Promise<void>;
  revokeSessionFamily(adminId: string, familyId: string, now: Date): Promise<boolean>;
  /**
   * The only supported administrator-disable primitive. Access-token consumers must still
   * enforce the persisted session/admin state on every privileged request.
   */
  disableAdminAccess(adminId: string, now: Date): Promise<'disabled' | 'not_found'>;
  cleanupExpiredPendingSessions(now: Date, limit?: number): Promise<number>;
}
