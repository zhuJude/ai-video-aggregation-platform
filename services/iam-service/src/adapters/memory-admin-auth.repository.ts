import type {
  AdminAccountRecord,
  AdminAuthRepository,
  AdminSessionRecord,
  CompleteMfaResult,
  CreateAdminSessionInput,
  MfaChallengeRecord,
  MfaChallengeState,
  RotateAdminSessionResult,
} from '../application/admin-auth.repository.js';
import type { MemoryAdminAccessCoordinator } from './memory-admin-access.coordinator.js';

interface MutableAdmin {
  id: string;
  email: string;
  passwordHash: string;
  status: AdminAccountRecord['status'];
  mfaEnabled: boolean;
  pendingTotpSecretCiphertext: string | null;
  totpSecretCiphertext: string | null;
  lastTotpTimeStep: number | null;
  recoveryGeneration: string | null;
  mfaFailureCount: number;
  mfaFailureWindowStartedAt: Date | null;
  mfaLockedUntil: Date | null;
}

function activate(session: MutableSession): void {
  session.status = 'ACTIVE';
  session.pendingKind = null;
  session.pendingChallengeId = null;
  session.pendingRecoveryCodeId = null;
  session.pendingTotpTimeStep = null;
  session.pendingPredecessorId = null;
  session.pendingExpiresAt = null;
}
function cancel(session: MutableSession, now: Date): void {
  session.status = 'CANCELLED';
  session.revokedAt ??= now;
  session.pendingExpiresAt = null;
}
interface MutableChallenge extends MfaChallengeRecord {
  attempts: number;
  consumedAt: Date | null;
  reservedSessionId: string | null;
  reservedUntil: Date | null;
}
interface MutableSession extends AdminSessionRecord {
  consumedAt: Date | null;
  revokedAt: Date | null;
  status: 'PENDING' | 'ACTIVE' | 'CANCELLED';
  pendingExpiresAt: Date | null;
  pendingKind: 'MFA_TOTP' | 'MFA_RECOVERY' | 'REFRESH' | null;
  pendingChallengeId: string | null;
  pendingRecoveryCodeId: string | null;
  pendingTotpTimeStep: number | null;
  pendingPredecessorId: string | null;
}
interface MutableRecoveryCode {
  id: string;
  adminId: string;
  generation: string;
  digest: string;
  pepperVersion: string;
  consumedAt: Date | null;
  createdAt: Date;
  reservedSessionId: string | null;
  reservedUntil: Date | null;
}
type LocatedChallenge =
  | { readonly kind: MfaChallengeState }
  | { readonly challenge: MutableChallenge; readonly admin: MutableAdmin };

