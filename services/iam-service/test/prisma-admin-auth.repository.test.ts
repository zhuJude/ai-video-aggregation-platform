import { describe, expect, it, vi } from 'vitest';

import { PrismaAdminAuthRepository } from '../src/adapters/prisma-admin-auth.repository.js';

const admin = {
  id: '0198fabc-1234-7abc-8abc-000000000201',
  email: 'ops@example.com',
  passwordHash: 'password-digest',
  status: 'ACTIVE',
  mfaEnabled: true,
  pendingTotpSecretCiphertext: 'pending',
  totpSecretCiphertext: 'encrypted-secret',
  lastTotpTimeStep: 12n,
  recoveryGeneration: '0198fabc-1234-7abc-8abc-000000000202',
  mfaFailureCount: 0,
  mfaFailureWindowStartedAt: null,
  mfaLockedUntil: null,
  createdAt: new Date('2026-09-01T08:00:00Z'),
  updatedAt: new Date('2026-09-01T08:00:00Z'),
};
const challenge = {
  id: '0198fabc-1234-7abc-8abc-000000000203',
  adminId: admin.id,
  challengeDigest: 'a'.repeat(64),
  expiresAt: new Date('2026-09-01T08:05:00Z'),
  attempts: 0,
  consumedAt: null,
  createdAt: new Date('2026-09-01T08:00:00Z'),
  admin,
};
const sessionInput = {
  id: '0198fabc-1234-7abc-8abc-000000000204',
  adminId: admin.id,
  familyId: '0198fabc-1234-7abc-8abc-000000000205',
  refreshTokenDigest: 'b'.repeat(64),
  deviceName: 'Chrome',
  expiresAt: new Date('2026-10-01T08:01:00Z'),
  createdAt: new Date('2026-09-01T08:01:00Z'),
};
const session = {
  ...sessionInput,
  consumedAt: null,
  revokedAt: null,
  status: 'ACTIVE',
  pendingKind: null,
  pendingChallengeId: null,
  pendingRecoveryCodeId: null,
  pendingTotpTimeStep: null,
  pendingPredecessorId: null,
  pendingExpiresAt: null,
};

function fakePrisma() {
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([{ now: new Date('2026-09-01T08:02:00Z') }]),
    adminUser: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue(admin),
      count: vi.fn().mockResolvedValue(1),
    },
    mfaRecoveryCode: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      createMany: vi.fn().mockResolvedValue({ count: 10 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue({ id: '0198fabc-1234-7abc-8abc-000000000206' }),
    },
    mfaChallenge: {
      create: vi.fn().mockResolvedValue(challenge),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue(challenge),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    adminSession: {
      findUnique: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(session),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue(session),
    },
  };
  const prisma = {
    ...transaction,
    $transaction: vi.fn((operation: (tx: typeof transaction) => unknown) =>
      Promise.resolve(operation(transaction)),
    ),
  };
  return { prisma, transaction };
}

