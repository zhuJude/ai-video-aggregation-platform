import {
  Prisma,
  type AdminSession,
  type AdminUser,
  type MfaChallenge,
  type PrismaClient,
} from '../generated/prisma/client.js';
import type {
  AdminAccountRecord,
  AdminAuthRepository,
  AdminSessionRecord,
  CompleteMfaResult,
  CreateAdminSessionInput,
  MfaChallengeState,
  RotateAdminSessionResult,
} from '../application/admin-auth.repository.js';

const TRANSACTION_OPTIONS = Object.freeze({
  isolationLevel: 'ReadCommitted' as const,
  maxWait: 5_000,
  timeout: 15_000,
});

type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export class PrismaAdminAuthRepository implements AdminAuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findAdminByEmail(email: string): Promise<AdminAccountRecord | null> {
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });
    return admin ? mapAdmin(admin) : null;
  }

  async findAdminById(adminId: string): Promise<AdminAccountRecord | null> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    return admin ? mapAdmin(admin) : null;
  }

  async updatePasswordHash(adminId: string, passwordHash: string): Promise<void> {
    await this.prisma.adminUser.updateMany({
      where: { id: adminId, status: 'ACTIVE' },
      data: { passwordHash },
    });
  }

  savePendingTotpSecret(adminId: string, ciphertext: string): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      await acquireLocks(transaction, [`iam:admin:${adminId}`]);
      const result = await transaction.adminUser.updateMany({
        where: { id: adminId, status: 'ACTIVE', mfaEnabled: false },
        data: { pendingTotpSecretCiphertext: ciphertext },
      });
      return result.count === 1;
    }, TRANSACTION_OPTIONS);
  }

  confirmMfaEnrollment(input: Parameters<AdminAuthRepository['confirmMfaEnrollment']>[0]) {
    return this.prisma.$transaction(async (transaction) => {
      await acquireLocks(transaction, [`iam:admin:${input.adminId}`]);
      const admin = await transaction.adminUser.findUnique({ where: { id: input.adminId } });
      if (
        !admin ||
        admin.status !== 'ACTIVE' ||
        admin.pendingTotpSecretCiphertext !== input.expectedPendingCiphertext
      ) {
        return 'invalid' as const;
      }
      if (admin.lastTotpTimeStep !== null && BigInt(input.timeStep) <= admin.lastTotpTimeStep) {
        return 'replay' as const;
      }
      await transaction.mfaRecoveryCode.deleteMany({ where: { adminId: input.adminId } });
      await transaction.mfaRecoveryCode.createMany({
        data: input.recoveryCodes.map((code) => ({
          ...code,
          adminId: input.adminId,
          generation: input.recoveryGeneration,
          createdAt: input.now,
        })),
      });
      await transaction.adminUser.update({
        where: { id: input.adminId },
        data: {
          mfaEnabled: true,
          totpSecretCiphertext: input.expectedPendingCiphertext,
          pendingTotpSecretCiphertext: null,
          lastTotpTimeStep: BigInt(input.timeStep),
          recoveryGeneration: input.recoveryGeneration,
        },
      });
      return 'confirmed' as const;
    }, TRANSACTION_OPTIONS);
  }

  replaceRecoveryCodes(input: Parameters<AdminAuthRepository['replaceRecoveryCodes']>[0]) {
    return this.prisma.$transaction(async (transaction) => {
      await acquireLocks(transaction, [`iam:admin:${input.adminId}`]);
      const admin = await transaction.adminUser.findUnique({ where: { id: input.adminId } });
      if (!admin || admin.status !== 'ACTIVE' || !admin.mfaEnabled || !admin.totpSecretCiphertext) {
        return 'invalid' as const;
      }
      if (admin.lastTotpTimeStep !== null && BigInt(input.timeStep) <= admin.lastTotpTimeStep) {
        return 'replay' as const;
      }
      await transaction.mfaRecoveryCode.deleteMany({ where: { adminId: input.adminId } });
      await transaction.mfaRecoveryCode.createMany({
        data: input.recoveryCodes.map((code) => ({
          ...code,
          adminId: input.adminId,
          generation: input.recoveryGeneration,
          createdAt: input.now,
        })),
      });
      await transaction.adminUser.update({
        where: { id: input.adminId },
        data: {
          lastTotpTimeStep: BigInt(input.timeStep),
          recoveryGeneration: input.recoveryGeneration,
        },
      });
      return 'replaced' as const;
    }, TRANSACTION_OPTIONS);
  }

  createMfaChallenge(
    input: Parameters<AdminAuthRepository['createMfaChallenge']>[0],
  ): Promise<'created' | 'inactive' | 'locked'> {
    return this.prisma.$transaction(async (transaction) => {
      await acquireLocks(transaction, [`iam:admin:${input.adminId}`]);
      const databaseTime = await loadDatabaseClock(transaction);
      const admin = await transaction.adminUser.findUnique({ where: { id: input.adminId } });
      if (!admin || admin.status !== 'ACTIVE' || !admin.mfaEnabled || !admin.totpSecretCiphertext) {
        return 'inactive' as const;
      }
      if (
        input.expiresAt <= databaseTime ||
        (admin.mfaLockedUntil && admin.mfaLockedUntil > databaseTime)
      ) {
        return 'locked' as const;
      }
      await transaction.mfaChallenge.create({ data: input });
      return 'created' as const;
    }, TRANSACTION_OPTIONS);
  }

  async getMfaChallenge(challengeDigest: string) {
    const challenge = await this.prisma.mfaChallenge.findUnique({
      where: { challengeDigest },
      include: { admin: true },
    });
    if (!challenge) return null;
    return { challenge: mapChallenge(challenge), admin: mapAdmin(challenge.admin) };
  }

  recordInvalidMfaAttempt(
    challengeDigest: string,
    _now: Date,
    maxAttempts: number,
    failureWindowMs: number,
    lockDurationMs: number,
  ): Promise<MfaChallengeState> {
    return this.prisma.$transaction(async (transaction) => {
      const locked = await lockAndLoadChallenge(transaction, challengeDigest);
      if (!locked) return 'not_found';
      const databaseTime = await loadDatabaseClock(transaction);
      const state = classifyChallenge(locked, databaseTime, maxAttempts);
      if (state) return state;
      await recordMfaFailure(
        transaction,
        locked,
        databaseTime,
        maxAttempts,
        failureWindowMs,
        lockDurationMs,
      );
      return 'invalid';
    }, TRANSACTION_OPTIONS);
  }

  completeTotpChallenge(
    input: Parameters<AdminAuthRepository['completeTotpChallenge']>[0],
  ): Promise<CompleteMfaResult> {
    return this.prisma.$transaction(async (transaction) => {
      const locked = await lockAndLoadChallenge(transaction, input.challengeDigest);
      if (!locked) return { kind: 'not_found' };
      const databaseTime = await loadDatabaseClock(transaction);
      const state = classifyChallenge(locked, databaseTime, input.maxAttempts);
      if (state) return { kind: state };
      if (input.session.adminId !== locked.adminId) return { kind: 'invalid' };
      if (
        locked.admin.lastTotpTimeStep !== null &&
        BigInt(input.timeStep) <= locked.admin.lastTotpTimeStep
      ) {
        await recordMfaFailure(
          transaction,
          locked,
          databaseTime,
          input.maxAttempts,
          input.failureWindowMs,
          input.lockDurationMs,
        );
        return { kind: 'replay' };
      }
      const competing = await transaction.adminSession.findFirst({
        where: {
          adminId: locked.adminId,
          status: 'PENDING',
          pendingKind: 'MFA_TOTP',
          pendingTotpTimeStep: { gte: BigInt(input.timeStep) },
          pendingExpiresAt: { gt: databaseTime },
        },
        select: { id: true },
      });
      if (competing) return { kind: 'replay' };
      return reserveChallenge(transaction, locked, input.session, databaseTime, 'MFA_TOTP', {
        pendingTotpTimeStep: BigInt(input.timeStep),
      });
    }, TRANSACTION_OPTIONS);
  }

  completeRecoveryChallenge(
    input: Parameters<AdminAuthRepository['completeRecoveryChallenge']>[0],
  ): Promise<CompleteMfaResult> {
    return this.prisma.$transaction(async (transaction) => {
      const locked = await lockAndLoadChallenge(transaction, input.challengeDigest);
      if (!locked) return { kind: 'not_found' };
      const databaseTime = await loadDatabaseClock(transaction);
      const state = classifyChallenge(locked, databaseTime, input.maxAttempts);
      if (state) return { kind: state };
      if (input.session.adminId !== locked.adminId) return { kind: 'invalid' };
      if (locked.admin.recoveryGeneration !== input.recoveryGeneration) {
        await recordMfaFailure(
          transaction,
          locked,
          databaseTime,
          input.maxAttempts,
          input.failureWindowMs,
          input.lockDurationMs,
        );
        return { kind: 'invalid' };
      }
      const candidate = await transaction.mfaRecoveryCode.findFirst({
        where: {
          adminId: locked.adminId,
          generation: input.recoveryGeneration,
          consumedAt: null,
          AND: [
            {
              OR: input.recoveryCandidates.map((value) => ({
                pepperVersion: value.pepperVersion,
                digest: value.digest,
              })),
            },
            { OR: [{ reservedUntil: null }, { reservedUntil: { lte: databaseTime } }] },
          ],
        },
      });
      const reservedUntil = new Date(
        Math.min(locked.expiresAt.getTime(), databaseTime.getTime() + 2 * 60_000),
      );
      const consumed = candidate
        ? await transaction.mfaRecoveryCode.updateMany({
            where: {
              id: candidate.id,
              consumedAt: null,
              OR: [{ reservedUntil: null }, { reservedUntil: { lte: databaseTime } }],
            },
            data: { reservedSessionId: input.session.id, reservedUntil },
          })
        : { count: 0 };
      if (consumed.count !== 1) {
        await recordMfaFailure(
          transaction,
          locked,
          databaseTime,
          input.maxAttempts,
          input.failureWindowMs,
          input.lockDurationMs,
        );
        return { kind: 'invalid' };
      }
      if (!candidate) return { kind: 'invalid' };
      return reserveChallenge(transaction, locked, input.session, databaseTime, 'MFA_RECOVERY', {
        pendingRecoveryCodeId: candidate.id,
      });
    }, TRANSACTION_OPTIONS);
  }

  rotateSession(
    input: Parameters<AdminAuthRepository['rotateSession']>[0],
  ): Promise<RotateAdminSessionResult> {
    return this.prisma.$transaction(async (transaction) => {
      const located = await transaction.adminSession.findUnique({
        where: { refreshTokenDigest: input.presentedDigest },
        select: { id: true, adminId: true, familyId: true },
      });
      if (!located) return { kind: 'invalid' };
      await acquireLocks(transaction, [
        `iam:admin:${located.adminId}`,
        `iam:session-family:${located.familyId}`,
      ]);
      const databaseTime = await loadDatabaseClock(transaction);
      const current = await transaction.adminSession.findUnique({
        where: { refreshTokenDigest: input.presentedDigest },
        include: { admin: { select: { status: true } } },
      });
      if (
        !current ||
        current.id !== located.id ||
        current.adminId !== located.adminId ||
        current.familyId !== located.familyId
      ) {
        return { kind: 'invalid' };
      }
      if (current.status !== 'ACTIVE') return { kind: 'invalid' };
      if (current.consumedAt) {
        await revokeFamily(transaction, current.familyId, databaseTime);
        return { kind: 'reuse' };
      }
      if (current.revokedAt) return { kind: 'revoked' };
      if (current.expiresAt <= databaseTime) return { kind: 'expired' };
      if (current.admin.status !== 'ACTIVE') return { kind: 'admin_inactive' };
      const pending = await transaction.adminSession.findFirst({
        where: {
          pendingPredecessorId: current.id,
          status: 'PENDING',
          pendingExpiresAt: { gt: databaseTime },
        },
        select: { id: true },
      });
      if (pending) return { kind: 'pending' };
      const successor = await transaction.adminSession.create({
        data: {
          ...input.successor,
          adminId: current.adminId,
          familyId: current.familyId,
          deviceName: current.deviceName,
          status: 'PENDING',
          pendingKind: 'REFRESH',
          pendingPredecessorId: current.id,
          pendingExpiresAt: new Date(databaseTime.getTime() + 2 * 60_000),
        },
      });
      return { kind: 'rotated', session: mapSession(successor) };
    }, TRANSACTION_OPTIONS);
  }

  finalizeMfaSession(
    input: Parameters<AdminAuthRepository['finalizeMfaSession']>[0],
  ): Promise<AdminSessionRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      await acquireLocks(transaction, [
        `iam:admin:${input.adminId}`,
        `iam:session-family:${input.familyId}`,
        `iam:mfa:${input.challengeDigest}`,
      ]);
      if (!(await lockAdminRow(transaction, input.adminId))) return null;
      const databaseTime = await loadDatabaseClock(transaction);
      const session = await transaction.adminSession.findUnique({
          where: { id: input.sessionId },
        }),
        admin = await transaction.adminUser.findUnique({ where: { id: input.adminId } }),
        challenge = await transaction.mfaChallenge.findUnique({
          where: { challengeDigest: input.challengeDigest },
        });
      if (
        !session ||
        !admin ||
        !challenge ||
        session.adminId !== input.adminId ||
        session.familyId !== input.familyId ||
        session.status !== 'PENDING' ||
        session.pendingChallengeId !== challenge.id ||
        challenge.adminId !== session.adminId
      )
        return null;
      if (
        admin.status !== 'ACTIVE' ||
        !admin.mfaEnabled ||
        !admin.totpSecretCiphertext ||
        session.revokedAt !== null ||
        session.expiresAt <= databaseTime ||
        !session.pendingExpiresAt ||
        session.pendingExpiresAt <= databaseTime ||
        challenge.consumedAt !== null ||
        challenge.expiresAt <= databaseTime ||
        challenge.reservedSessionId !== session.id ||
        !challenge.reservedUntil ||
        challenge.reservedUntil <= databaseTime
      ) {
        await cancelPendingMfaSession(transaction, session, challenge, databaseTime);
        return null;
      }
      if (session.pendingKind === 'MFA_TOTP') {
        if (session.pendingTotpTimeStep === null) {
          await cancelPendingMfaSession(transaction, session, challenge, databaseTime);
          return null;
        }
        const updated = await transaction.adminUser.updateMany({
          where: {
            id: input.adminId,
            status: 'ACTIVE',
            mfaEnabled: true,
            OR: [
              { lastTotpTimeStep: null },
              { lastTotpTimeStep: { lt: session.pendingTotpTimeStep } },
            ],
          },
          data: {
            lastTotpTimeStep: session.pendingTotpTimeStep,
            mfaFailureCount: 0,
            mfaFailureWindowStartedAt: null,
            mfaLockedUntil: null,
          },
        });
        if (updated.count !== 1) throw stableError('MFA_FINALIZATION_CONFLICT');
      } else if (session.pendingKind === 'MFA_RECOVERY') {
        if (!session.pendingRecoveryCodeId || !admin.recoveryGeneration) {
          await cancelPendingMfaSession(transaction, session, challenge, databaseTime);
          return null;
        }
        const updated = await transaction.mfaRecoveryCode.updateMany({
          where: {
            id: session.pendingRecoveryCodeId,
            adminId: input.adminId,
            generation: admin.recoveryGeneration,
            reservedSessionId: session.id,
            reservedUntil: { gt: databaseTime },
            consumedAt: null,
          },
          data: { consumedAt: databaseTime, reservedSessionId: null, reservedUntil: null },
        });
        if (updated.count !== 1) throw stableError('MFA_FINALIZATION_CONFLICT');
        if (!(await clearAdminMfaFailures(transaction, input.adminId))) {
          throw stableError('MFA_FINALIZATION_CONFLICT');
        }
      } else {
        await cancelPendingMfaSession(transaction, session, challenge, databaseTime);
        return null;
      }
      const consumed = await transaction.mfaChallenge.updateMany({
        where: {
          id: challenge.id,
          adminId: input.adminId,
          reservedSessionId: session.id,
          reservedUntil: { gt: databaseTime },
          expiresAt: { gt: databaseTime },
          consumedAt: null,
        },
        data: { consumedAt: databaseTime, reservedSessionId: null, reservedUntil: null },
      });
      if (consumed.count !== 1) throw stableError('MFA_FINALIZATION_CONFLICT');
      const activated = await transaction.adminSession.updateMany({
        where: {
          id: session.id,
          adminId: input.adminId,
          familyId: input.familyId,
          status: 'PENDING',
          revokedAt: null,
          expiresAt: { gt: databaseTime },
          pendingExpiresAt: { gt: databaseTime },
          pendingChallengeId: challenge.id,
        },
        data: {
          status: 'ACTIVE',
          pendingKind: null,
          pendingChallengeId: null,
          pendingRecoveryCodeId: null,
          pendingTotpTimeStep: null,
          pendingPredecessorId: null,
          pendingExpiresAt: null,
        },
      });
      if (activated.count !== 1) throw stableError('MFA_FINALIZATION_CONFLICT');
      const active = await transaction.adminSession.findUnique({ where: { id: session.id } });
      if (!active) throw stableError('MFA_FINALIZATION_CONFLICT');
      return mapSession(active);
    }, TRANSACTION_OPTIONS);
  }

  releaseMfaSession(input: Parameters<AdminAuthRepository['releaseMfaSession']>[0]): Promise<void> {
    return this.prisma.$transaction(async (transaction) => {
      await acquireLocks(transaction, [
        `iam:admin:${input.adminId}`,
        `iam:session-family:${input.familyId}`,
        `iam:mfa:${input.challengeDigest}`,
      ]);
      const databaseTime = await loadDatabaseClock(transaction);
      const session = await transaction.adminSession.findUnique({ where: { id: input.sessionId } });
      if (
        !session ||
        session.status !== 'PENDING' ||
        session.adminId !== input.adminId ||
        session.familyId !== input.familyId
      )
        return;
      const challenge = await transaction.mfaChallenge.findUnique({
        where: { challengeDigest: input.challengeDigest },
      });
      await cancelPendingMfaSession(transaction, session, challenge, databaseTime);
    }, TRANSACTION_OPTIONS);
  }

  finalizeRotatedSession(
    input: Parameters<AdminAuthRepository['finalizeRotatedSession']>[0],
  ): Promise<AdminSessionRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const locatedCurrent = await transaction.adminSession.findUnique({
          where: { refreshTokenDigest: input.presentedDigest },
          select: { id: true, adminId: true, familyId: true },
        }),
        locatedSuccessor = await transaction.adminSession.findUnique({
          where: { id: input.successorId },
          select: { id: true, adminId: true, familyId: true },
        });
      if (!locatedCurrent || !locatedSuccessor) return null;
      await acquireLocks(transaction, [
        `iam:admin:${locatedCurrent.adminId}`,
        `iam:session-family:${locatedCurrent.familyId}`,
      ]);
      if (!(await lockAdminRow(transaction, locatedCurrent.adminId))) return null;
      const databaseTime = await loadDatabaseClock(transaction);
      const current = await transaction.adminSession.findUnique({
          where: { id: locatedCurrent.id },
        }),
        admin = await transaction.adminUser.findUnique({ where: { id: locatedCurrent.adminId } }),
        successor = await transaction.adminSession.findUnique({
          where: { id: locatedSuccessor.id },
        });
      if (
        !current ||
        !admin ||
        !successor ||
        current.id !== locatedCurrent.id ||
        current.adminId !== locatedCurrent.adminId ||
        current.familyId !== locatedCurrent.familyId ||
        successor.id !== locatedSuccessor.id ||
        successor.adminId !== current.adminId ||
        successor.familyId !== current.familyId ||
        successor.pendingPredecessorId !== current.id
      )
        return null;
      if (
        admin.status !== 'ACTIVE' ||
        current.status !== 'ACTIVE' ||
        current.consumedAt ||
        current.revokedAt ||
        current.expiresAt <= databaseTime ||
        successor.status !== 'PENDING' ||
        successor.pendingKind !== 'REFRESH' ||
        successor.revokedAt ||
        successor.expiresAt <= databaseTime ||
        !successor.pendingExpiresAt ||
        successor.pendingExpiresAt <= databaseTime
      ) {
        if (successor.status === 'PENDING')
          await cancelPendingRefreshSession(transaction, successor, databaseTime);
        return null;
      }
      const activeAdmin = await transaction.adminUser.updateMany({
        where: { id: current.adminId, status: 'ACTIVE' },
        data: { status: 'ACTIVE' },
      });
      if (activeAdmin.count !== 1) throw stableError('REFRESH_FINALIZATION_CONFLICT');
      const consumed = await transaction.adminSession.updateMany({
        where: {
          id: current.id,
          status: 'ACTIVE',
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: databaseTime },
        },
        data: { consumedAt: databaseTime },
      });
      if (consumed.count !== 1) throw stableError('REFRESH_FINALIZATION_CONFLICT');
      const activated = await transaction.adminSession.updateMany({
        where: {
          id: successor.id,
          adminId: current.adminId,
          familyId: current.familyId,
          status: 'PENDING',
          pendingKind: 'REFRESH',
          pendingPredecessorId: current.id,
          revokedAt: null,
          expiresAt: { gt: databaseTime },
          pendingExpiresAt: { gt: databaseTime },
        },
        data: {
          status: 'ACTIVE',
          pendingKind: null,
          pendingPredecessorId: null,
          pendingExpiresAt: null,
        },
      });
      if (activated.count !== 1) throw stableError('REFRESH_FINALIZATION_CONFLICT');
      const active = await transaction.adminSession.findUnique({ where: { id: successor.id } });
      if (!active) throw stableError('REFRESH_FINALIZATION_CONFLICT');
      return mapSession(active);
    }, TRANSACTION_OPTIONS);
  }

  releaseRotatedSession(
    input: Parameters<AdminAuthRepository['releaseRotatedSession']>[0],
  ): Promise<void> {
    return this.prisma.$transaction(async (transaction) => {
      const locatedCurrent = await transaction.adminSession.findUnique({
          where: { refreshTokenDigest: input.presentedDigest },
          select: { id: true, adminId: true, familyId: true },
        }),
        locatedSuccessor = await transaction.adminSession.findUnique({
          where: { id: input.successorId },
          select: { id: true },
        });
      if (!locatedCurrent || !locatedSuccessor) return;
      await acquireLocks(transaction, [
        `iam:admin:${locatedCurrent.adminId}`,
        `iam:session-family:${locatedCurrent.familyId}`,
      ]);
      const databaseTime = await loadDatabaseClock(transaction);
      const current = await transaction.adminSession.findUnique({ where: { id: locatedCurrent.id } }),
        successor = await transaction.adminSession.findUnique({ where: { id: locatedSuccessor.id } });
      if (!current || !successor) return;
      if (successor.status === 'PENDING' && successor.pendingPredecessorId === current.id)
        await cancelPendingRefreshSession(transaction, successor, databaseTime);
    }, TRANSACTION_OPTIONS);
  }

  revokeSessionFamily(adminId: string, familyId: string, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      void now;
      await acquireLocks(transaction, [`iam:admin:${adminId}`, `iam:session-family:${familyId}`]);
      const databaseTime = await loadDatabaseClock(transaction);
      const result = await transaction.adminSession.updateMany({
        where: { adminId, familyId, revokedAt: null },
        data: { revokedAt: databaseTime },
      });
      return result.count > 0;
    }, TRANSACTION_OPTIONS);
  }

  disableAdminAccess(
    adminId: string,
    now: Date,
  ): Promise<'disabled' | 'not_found' | 'last_super_admin'> {
    return this.prisma.$transaction(async (transaction) => {
      void now;
      await acquireLocks(transaction, [
        'iam:authorization-graph',
        'iam:super-admin',
        `iam:admin:${adminId}`,
      ]);
      if (!(await lockAdminRow(transaction, adminId))) return 'not_found' as const;
      const admin = await transaction.adminUser.findUnique({
        where: { id: adminId },
        select: { status: true },
      });
      if (!admin) return 'not_found' as const;
      const protectedAssignment = await transaction.adminRole.findFirst({
        where: { adminId, role: { protected: true } },
        select: { adminId: true },
      });
      if (admin.status === 'ACTIVE' && protectedAssignment) {
        const activeSuperAdmins = await transaction.adminUser.count({
          where: {
            status: 'ACTIVE',
            roles: { some: { role: { protected: true } } },
          },
        });
        if (activeSuperAdmins <= 1) return 'last_super_admin' as const;
      }
      const databaseTime = await loadDatabaseClock(transaction);
      await transaction.adminUser.updateMany({
        where: { id: adminId, status: 'ACTIVE' },
        data: { status: 'DISABLED' },
      });
      const pending = await transaction.adminSession.findMany({
        where: { adminId, status: 'PENDING' },
        select: { id: true },
      });
      const pendingIds = pending.map((session) => session.id);
      if (pendingIds.length > 0) {
        await transaction.mfaChallenge.updateMany({
          where: { adminId, reservedSessionId: { in: pendingIds }, consumedAt: null },
          data: { reservedSessionId: null, reservedUntil: null },
        });
        await transaction.mfaRecoveryCode.updateMany({
          where: { adminId, reservedSessionId: { in: pendingIds }, consumedAt: null },
          data: { reservedSessionId: null, reservedUntil: null },
        });
        await transaction.adminSession.updateMany({
          where: { adminId, id: { in: pendingIds }, status: 'PENDING' },
          data: {
            status: 'CANCELLED',
            revokedAt: databaseTime,
            pendingKind: null,
            pendingChallengeId: null,
            pendingRecoveryCodeId: null,
            pendingTotpTimeStep: null,
            pendingPredecessorId: null,
            pendingExpiresAt: null,
          },
        });
      }
      await transaction.adminSession.updateMany({
        where: { adminId, status: 'ACTIVE', revokedAt: null },
        data: { revokedAt: databaseTime },
      });
      return 'disabled' as const;
    }, TRANSACTION_OPTIONS);
  }

  async cleanupExpiredPendingSessions(_now: Date, limit = 100): Promise<number> {
    const boundedLimit = normalizeCleanupLimit(limit);
    const candidates = await this.prisma.$transaction(async (transaction) => {
      const databaseTime = await loadDatabaseClock(transaction);
      return transaction.adminSession.findMany({
        where: { status: 'PENDING', pendingExpiresAt: { lte: databaseTime } },
        orderBy: [{ pendingExpiresAt: 'asc' }, { id: 'asc' }],
        take: boundedLimit,
        select: { id: true },
      });
    }, TRANSACTION_OPTIONS);
    let cleaned = 0;
    for (const candidate of candidates) {
      const removed = await this.prisma.$transaction(async (transaction) => {
        const located = await transaction.adminSession.findUnique({
          where: { id: candidate.id },
          select: {
            id: true,
            adminId: true,
            familyId: true,
            pendingChallengeId: true,
          },
        });
        if (!located) return false;
        const challenge = located.pendingChallengeId
          ? await transaction.mfaChallenge.findUnique({
              where: { id: located.pendingChallengeId },
              select: { challengeDigest: true },
            })
          : null;
        await acquireLocks(transaction, [
          `iam:admin:${located.adminId}`,
          `iam:session-family:${located.familyId}`,
          ...(challenge ? [`iam:mfa:${challenge.challengeDigest}`] : []),
        ]);
        if (!(await lockAdminRow(transaction, located.adminId))) return false;
        const databaseTime = await loadDatabaseClock(transaction);
        const session = await transaction.adminSession.findUnique({ where: { id: candidate.id } });
        if (
          !session ||
          session.status !== 'PENDING' ||
          !session.pendingExpiresAt ||
          session.pendingExpiresAt > databaseTime
        )
          return false;
        const lockedChallenge = session.pendingChallengeId
          ? await transaction.mfaChallenge.findUnique({ where: { id: session.pendingChallengeId } })
          : null;
        return session.pendingKind === 'REFRESH'
          ? cancelPendingRefreshSession(transaction, session, databaseTime)
          : cancelPendingMfaSession(transaction, session, lockedChallenge, databaseTime);
      }, TRANSACTION_OPTIONS);
      if (removed) cleaned += 1;
    }
    return cleaned;
  }
}