export class MemoryAdminAuthRepository implements AdminAuthRepository {
  private readonly admins = new Map<string, MutableAdmin>();
  private readonly challenges = new Map<string, MutableChallenge>();
  private readonly sessions = new Map<string, MutableSession>();
  private readonly recoveryCodes = new Map<string, MutableRecoveryCode>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    admins: readonly AdminAccountRecord[] = [],
    private readonly coordinator?: MemoryAdminAccessCoordinator,
  ) {
    for (const admin of admins) this.admins.set(admin.id, { ...admin });
    coordinator?.registerAuth({
      exists: (adminId) => this.admins.has(adminId),
      commit: (adminId, now) => {
        this.disableAuthState(adminId, now);
      },
    });
  }

  findAdminByEmail(email: string): Promise<AdminAccountRecord | null> {
    const admin = [...this.admins.values()].find((candidate) => candidate.email === email);
    return Promise.resolve(admin ? { ...admin } : null);
  }

  findAdminById(adminId: string): Promise<AdminAccountRecord | null> {
    const admin = this.admins.get(adminId);
    return Promise.resolve(admin ? { ...admin } : null);
  }

  async updatePasswordHash(adminId: string, passwordHash: string): Promise<void> {
    await this.exclusive(() => {
      const admin = this.admins.get(adminId);
      if (admin) admin.passwordHash = passwordHash;
    });
  }

  async savePendingTotpSecret(adminId: string, ciphertext: string): Promise<boolean> {
    return this.exclusive(() => {
      const admin = this.admins.get(adminId);
      if (!admin || admin.status !== 'ACTIVE' || admin.mfaEnabled) return false;
      this.admins.set(adminId, { ...admin, pendingTotpSecretCiphertext: ciphertext });
      return true;
    });
  }

  async confirmMfaEnrollment(input: Parameters<AdminAuthRepository['confirmMfaEnrollment']>[0]) {
    return this.exclusive(() => {
      const admin = this.admins.get(input.adminId);
      if (
        !admin ||
        admin.status !== 'ACTIVE' ||
        admin.pendingTotpSecretCiphertext !== input.expectedPendingCiphertext
      ) {
        return 'invalid' as const;
      }
      if (admin.lastTotpTimeStep !== null && input.timeStep <= admin.lastTotpTimeStep) {
        return 'replay' as const;
      }
      this.replaceCodes(input.adminId, input.recoveryGeneration, input.recoveryCodes, input.now);
      this.admins.set(input.adminId, {
        ...admin,
        mfaEnabled: true,
        totpSecretCiphertext: input.expectedPendingCiphertext,
        pendingTotpSecretCiphertext: null,
        lastTotpTimeStep: input.timeStep,
        recoveryGeneration: input.recoveryGeneration,
      });
      return 'confirmed' as const;
    });
  }

  async replaceRecoveryCodes(input: Parameters<AdminAuthRepository['replaceRecoveryCodes']>[0]) {
    return this.exclusive(() => {
      const admin = this.admins.get(input.adminId);
      if (!admin || admin.status !== 'ACTIVE' || !admin.mfaEnabled || !admin.totpSecretCiphertext) {
        return 'invalid' as const;
      }
      if (admin.lastTotpTimeStep !== null && input.timeStep <= admin.lastTotpTimeStep) {
        return 'replay' as const;
      }
      this.replaceCodes(input.adminId, input.recoveryGeneration, input.recoveryCodes, input.now);
      this.admins.set(input.adminId, {
        ...admin,
        lastTotpTimeStep: input.timeStep,
        recoveryGeneration: input.recoveryGeneration,
      });
      return 'replaced' as const;
    });
  }

  async createMfaChallenge(
    input: Omit<MfaChallengeRecord, 'attempts' | 'consumedAt'>,
  ): Promise<'created' | 'inactive' | 'locked'> {
    return this.exclusive(() => {
      const admin = this.admins.get(input.adminId);
      if (!admin || admin.status !== 'ACTIVE' || !admin.mfaEnabled) return 'inactive';
      if (admin.mfaLockedUntil && admin.mfaLockedUntil > input.createdAt) return 'locked';
      this.challenges.set(input.challengeDigest, {
        ...input,
        attempts: 0,
        consumedAt: null,
        reservedSessionId: null,
        reservedUntil: null,
      });
      return 'created';
    });
  }

  getMfaChallenge(challengeDigest: string) {
    const challenge = this.challenges.get(challengeDigest);
    if (!challenge) return Promise.resolve(null);
    const admin = this.admins.get(challenge.adminId);
    if (!admin) return Promise.resolve(null);
    return Promise.resolve({ challenge: { ...challenge }, admin: { ...admin } });
  }

  async recordInvalidMfaAttempt(
    challengeDigest: string,
    now: Date,
    maxAttempts: number,
    failureWindowMs: number,
    lockDurationMs: number,
  ): Promise<MfaChallengeState> {
    return this.exclusive(() => {
      const state = this.locateChallenge(challengeDigest, now, maxAttempts);
      if ('kind' in state) return state.kind;
      this.recordMfaFailure(
        state.admin,
        state.challenge,
        now,
        maxAttempts,
        failureWindowMs,
        lockDurationMs,
      );
      return 'invalid';
    });
  }

  async completeTotpChallenge(
    input: Parameters<AdminAuthRepository['completeTotpChallenge']>[0],
  ): Promise<CompleteMfaResult> {
    return this.exclusive(() => {
      const state = this.locateChallenge(input.challengeDigest, input.now, input.maxAttempts);
      if (!('challenge' in state)) return state;
      if (input.session.adminId !== state.admin.id) return { kind: 'invalid' };
      if (state.admin.lastTotpTimeStep !== null && input.timeStep <= state.admin.lastTotpTimeStep) {
        this.recordMfaFailure(
          state.admin,
          state.challenge,
          input.now,
          input.maxAttempts,
          input.failureWindowMs,
          input.lockDurationMs,
        );
        return { kind: 'replay' };
      }
      const competing = [...this.sessions.values()].some(
        (session) =>
          session.adminId === state.admin.id &&
          session.status === 'PENDING' &&
          session.pendingTotpTimeStep !== null &&
          session.pendingTotpTimeStep >= input.timeStep &&
          session.pendingExpiresAt !== null &&
          session.pendingExpiresAt > input.now,
      );
      if (competing) return { kind: 'replay' };
      return this.reserveChallenge(state.challenge, input.session, input.now, 'MFA_TOTP', {
        pendingTotpTimeStep: input.timeStep,
      });
    });
  }

  async completeRecoveryChallenge(
    input: Parameters<AdminAuthRepository['completeRecoveryChallenge']>[0],
  ): Promise<CompleteMfaResult> {
    return this.exclusive(() => {
      const state = this.locateChallenge(input.challengeDigest, input.now, input.maxAttempts);
      if (!('challenge' in state)) return state;
      if (input.session.adminId !== state.admin.id) return { kind: 'invalid' };
      const recovery = [...this.recoveryCodes.values()].find(
        (candidate) =>
          candidate.adminId === state.admin.id &&
          candidate.generation === input.recoveryGeneration &&
          input.recoveryCandidates.some(
            (pair) =>
              pair.pepperVersion === candidate.pepperVersion && pair.digest === candidate.digest,
          ) &&
          candidate.consumedAt === null &&
          (!candidate.reservedUntil || candidate.reservedUntil <= input.now),
      );
      if (!recovery || state.admin.recoveryGeneration !== input.recoveryGeneration) {
        this.recordMfaFailure(
          state.admin,
          state.challenge,
          input.now,
          input.maxAttempts,
          input.failureWindowMs,
          input.lockDurationMs,
        );
        return { kind: 'invalid' };
      }
      recovery.reservedSessionId = input.session.id;
      recovery.reservedUntil = new Date(
        Math.min(state.challenge.expiresAt.getTime(), input.now.getTime() + 2 * 60_000),
      );
      return this.reserveChallenge(state.challenge, input.session, input.now, 'MFA_RECOVERY', {
        pendingRecoveryCodeId: recovery.id,
      });
    });
  }

  async rotateSession(
    input: Parameters<AdminAuthRepository['rotateSession']>[0],
  ): Promise<RotateAdminSessionResult> {
    return this.exclusive(() => {
      const current = [...this.sessions.values()].find(
        (session) => session.refreshTokenDigest === input.presentedDigest,
      );
      if (!current) return { kind: 'invalid' };
      if (current.status !== 'ACTIVE') return { kind: 'invalid' };
      if (current.consumedAt) {
        this.revokeFamily(current.familyId, input.now);
        return { kind: 'reuse' };
      }
      if (current.revokedAt) return { kind: 'revoked' };
      if (current.expiresAt <= input.now) return { kind: 'expired' };
      const admin = this.admins.get(current.adminId);
      if (!admin || admin.status !== 'ACTIVE') return { kind: 'admin_inactive' };
      const pending = [...this.sessions.values()].find(
        (session) =>
          session.pendingPredecessorId === current.id &&
          session.status === 'PENDING' &&
          session.pendingExpiresAt !== null &&
          session.pendingExpiresAt > input.now,
      );
      if (pending) return { kind: 'pending' };
      const successor: MutableSession = {
        ...input.successor,
        adminId: current.adminId,
        familyId: current.familyId,
        deviceName: current.deviceName,
        consumedAt: null,
        revokedAt: null,
        status: 'PENDING',
        pendingExpiresAt: new Date(input.now.getTime() + 2 * 60_000),
        pendingKind: 'REFRESH',
        pendingChallengeId: null,
        pendingRecoveryCodeId: null,
        pendingTotpTimeStep: null,
        pendingPredecessorId: current.id,
      };
      this.sessions.set(successor.id, successor);
      return { kind: 'rotated', session: { ...successor } };
    });
  }

  finalizeMfaSession(
    input: Parameters<AdminAuthRepository['finalizeMfaSession']>[0],
  ): Promise<AdminSessionRecord | null> {
    return this.exclusive(() => {
      const session = this.sessions.get(input.sessionId),
        challenge = this.challenges.get(input.challengeDigest),
        admin = this.admins.get(input.adminId);
      if (
        !session ||
        !challenge ||
        !admin ||
        session.adminId !== input.adminId ||
        session.familyId !== input.familyId ||
        session.status !== 'PENDING' ||
        session.pendingChallengeId !== challenge.id ||
        challenge.adminId !== admin.id
      )
        return null;
      if (
        admin.status !== 'ACTIVE' ||
        session.revokedAt !== null ||
        session.expiresAt <= input.now ||
        !session.pendingExpiresAt ||
        session.pendingExpiresAt <= input.now ||
        challenge.consumedAt !== null ||
        challenge.expiresAt <= input.now ||
        challenge.reservedSessionId !== session.id ||
        !challenge.reservedUntil ||
        challenge.reservedUntil <= input.now
      ) {
        this.cancelMfaReservation(session, challenge, input.now);
        return null;
      }
      if (session.pendingKind === 'MFA_TOTP') {
        if (
          session.pendingTotpTimeStep === null ||
          (admin.lastTotpTimeStep !== null && session.pendingTotpTimeStep <= admin.lastTotpTimeStep)
        ) {
          this.cancelMfaReservation(session, challenge, input.now);
          return null;
        }
        admin.lastTotpTimeStep = session.pendingTotpTimeStep;
      } else if (session.pendingKind === 'MFA_RECOVERY') {
        const recovery = session.pendingRecoveryCodeId
          ? this.recoveryCodes.get(session.pendingRecoveryCodeId)
          : undefined;
        if (
          !recovery ||
          recovery.reservedSessionId !== session.id ||
          recovery.consumedAt ||
          !recovery.reservedUntil ||
          recovery.reservedUntil <= input.now
        ) {
          this.cancelMfaReservation(session, challenge, input.now);
          return null;
        }
        recovery.consumedAt = input.now;
        recovery.reservedSessionId = null;
        recovery.reservedUntil = null;
      } else return null;
      challenge.consumedAt = input.now;
      challenge.reservedSessionId = null;
      challenge.reservedUntil = null;
      this.clearMfaFailures(admin);
      activate(session);
      return { ...session };
    });
  }
  releaseMfaSession(input: Parameters<AdminAuthRepository['releaseMfaSession']>[0]): Promise<void> {
    return this.exclusive(() => {
      const session = this.sessions.get(input.sessionId);
      if (
        !session ||
        session.adminId !== input.adminId ||
        session.familyId !== input.familyId ||
        session.status !== 'PENDING'
      )
        return;
      const challenge = this.challenges.get(input.challengeDigest);
      this.cancelMfaReservation(session, challenge, input.now);
    });
  }
  finalizeRotatedSession(
    input: Parameters<AdminAuthRepository['finalizeRotatedSession']>[0],
  ): Promise<AdminSessionRecord | null> {
    return this.exclusive(() => {
      const current = [...this.sessions.values()].find(
          (session) => session.refreshTokenDigest === input.presentedDigest,
        ),
        successor = this.sessions.get(input.successorId);
      if (
        !current ||
        !successor ||
        successor.adminId !== current.adminId ||
        successor.familyId !== current.familyId ||
        successor.pendingPredecessorId !== current.id
      )
        return null;
      const admin = this.admins.get(current.adminId);
      if (
        !admin ||
        admin.status !== 'ACTIVE' ||
        current.status !== 'ACTIVE' ||
        current.consumedAt ||
        current.revokedAt ||
        current.expiresAt <= input.now ||
        successor.status !== 'PENDING' ||
        successor.pendingKind !== 'REFRESH' ||
        successor.revokedAt ||
        successor.expiresAt <= input.now ||
        !successor.pendingExpiresAt ||
        successor.pendingExpiresAt <= input.now
      ) {
        if (successor.status === 'PENDING') cancel(successor, input.now);
        return null;
      }
      current.consumedAt = input.now;
      activate(successor);
      return { ...successor };
    });
  }
  releaseRotatedSession(
    input: Parameters<AdminAuthRepository['releaseRotatedSession']>[0],
  ): Promise<void> {
    return this.exclusive(() => {
      const current = [...this.sessions.values()].find(
          (session) => session.refreshTokenDigest === input.presentedDigest,
        ),
        successor = this.sessions.get(input.successorId);
      if (
        current &&
        successor?.pendingPredecessorId === current.id &&
        successor.status === 'PENDING'
      )
        cancel(successor, input.now);
    });
  }

  revokeSessionFamily(adminId: string, familyId: string, now: Date): Promise<boolean> {
    return this.exclusive(() => {
      let found = false;
      for (const session of this.sessions.values()) {
        if (session.adminId === adminId && session.familyId === familyId) {
          found = true;
          if (!session.revokedAt) session.revokedAt = now;
        }
      }
      return found;
    });
  }

  disableAdminAccess(
    adminId: string,
    now: Date,
  ): Promise<'disabled' | 'not_found' | 'last_super_admin'> {
    if (this.coordinator) return this.coordinator.disableAdminAccess(adminId, now);
    return Promise.reject(stableError('ADMIN_DISABLE_COORDINATOR_UNAVAILABLE'));
  }

  cleanupExpiredPendingSessions(now: Date, limit = 100): Promise<number> {
    return this.exclusive(() => {
      const boundedLimit = normalizeCleanupLimit(limit);
      const expired = [...this.sessions.values()]
        .filter(
          (session) =>
            session.status === 'PENDING' &&
            session.pendingExpiresAt !== null &&
            session.pendingExpiresAt <= now,
        )
        .sort(
          (left, right) =>
            (left.pendingExpiresAt?.getTime() ?? 0) -
              (right.pendingExpiresAt?.getTime() ?? 0) || left.id.localeCompare(right.id),
        )
        .slice(0, boundedLimit);
      for (const session of expired) {
        const challenge = session.pendingChallengeId
          ? [...this.challenges.values()].find(
              (candidate) => candidate.id === session.pendingChallengeId,
            )
          : undefined;
        this.cancelMfaReservation(session, challenge, now);
      }
      return expired.length;
    });
  }

  private cancelMfaReservation(
    session: MutableSession,
    challenge: MutableChallenge | undefined,
    now: Date,
  ): void {
    if (challenge?.reservedSessionId === session.id) {
      challenge.reservedSessionId = null;
      challenge.reservedUntil = null;
    }
    if (session.pendingRecoveryCodeId) {
      const recovery = this.recoveryCodes.get(session.pendingRecoveryCodeId);
      if (recovery?.reservedSessionId === session.id) {
        recovery.reservedSessionId = null;
        recovery.reservedUntil = null;
      }
    }
    cancel(session, now);
  }

  private locateChallenge(
    challengeDigest: string,
    now: Date,
    maxAttempts: number,
  ): LocatedChallenge {
    const challenge = this.challenges.get(challengeDigest);
    if (!challenge) return { kind: 'not_found' as const };
    const admin = this.admins.get(challenge.adminId);
    if (
      !admin ||
      admin.status !== 'ACTIVE' ||
      !admin.mfaEnabled ||
      !admin.totpSecretCiphertext ||
      !admin.recoveryGeneration
    ) {
      return { kind: 'inactive' as const };
    }
    if (challenge.consumedAt) return { kind: 'used' as const };
    if (challenge.reservedUntil && challenge.reservedUntil > now)
      return { kind: 'locked' as const };
    if (challenge.expiresAt <= now) return { kind: 'expired' as const };
    if (admin.mfaLockedUntil && admin.mfaLockedUntil > now) return { kind: 'locked' as const };
    if (challenge.attempts >= maxAttempts) return { kind: 'locked' as const };
    return { challenge, admin };
  }

  private reserveChallenge(
    challenge: MutableChallenge,
    input: CreateAdminSessionInput,
    now: Date,
    kind: 'MFA_TOTP' | 'MFA_RECOVERY',
    pending: { pendingTotpTimeStep?: number; pendingRecoveryCodeId?: string },
  ): CompleteMfaResult {
    const pendingExpiresAt = new Date(
      Math.min(challenge.expiresAt.getTime(), now.getTime() + 2 * 60_000),
    );
    challenge.reservedSessionId = input.id;
    challenge.reservedUntil = pendingExpiresAt;
    const session: MutableSession = {
      ...input,
      consumedAt: null,
      revokedAt: null,
      status: 'PENDING',
      pendingExpiresAt,
      pendingKind: kind,
      pendingChallengeId: challenge.id,
      pendingRecoveryCodeId: pending.pendingRecoveryCodeId ?? null,
      pendingTotpTimeStep: pending.pendingTotpTimeStep ?? null,
      pendingPredecessorId: null,
    };
    this.sessions.set(session.id, session);
    return { kind: 'authenticated', session: { ...session } };
  }

  private replaceCodes(
    adminId: string,
    generation: string,
    inputs: readonly {
      readonly id: string;
      readonly digest: string;
      readonly pepperVersion: string;
    }[],
    now: Date,
  ): void {
    for (const [id, code] of this.recoveryCodes) {
      if (code.adminId === adminId) this.recoveryCodes.delete(id);
    }
    for (const input of inputs) {
      this.recoveryCodes.set(input.id, {
        ...input,
        adminId,
        generation,
        consumedAt: null,
        createdAt: now,
        reservedSessionId: null,
        reservedUntil: null,
      });
    }
  }

  private clearMfaFailures(admin: MutableAdmin): void {
    admin.mfaFailureCount = 0;
    admin.mfaFailureWindowStartedAt = null;
    admin.mfaLockedUntil = null;
  }

  private recordMfaFailure(
    admin: MutableAdmin,
    challenge: MutableChallenge,
    now: Date,
    maxAttempts: number,
    failureWindowMs: number,
    lockDurationMs: number,
  ): void {
    challenge.attempts += 1;
    const windowExpired =
      !admin.mfaFailureWindowStartedAt ||
      admin.mfaFailureWindowStartedAt.getTime() <= now.getTime() - failureWindowMs;
    admin.mfaFailureCount = windowExpired ? 1 : admin.mfaFailureCount + 1;
    if (windowExpired) admin.mfaFailureWindowStartedAt = now;
    if (admin.mfaFailureCount >= maxAttempts) {
      admin.mfaLockedUntil = new Date(now.getTime() + lockDurationMs);
    }
  }

  private revokeFamily(familyId: string, now: Date): void {
    for (const session of this.sessions.values()) {
      if (session.familyId === familyId && !session.revokedAt) session.revokedAt = now;
    }
  }

  private disableAuthState(adminId: string, now: Date): void {
    const admin = this.admins.get(adminId);
    if (!admin) throw stableError('ADMIN_DISABLE_STATE_MISMATCH');
    admin.status = 'DISABLED';
    for (const session of this.sessions.values()) {
      if (session.adminId !== adminId) continue;
      if (session.status === 'PENDING') {
        const challenge = session.pendingChallengeId
          ? [...this.challenges.values()].find(
              (candidate) => candidate.id === session.pendingChallengeId,
            )
          : undefined;
        this.cancelMfaReservation(session, challenge, now);
      } else if (session.status === 'ACTIVE' && !session.revokedAt) {
        session.revokedAt = now;
      }
    }
  }

  private async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.coordinator) return this.coordinator.runExclusive(operation);
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function normalizeCleanupLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw Object.assign(new Error('INVALID_PENDING_CLEANUP_LIMIT'), {
      code: 'INVALID_PENDING_CLEANUP_LIMIT',
    });
  }
  return limit;
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