describe('PrismaAdminAuthRepository transactional contract', () => {
  it('maps administrators and persists enrollment and password changes', async () => {
    const { prisma, transaction } = fakePrisma();
    transaction.adminUser.findUnique.mockResolvedValue(admin);
    const repository = new PrismaAdminAuthRepository(prisma as never);

    await expect(repository.findAdminByEmail(admin.email)).resolves.toMatchObject({
      id: admin.id,
      lastTotpTimeStep: 12,
    });
    await expect(repository.findAdminById(admin.id)).resolves.toMatchObject({ id: admin.id });
    await repository.updatePasswordHash(admin.id, 'new-digest');
    await expect(repository.savePendingTotpSecret(admin.id, 'pending')).resolves.toBe(true);
    await expect(
      repository.confirmMfaEnrollment({
        adminId: admin.id,
        expectedPendingCiphertext: 'pending',
        timeStep: 13,
        recoveryGeneration: admin.recoveryGeneration,
        recoveryCodes: [
          {
            id: '0198fabc-1234-7abc-8abc-000000000206',
            digest: 'c'.repeat(64),
            pepperVersion: 'legacy-v1',
          },
        ],
        now: new Date('2026-09-01T08:01:00Z'),
      }),
    ).resolves.toBe('confirmed');
    expect(transaction.mfaRecoveryCode.createMany).toHaveBeenCalledOnce();
  });

  it('atomically regenerates recovery codes and creates challenge digests for active MFA admins', async () => {
    const { prisma, transaction } = fakePrisma();
    transaction.adminUser.findUnique.mockResolvedValue(admin);
    transaction.mfaChallenge.findUnique.mockResolvedValue(challenge);
    const repository = new PrismaAdminAuthRepository(prisma as never);
    const now = new Date('2026-09-01T08:01:00Z');

    await expect(
      repository.replaceRecoveryCodes({
        adminId: admin.id,
        timeStep: 13,
        recoveryGeneration: '0198fabc-1234-7abc-8abc-000000000207',
        recoveryCodes: [
          {
            id: '0198fabc-1234-7abc-8abc-000000000208',
            digest: 'd'.repeat(64),
            pepperVersion: 'legacy-v1',
          },
        ],
        now,
      }),
    ).resolves.toBe('replaced');
    await expect(
      repository.createMfaChallenge({
        id: challenge.id,
        adminId: admin.id,
        challengeDigest: challenge.challengeDigest,
        expiresAt: challenge.expiresAt,
        createdAt: challenge.createdAt,
      }),
    ).resolves.toBe('created');
    await expect(repository.getMfaChallenge(challenge.challengeDigest)).resolves.toMatchObject({
      admin: { id: admin.id },
      challenge: { challengeDigest: challenge.challengeDigest },
    });
  });

  it('locks challenge and administrator state while counting failures and completing TOTP', async () => {
    const failure = fakePrisma();
    failure.transaction.mfaChallenge.findUnique
      .mockResolvedValueOnce({ adminId: admin.id })
      .mockResolvedValueOnce(challenge);
    const failureRepository = new PrismaAdminAuthRepository(failure.prisma as never);
    await expect(
      failureRepository.recordInvalidMfaAttempt(
        challenge.challengeDigest,
        new Date('2026-09-01T08:01:00Z'),
        5,
        15 * 60_000,
        15 * 60_000,
      ),
    ).resolves.toBe('invalid');
    expect(failure.transaction.mfaChallenge.update).toHaveBeenCalledOnce();

    const success = fakePrisma();
    success.transaction.mfaChallenge.findUnique
      .mockResolvedValueOnce({ adminId: admin.id })
      .mockResolvedValueOnce(challenge);
    const successRepository = new PrismaAdminAuthRepository(success.prisma as never);
    await expect(
      successRepository.completeTotpChallenge({
        challengeDigest: challenge.challengeDigest,
        now: new Date('2026-09-01T08:01:00Z'),
        maxAttempts: 5,
        failureWindowMs: 15 * 60_000,
        lockDurationMs: 15 * 60_000,
        timeStep: 13,
        session: sessionInput,
      }),
    ).resolves.toMatchObject({ kind: 'authenticated', session: { id: session.id } });
    expect(success.transaction.adminUser.update).not.toHaveBeenCalled();
    expect(success.transaction.mfaChallenge.updateMany).toHaveBeenCalledOnce();
  });

  it('consumes recovery codes and rotates refresh sessions with family locks', async () => {
    const recovery = fakePrisma();
    recovery.transaction.mfaChallenge.findUnique
      .mockResolvedValueOnce({ adminId: admin.id })
      .mockResolvedValueOnce(challenge);
    const recoveryRepository = new PrismaAdminAuthRepository(recovery.prisma as never);
    await expect(
      recoveryRepository.completeRecoveryChallenge({
        challengeDigest: challenge.challengeDigest,
        now: new Date('2026-09-01T08:01:00Z'),
        maxAttempts: 5,
        failureWindowMs: 15 * 60_000,
        lockDurationMs: 15 * 60_000,
        recoveryGeneration: admin.recoveryGeneration,
        recoveryCandidates: [{ pepperVersion: 'legacy-v1', digest: 'e'.repeat(64) }],
        session: sessionInput,
      }),
    ).resolves.toMatchObject({ kind: 'authenticated' });
    expect(recovery.transaction.mfaRecoveryCode.updateMany).toHaveBeenCalledOnce();

    const rotation = fakePrisma();
    rotation.transaction.adminSession.findUnique
      .mockResolvedValueOnce({ id: session.id, adminId: admin.id, familyId: session.familyId })
      .mockResolvedValueOnce({ ...session, admin: { status: 'ACTIVE' } });
    const rotationRepository = new PrismaAdminAuthRepository(rotation.prisma as never);
    await expect(
      rotationRepository.rotateSession({
        presentedDigest: session.refreshTokenDigest,
        now: new Date('2026-09-01T08:02:00Z'),
        successor: {
          id: '0198fabc-1234-7abc-8abc-000000000209',
          refreshTokenDigest: 'f'.repeat(64),
          createdAt: new Date('2026-09-01T08:02:00Z'),
          expiresAt: new Date('2026-10-01T08:02:00Z'),
        },
      }),
    ).resolves.toMatchObject({ kind: 'rotated' });
    expect(rotation.transaction.adminSession.update).not.toHaveBeenCalled();
    expect(rotation.transaction.adminSession.create).toHaveBeenCalledOnce();
    await expect(
      rotationRepository.revokeSessionFamily(
        admin.id,
        session.familyId,
        new Date('2026-09-01T08:03:00Z'),
      ),
    ).resolves.toBe(true);
    expect(rotation.transaction.$queryRaw).toHaveBeenCalledTimes(6);
    expect(rotation.transaction.adminSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { adminId: admin.id, familyId: session.familyId, revokedAt: null },
      }),
    );
  });

  it('does not mutate MFA state when a session belongs to another administrator', async () => {
    const recoveryMismatch = fakePrisma();
    recoveryMismatch.transaction.mfaChallenge.findUnique
      .mockResolvedValueOnce({ adminId: admin.id })
      .mockResolvedValueOnce(challenge);
    const recoveryRepository = new PrismaAdminAuthRepository(recoveryMismatch.prisma as never);
    const otherAdminSession = {
      ...sessionInput,
      adminId: '0198fabc-1234-7abc-8abc-000000000299',
    };

    await expect(
      recoveryRepository.completeRecoveryChallenge({
        challengeDigest: challenge.challengeDigest,
        now: new Date('2026-09-01T08:01:00Z'),
        maxAttempts: 5,
        failureWindowMs: 15 * 60_000,
        lockDurationMs: 15 * 60_000,
        recoveryGeneration: admin.recoveryGeneration,
        recoveryCandidates: [{ pepperVersion: 'legacy-v1', digest: 'e'.repeat(64) }],
        session: otherAdminSession,
      }),
    ).resolves.toEqual({ kind: 'invalid' });
    expect(recoveryMismatch.transaction.mfaRecoveryCode.updateMany).not.toHaveBeenCalled();

    const totpMismatch = fakePrisma();
    totpMismatch.transaction.mfaChallenge.findUnique
      .mockResolvedValueOnce({ adminId: admin.id })
      .mockResolvedValueOnce(challenge);
    const totpRepository = new PrismaAdminAuthRepository(totpMismatch.prisma as never);

    await expect(
      totpRepository.completeTotpChallenge({
        challengeDigest: challenge.challengeDigest,
        now: new Date('2026-09-01T08:01:00Z'),
        maxAttempts: 5,
        failureWindowMs: 15 * 60_000,
        lockDurationMs: 15 * 60_000,
        timeStep: 13,
        session: otherAdminSession,
      }),
    ).resolves.toEqual({ kind: 'invalid' });
    expect(totpMismatch.transaction.adminUser.update).not.toHaveBeenCalled();
  });

  it('finalizes and releases only locked PENDING MFA and refresh sessions', async () => {
    const pendingMfa = {
      ...session,
      admin,
      status: 'PENDING',
      pendingKind: 'MFA_TOTP',
      pendingChallengeId: challenge.id,
      pendingTotpTimeStep: 13n,
      pendingExpiresAt: new Date('2026-09-01T08:04:00Z'),
    };
    const mfa = fakePrisma();
    mfa.transaction.adminUser.findUnique.mockResolvedValue(admin);
    mfa.transaction.adminSession.findUnique
      .mockResolvedValueOnce(pendingMfa)
      .mockResolvedValueOnce({ ...pendingMfa, status: 'ACTIVE' })
      .mockResolvedValueOnce(pendingMfa);
    mfa.transaction.mfaChallenge.findUnique.mockResolvedValue({
      ...challenge,
      reservedSessionId: session.id,
      reservedUntil: new Date('2026-09-01T08:04:00Z'),
    });
    mfa.transaction.adminSession.update.mockResolvedValue({
      ...pendingMfa,
      status: 'ACTIVE',
      pendingKind: null,
      pendingExpiresAt: null,
    });
    const repository = new PrismaAdminAuthRepository(mfa.prisma as never);
    await expect(
      repository.finalizeMfaSession({
        adminId: admin.id,
        sessionId: session.id,
        familyId: session.familyId,
        challengeDigest: challenge.challengeDigest,
        now: new Date('2026-09-01T08:02:00Z'),
      }),
    ).resolves.toMatchObject({ status: 'ACTIVE' });
    expect(mfa.transaction.adminUser.updateMany).toHaveBeenCalledOnce();
    await repository.releaseMfaSession({
      adminId: admin.id,
      sessionId: session.id,
      familyId: session.familyId,
      challengeDigest: challenge.challengeDigest,
      now: new Date('2026-09-01T08:02:00Z'),
    });
    expect(mfa.transaction.adminSession.updateMany).toHaveBeenCalledTimes(2);

    const refresh = fakePrisma();
    refresh.transaction.adminUser.findUnique.mockResolvedValue(admin);
    const current = { ...session, status: 'ACTIVE', admin: { status: 'ACTIVE' } },
      successor = {
        ...session,
        id: '0198fabc-1234-7abc-8abc-000000000209',
        status: 'PENDING',
        pendingKind: 'REFRESH',
        pendingPredecessorId: session.id,
        pendingExpiresAt: new Date('2026-09-01T08:04:00Z'),
      };
    refresh.transaction.adminSession.findUnique
      .mockResolvedValueOnce({ id: current.id, adminId: current.adminId, familyId: current.familyId })
      .mockResolvedValueOnce({
        id: successor.id,
        adminId: successor.adminId,
        familyId: successor.familyId,
      })
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(successor)
      .mockResolvedValueOnce(successor);
    refresh.transaction.adminSession.update.mockResolvedValue(successor);
    const refreshRepository = new PrismaAdminAuthRepository(refresh.prisma as never);
    await expect(
      refreshRepository.finalizeRotatedSession({
        presentedDigest: session.refreshTokenDigest,
        successorId: successor.id,
        now: new Date('2026-09-01T08:02:00Z'),
      }),
    ).resolves.toMatchObject({ id: successor.id });
    const release = fakePrisma();
    release.transaction.adminSession.findUnique
      .mockResolvedValueOnce({ id: current.id, adminId: current.adminId, familyId: current.familyId })
      .mockResolvedValueOnce({ id: successor.id })
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(successor);
    const releaseRepository = new PrismaAdminAuthRepository(release.prisma as never);
    await releaseRepository.releaseRotatedSession({
      presentedDigest: session.refreshTokenDigest,
      successorId: successor.id,
      now: new Date('2026-09-01T08:02:00Z'),
    });
    expect(release.transaction.adminSession.updateMany).toHaveBeenCalledOnce();
  });

  it('atomically disables an administrator and revokes only that administrator sessions', async () => {
    const disabled = fakePrisma();
    disabled.transaction.adminSession.findMany.mockResolvedValue([
      { id: '0198fabc-1234-7abc-8abc-000000000210' },
    ]);
    const repository = new PrismaAdminAuthRepository(disabled.prisma as never);

    await expect(
      repository.disableAdminAccess(admin.id, new Date('1900-01-01T00:00:00Z')),
    ).resolves.toBe('disabled');

    expect(disabled.transaction.adminUser.updateMany).toHaveBeenCalledWith({
      where: { id: admin.id, status: 'ACTIVE' },
      data: { status: 'DISABLED' },
    });
    expect(disabled.transaction.mfaChallenge.updateMany).toHaveBeenCalledWith({
      where: {
        adminId: admin.id,
        reservedSessionId: { in: ['0198fabc-1234-7abc-8abc-000000000210'] },
        consumedAt: null,
      },
      data: { reservedSessionId: null, reservedUntil: null },
    });
    expect(disabled.transaction.adminSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { adminId: admin.id, status: 'ACTIVE', revokedAt: null } }),
    );
  });

  it('cleans a bounded exact expired PENDING refresh session using the database clock', async () => {
    const cleanup = fakePrisma();
    const expired = {
      ...session,
      id: '0198fabc-1234-7abc-8abc-000000000211',
      status: 'PENDING',
      pendingKind: 'REFRESH',
      pendingPredecessorId: session.id,
      pendingExpiresAt: new Date('2026-09-01T08:01:00Z'),
    };
    cleanup.transaction.adminSession.findMany.mockResolvedValue([{ id: expired.id }]);
    cleanup.transaction.adminSession.findUnique
      .mockResolvedValueOnce({
        id: expired.id,
        adminId: expired.adminId,
        familyId: expired.familyId,
        pendingChallengeId: null,
      })
      .mockResolvedValueOnce(expired);
    const repository = new PrismaAdminAuthRepository(cleanup.prisma as never);

    await expect(
      repository.cleanupExpiredPendingSessions(new Date('2099-01-01T00:00:00Z'), 1),
    ).resolves.toBe(1);

    expect(cleanup.transaction.adminSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1 }),
    );
    expect(cleanup.transaction.adminSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: expired.id, status: 'PENDING' } }),
    );
    expect(cleanup.transaction.mfaChallenge.updateMany).not.toHaveBeenCalled();
  });
});