async function lockAdminRow(transaction: TransactionClient, adminId: string): Promise<boolean> {
  const rows = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id"::text AS "id"
    FROM "admin_users"
    WHERE "id" = CAST(${adminId} AS uuid)
    FOR UPDATE
  `);
  return rows.length === 1;
}

async function loadDatabaseClock(transaction: TransactionClient): Promise<Date> {
  const rows = await transaction.$queryRaw<{ now: Date }[]>(Prisma.sql`
    SELECT clock_timestamp() AS "now"
  `);
  const now = rows[0]?.now;
  if (!now) throw stableError('DATABASE_CLOCK_UNAVAILABLE');
  return now;
}

async function cancelPendingMfaSession(
  transaction: TransactionClient,
  session: AdminSession,
  challenge: MfaChallenge | null,
  now: Date,
): Promise<boolean> {
  if (challenge)
    await transaction.mfaChallenge.updateMany({
      where: { id: challenge.id, reservedSessionId: session.id, consumedAt: null },
      data: { reservedSessionId: null, reservedUntil: null },
    });
  if (session.pendingRecoveryCodeId)
    await transaction.mfaRecoveryCode.updateMany({
      where: {
        id: session.pendingRecoveryCodeId,
        reservedSessionId: session.id,
        consumedAt: null,
      },
      data: { reservedSessionId: null, reservedUntil: null },
    });
  const cancelled = await transaction.adminSession.updateMany({
    where: { id: session.id, status: 'PENDING' },
    data: {
      status: 'CANCELLED',
      revokedAt: session.revokedAt ?? now,
      pendingKind: null,
      pendingChallengeId: null,
      pendingRecoveryCodeId: null,
      pendingTotpTimeStep: null,
      pendingPredecessorId: null,
      pendingExpiresAt: null,
    },
  });
  return cancelled.count === 1;
}

async function cancelPendingRefreshSession(
  transaction: TransactionClient,
  session: AdminSession,
  now: Date,
): Promise<boolean> {
  const cancelled = await transaction.adminSession.updateMany({
    where: { id: session.id, status: 'PENDING' },
    data: {
      status: 'CANCELLED',
      revokedAt: session.revokedAt ?? now,
      pendingKind: null,
      pendingPredecessorId: null,
      pendingExpiresAt: null,
    },
  });
  return cancelled.count === 1;
}

async function clearAdminMfaFailures(
  transaction: TransactionClient,
  adminId: string,
): Promise<boolean> {
  const updated = await transaction.adminUser.updateMany({
    where: { id: adminId, status: 'ACTIVE' },
    data: { mfaFailureCount: 0, mfaFailureWindowStartedAt: null, mfaLockedUntil: null },
  });
  return updated.count === 1;
}

function normalizeCleanupLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw stableError('INVALID_PENDING_CLEANUP_LIMIT');
  }
  return limit;
}

async function lockAndLoadChallenge(transaction: TransactionClient, digest: string) {
  const located = await transaction.mfaChallenge.findUnique({
    where: { challengeDigest: digest },
    select: { adminId: true },
  });
  if (!located) return null;
  await acquireLocks(transaction, [`iam:admin:${located.adminId}`, `iam:mfa:${digest}`]);
  return transaction.mfaChallenge.findUnique({
    where: { challengeDigest: digest },
    include: { admin: true },
  });
}

function classifyChallenge(
  challenge: Awaited<ReturnType<typeof lockAndLoadChallenge>> & {},
  now: Date,
  maxAttempts: number,
): MfaChallengeState | null {
  if (challenge.consumedAt) return 'used';
  if (challenge.reservedUntil && challenge.reservedUntil > now) return 'locked';
  if (challenge.expiresAt <= now) return 'expired';
  if (challenge.admin.mfaLockedUntil && challenge.admin.mfaLockedUntil > now) return 'locked';
  if (challenge.attempts >= maxAttempts) return 'locked';
  if (
    challenge.admin.status !== 'ACTIVE' ||
    !challenge.admin.mfaEnabled ||
    !challenge.admin.totpSecretCiphertext ||
    !challenge.admin.recoveryGeneration
  ) {
    return 'inactive';
  }
  return null;
}

async function reserveChallenge(
  transaction: TransactionClient,
  challenge: { readonly id: string; readonly adminId: string; readonly expiresAt: Date },
  input: CreateAdminSessionInput,
  now: Date,
  kind: 'MFA_TOTP' | 'MFA_RECOVERY',
  pending: { readonly pendingTotpTimeStep?: bigint; readonly pendingRecoveryCodeId?: string },
): Promise<CompleteMfaResult> {
  if (input.adminId !== challenge.adminId) return { kind: 'invalid' };
  const pendingExpiresAt = new Date(
    Math.min(challenge.expiresAt.getTime(), now.getTime() + 2 * 60_000),
  );
  const consumed = await transaction.mfaChallenge.updateMany({
    where: {
      id: challenge.id,
      consumedAt: null,
      OR: [{ reservedUntil: null }, { reservedUntil: { lte: now } }],
    },
    data: { reservedSessionId: input.id, reservedUntil: pendingExpiresAt },
  });
  if (consumed.count !== 1) throw stableError('MFA_RESERVATION_CONFLICT');
  const session = await transaction.adminSession.create({
    data: {
      ...input,
      status: 'PENDING',
      pendingKind: kind,
      pendingChallengeId: challenge.id,
      pendingExpiresAt,
      ...pending,
    },
  });
  return { kind: 'authenticated', session: mapSession(session) };
}

async function recordMfaFailure(
  transaction: TransactionClient,
  locked: Awaited<ReturnType<typeof lockAndLoadChallenge>> & {},
  now: Date,
  maxAttempts: number,
  failureWindowMs: number,
  lockDurationMs: number,
): Promise<void> {
  const windowExpired =
    !locked.admin.mfaFailureWindowStartedAt ||
    locked.admin.mfaFailureWindowStartedAt.getTime() <= now.getTime() - failureWindowMs;
  const failureCount = windowExpired ? 1 : locked.admin.mfaFailureCount + 1;
  await transaction.mfaChallenge.update({
    where: { id: locked.id },
    data: { attempts: { increment: 1 } },
  });
  await transaction.adminUser.update({
    where: { id: locked.adminId },
    data: {
      mfaFailureCount: failureCount,
      ...(windowExpired ? { mfaFailureWindowStartedAt: now } : {}),
      ...(failureCount >= maxAttempts
        ? { mfaLockedUntil: new Date(now.getTime() + lockDurationMs) }
        : {}),
    },
  });
}

async function revokeFamily(
  transaction: TransactionClient,
  familyId: string,
  now: Date,
): Promise<void> {
  await transaction.adminSession.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: now },
  });
}

async function acquireLocks(
  transaction: TransactionClient,
  keys: readonly string[],
): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await transaction.$queryRaw(
      Prisma.sql`
        SELECT 1::integer AS "acquired"
        FROM (
          SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
        ) AS "held_lock"
      `,
    );
  }
}

function mapAdmin(admin: AdminUser): AdminAccountRecord {
  return {
    id: admin.id,
    email: admin.email,
    passwordHash: admin.passwordHash,
    status: admin.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED',
    mfaEnabled: admin.mfaEnabled,
    pendingTotpSecretCiphertext: admin.pendingTotpSecretCiphertext,
    totpSecretCiphertext: admin.totpSecretCiphertext,
    lastTotpTimeStep: admin.lastTotpTimeStep === null ? null : Number(admin.lastTotpTimeStep),
    recoveryGeneration: admin.recoveryGeneration,
    mfaFailureCount: admin.mfaFailureCount,
    mfaFailureWindowStartedAt: admin.mfaFailureWindowStartedAt,
    mfaLockedUntil: admin.mfaLockedUntil,
  };
}

function mapChallenge(challenge: MfaChallenge) {
  return {
    id: challenge.id,
    adminId: challenge.adminId,
    challengeDigest: challenge.challengeDigest,
    expiresAt: challenge.expiresAt,
    attempts: challenge.attempts,
    consumedAt: challenge.consumedAt,
    createdAt: challenge.createdAt,
  };
}

function mapSession(session: AdminSession): AdminSessionRecord {
  return {
    id: session.id,
    adminId: session.adminId,
    familyId: session.familyId,
    refreshTokenDigest: session.refreshTokenDigest,
    deviceName: session.deviceName,
    expiresAt: session.expiresAt,
    consumedAt: session.consumedAt,
    revokedAt: session.revokedAt,
    createdAt: session.createdAt,
    status:
      session.status === 'ACTIVE'
        ? 'ACTIVE'
        : session.status === 'PENDING'
          ? 'PENDING'
          : 'CANCELLED',
    pendingExpiresAt: session.pendingExpiresAt,
    pendingKind:
      session.pendingKind === 'MFA_TOTP' ||
      session.pendingKind === 'MFA_RECOVERY' ||
      session.pendingKind === 'REFRESH'
        ? session.pendingKind
        : null,
    pendingChallengeId: session.pendingChallengeId,
    pendingRecoveryCodeId: session.pendingRecoveryCodeId,
    pendingTotpTimeStep:
      session.pendingTotpTimeStep === null ? null : Number(session.pendingTotpTimeStep),
    pendingPredecessorId: session.pendingPredecessorId,
  };
}

function stableError(code:string):Error&{code:string}{return Object.assign(new Error(code),{code});}
