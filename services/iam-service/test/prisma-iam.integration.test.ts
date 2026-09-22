import { randomBytes } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PrismaAdminAuthRepository } from '../src/adapters/prisma-admin-auth.repository.js';
import { generateUuidV7 } from '../src/domain/uuid-v7.js';
import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import { resolveIamTestDatabaseUrl } from './test-targets.js';

const testDatabaseUrl = resolveIamTestDatabaseUrl({
  IAM_TEST_DATABASE_URL: process.env['IAM_TEST_DATABASE_URL'],
});
const integration = testDatabaseUrl ? it : it.skip;
const fixtureAdminIds = new Set<string>();
const fixtureChallengeIds = new Set<string>();
const fixtureSessionIds = new Set<string>();
const fixtureRecoveryIds = new Set<string>();
const sentinelAdminId = generateUuidV7();
const sentinelEmail = `iam-integration-sentinel-${sentinelAdminId}@example.test`;
let prisma: PrismaClient | null = null;

describe('PrismaAdminAuthRepository integration', () => {
  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl }) });
    await prisma.adminUser.upsert({
      where: { id: sentinelAdminId },
      create: {
        id: sentinelAdminId,
        email: sentinelEmail,
        passwordHash: '$argon2id$v=19$m=65536,p=1,t=3$sentinel$sentinel',
      },
      update: {},
    });
  });

  afterEach(async () => {
    if (!prisma) return;
    await cleanupFixtures(prisma);
    await expect(prisma.adminUser.count({ where: { id: sentinelAdminId } })).resolves.toBe(1);
  });

  afterAll(async () => {
    if (!prisma) return;
    await cleanupFixtures(prisma);
    await expect(prisma.adminUser.count({ where: { id: sentinelAdminId } })).resolves.toBe(1);
    await prisma.adminUser.delete({ where: { id: sentinelAdminId } });
    await prisma.$disconnect();
  });

  integration(
    'executes advisory-locked MFA and concurrent refresh-family reuse without touching sentinel data',
    async () => {
      const client = requirePrisma();
      const repository = new PrismaAdminAuthRepository(client);
      const base = await databaseNow(client);
      const adminId = register(fixtureAdminIds, generateUuidV7());
      const recoveryGeneration = generateUuidV7();
      await client.adminUser.create({
        data: {
          id: adminId,
          email: `iam-refresh-${adminId}@example.test`,
          passwordHash: '$argon2id$v=19$m=65536,p=1,t=3$placeholder$placeholder',
          status: 'ACTIVE',
          mfaEnabled: true,
          totpSecretCiphertext: 'ciphertext',
          recoveryGeneration,
        },
      });
      const challengeId = register(fixtureChallengeIds, generateUuidV7());
      const challengeDigest = uniqueDigest();
      const sessionId = register(fixtureSessionIds, generateUuidV7());
      const familyId = generateUuidV7();
      const presentedDigest = uniqueDigest();
      const firstSuccessorId = register(fixtureSessionIds, generateUuidV7());
      const secondSuccessorId = register(fixtureSessionIds, generateUuidV7());
      const finalSuccessorId = register(fixtureSessionIds, generateUuidV7());
      const firstSuccessorDigest = uniqueDigest();
      const secondSuccessorDigest = uniqueDigest();
      await repository.createMfaChallenge({
        id: challengeId,
        adminId,
        challengeDigest,
        createdAt: at(base, 0),
        expiresAt: at(base, 5 * 60_000),
      });
      const completed = await repository.completeTotpChallenge({
        challengeDigest,
        now: at(base, 1_000),
        maxAttempts: 5,
        failureWindowMs: 15 * 60_000,
        lockDurationMs: 15 * 60_000,
        timeStep: 1,
        session: {
          id: sessionId,
          adminId,
          familyId,
          refreshTokenDigest: presentedDigest,
          deviceName: 'Integration',
          createdAt: at(base, 1_000),
          expiresAt: at(base, 30 * 24 * 60 * 60_000),
        },
      });
      expect(completed.kind).toBe('authenticated');
      await expect(
        repository.finalizeMfaSession({
          adminId,
          sessionId,
          familyId,
          challengeDigest,
          now: at(base, 2_000),
        }),
      ).resolves.toMatchObject({ status: 'ACTIVE' });
      const competingRotations = await Promise.all([
        repository.rotateSession({
          presentedDigest,
          now: at(base, 3_000),
          successor: {
            id: firstSuccessorId,
            refreshTokenDigest: firstSuccessorDigest,
            createdAt: at(base, 3_000),
            expiresAt: at(base, 30 * 24 * 60 * 60_000),
          },
        }),
        repository.rotateSession({
          presentedDigest,
          now: at(base, 3_000),
          successor: {
            id: secondSuccessorId,
            refreshTokenDigest: secondSuccessorDigest,
            createdAt: at(base, 3_000),
            expiresAt: at(base, 30 * 24 * 60 * 60_000),
          },
        }),
      ]);
      expect(competingRotations.map((result) => result.kind).sort()).toEqual([
        'pending',
        'rotated',
      ]);
      const winner = competingRotations.find((result) => result.kind === 'rotated');
      if (!winner) throw new Error('EXPECTED_ROTATION_WINNER');
      await expect(
        repository.finalizeRotatedSession({
          presentedDigest,
          successorId: winner.session.id,
          now: at(base, 4_000),
        }),
      ).resolves.toMatchObject({ status: 'ACTIVE' });
      await expect(
        repository.rotateSession({
          presentedDigest,
          now: at(base, 5_000),
          successor: {
            id: register(fixtureSessionIds, generateUuidV7()),
            refreshTokenDigest: uniqueDigest(),
            createdAt: at(base, 5_000),
            expiresAt: at(base, 30 * 24 * 60 * 60_000),
          },
        }),
      ).resolves.toMatchObject({ kind: 'reuse' });
      await expect(
        repository.rotateSession({
          presentedDigest: winner.session.refreshTokenDigest,
          now: at(base, 6_000),
          successor: {
            id: finalSuccessorId,
            refreshTokenDigest: uniqueDigest(),
            createdAt: at(base, 6_000),
            expiresAt: at(base, 30 * 24 * 60 * 60_000),
          },
        }),
      ).resolves.toMatchObject({ kind: 'revoked' });
    },
  );

  integration('serializes an administrator-wide budget across unique challenges', async () => {
    const client = requirePrisma();
    const repository = new PrismaAdminAuthRepository(client);
    const adminId = register(fixtureAdminIds, generateUuidV7());
    await client.adminUser.create({
      data: {
        id: adminId,
        email: `iam-budget-${adminId}@example.test`,
        passwordHash: '$argon2id$v=19$m=65536,p=1,t=3$placeholder$placeholder',
        status: 'ACTIVE',
        mfaEnabled: true,
        totpSecretCiphertext: 'ciphertext',
        recoveryGeneration: generateUuidV7(),
      },
    });
    const now = await databaseNow(client);
    const challenges = [
      { id: register(fixtureChallengeIds, generateUuidV7()), digest: uniqueDigest() },
      { id: register(fixtureChallengeIds, generateUuidV7()), digest: uniqueDigest() },
    ] as const;
    await Promise.all(
      challenges.map((challenge) =>
        repository.createMfaChallenge({
          id: challenge.id,
          adminId,
          challengeDigest: challenge.digest,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 5 * 60_000),
        }),
      ),
    );

    await expect(
      Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          repository.recordInvalidMfaAttempt(
            index % 2 === 0 ? challenges[0].digest : challenges[1].digest,
            now,
            5,
            15 * 60_000,
            15 * 60_000,
          ),
        ),
      ),
    ).resolves.toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
    const rejectedChallengeId = register(fixtureChallengeIds, generateUuidV7());
    await expect(
      repository.createMfaChallenge({
        id: rejectedChallengeId,
        adminId,
        challengeDigest: uniqueDigest(),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 5 * 60_000),
      }),
    ).resolves.toBe('locked');
    await expect(
      repository.recordInvalidMfaAttempt(challenges[0].digest, now, 5, 15 * 60_000, 15 * 60_000),
    ).resolves.toBe('locked');
    const lockedAdmin = await client.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    expect(lockedAdmin.mfaFailureCount).toBe(5);
    expect(lockedAdmin.mfaLockedUntil?.getTime()).toBeGreaterThan(now.getTime());
    expect(lockedAdmin.mfaLockedUntil?.getTime()).toBeLessThanOrEqual(
      (await databaseNow(client)).getTime() + 15 * 60_000,
    );
  });

  integration(
    'releases a PENDING recovery session after signing outage and permits one atomic retry',
    async () => {
      const client = requirePrisma();
      const repository = new PrismaAdminAuthRepository(client);
      const base = await databaseNow(client);
      const adminId = register(fixtureAdminIds, generateUuidV7()),
        generation = generateUuidV7(),
        recoveryId = register(fixtureRecoveryIds, generateUuidV7()),
        challengeId = register(fixtureChallengeIds, generateUuidV7()),
        challengeDigest = uniqueDigest(),
        recoveryDigest = uniqueDigest();
      await client.adminUser.create({
        data: {
          id: adminId,
          email: `iam-pending-${adminId}@example.test`,
          passwordHash: 'digest',
          status: 'ACTIVE',
          mfaEnabled: true,
          totpSecretCiphertext: 'ciphertext',
          recoveryGeneration: generation,
          recoveryCodes: {
            create: { id: recoveryId, generation, digest: recoveryDigest, pepperVersion: 'v1' },
          },
        },
      });
      await repository.createMfaChallenge({
        id: challengeId,
        adminId,
        challengeDigest,
        createdAt: at(base, 0),
        expiresAt: at(base, 5 * 60_000),
      });
      const firstId = register(fixtureSessionIds, generateUuidV7()),
        familyId = generateUuidV7(),
        firstDigest = uniqueDigest();
      const first = await repository.completeRecoveryChallenge({
        challengeDigest,
        now: at(base, 1_000),
        maxAttempts: 5,
        failureWindowMs: 900_000,
        lockDurationMs: 900_000,
        recoveryGeneration: generation,
        recoveryCandidates: [{ pepperVersion: 'v1', digest: recoveryDigest }],
        session: {
          id: firstId,
          adminId,
          familyId,
          refreshTokenDigest: firstDigest,
          deviceName: 'PG',
          expiresAt: at(base, 30 * 24 * 60 * 60_000),
          createdAt: at(base, 1_000),
        },
      });
      expect(first).toMatchObject({ kind: 'authenticated', session: { status: 'PENDING' } });
      await expect(
        repository.rotateSession({
          presentedDigest: firstDigest,
          now: at(base, 2_000),
          successor: {
            id: register(fixtureSessionIds, generateUuidV7()),
            refreshTokenDigest: uniqueDigest(),
            createdAt: at(base, 2_000),
            expiresAt: at(base, 30 * 24 * 60 * 60_000),
          },
        }),
      ).resolves.toEqual({ kind: 'invalid' });
      await repository.releaseMfaSession({
        adminId,
        sessionId: firstId,
        familyId,
        challengeDigest,
        now: at(base, 3_000),
      });
      await expect(
        client.mfaRecoveryCode.findUniqueOrThrow({ where: { id: recoveryId } }),
      ).resolves.toMatchObject({ consumedAt: null, reservedSessionId: null });
      const competingChallengeId = register(fixtureChallengeIds, generateUuidV7()),
        competingChallengeDigest = uniqueDigest();
      await repository.createMfaChallenge({
        id: competingChallengeId,
        adminId,
        challengeDigest: competingChallengeDigest,
        createdAt: at(base, 3_000),
        expiresAt: at(base, 5 * 60_000),
      });
      const raceSessions = [
        {
          id: register(fixtureSessionIds, generateUuidV7()),
          familyId: generateUuidV7(),
          challengeDigest,
        },
        {
          id: register(fixtureSessionIds, generateUuidV7()),
          familyId: generateUuidV7(),
          challengeDigest: competingChallengeDigest,
        },
      ] as const;
      const raced = await Promise.all(
        raceSessions.map((candidate) =>
          repository.completeRecoveryChallenge({
            challengeDigest: candidate.challengeDigest,
            now: at(base, 3_000),
            maxAttempts: 5,
            failureWindowMs: 900_000,
            lockDurationMs: 900_000,
            recoveryGeneration: generation,
            recoveryCandidates: [{ pepperVersion: 'v1', digest: recoveryDigest }],
            session: {
              id: candidate.id,
              adminId,
              familyId: candidate.familyId,
              refreshTokenDigest: uniqueDigest(),
              deviceName: 'PG-race',
              expiresAt: at(base, 30 * 24 * 60 * 60_000),
              createdAt: at(base, 3_000),
            },
          }),
        ),
      );
      expect(raced.map((result) => result.kind).sort()).toEqual(['authenticated', 'invalid']);
      const winnerIndex = raced.findIndex((result) => result.kind === 'authenticated');
      const winner = raceSessions[winnerIndex];
      if (!winner) throw new Error('EXPECTED_RECOVERY_WINNER');
      await repository.releaseMfaSession({
        adminId,
        sessionId: winner.id,
        familyId: winner.familyId,
        challengeDigest: winner.challengeDigest,
        now: at(base, 3_500),
      });
      const retryId = register(fixtureSessionIds, generateUuidV7()),
        retryFamily = generateUuidV7();
      await expect(
        repository.completeRecoveryChallenge({
          challengeDigest,
          now: at(base, 4_000),
          maxAttempts: 5,
          failureWindowMs: 900_000,
          lockDurationMs: 900_000,
          recoveryGeneration: generation,
          recoveryCandidates: [{ pepperVersion: 'v1', digest: recoveryDigest }],
          session: {
            id: retryId,
            adminId,
            familyId: retryFamily,
            refreshTokenDigest: uniqueDigest(),
            deviceName: 'PG',
            expiresAt: at(base, 30 * 24 * 60 * 60_000),
            createdAt: at(base, 4_000),
          },
        }),
      ).resolves.toMatchObject({ kind: 'authenticated' });
      await expect(
        repository.finalizeMfaSession({
          adminId,
          sessionId: retryId,
          familyId: retryFamily,
          challengeDigest,
          now: at(base, 5_000),
        }),
      ).resolves.toMatchObject({ status: 'ACTIVE' });
      const consumedRecovery = await client.mfaRecoveryCode.findUniqueOrThrow({
        where: { id: recoveryId },
      });
      expect(consumedRecovery.consumedAt).toBeInstanceOf(Date);
    },
  );

  integration(
    'uses the PostgreSQL clock to cancel an MFA reservation that expires while signing',
    async () => {
      const client = requirePrisma();
      const repository = new PrismaAdminAuthRepository(client);
      const base = await databaseNow(client);
      const adminId = register(fixtureAdminIds, generateUuidV7());
      const generation = generateUuidV7();
      const recoveryId = register(fixtureRecoveryIds, generateUuidV7());
      const recoveryDigest = uniqueDigest();
      const challengeId = register(fixtureChallengeIds, generateUuidV7());
      const challengeDigest = uniqueDigest();
      const sessionId = register(fixtureSessionIds, generateUuidV7());
      const familyId = generateUuidV7();
      await client.adminUser.create({
        data: {
          id: adminId,
          email: `iam-expired-finalize-${adminId}@example.test`,
          passwordHash: 'digest',
          status: 'ACTIVE',
          mfaEnabled: true,
          totpSecretCiphertext: 'ciphertext',
          recoveryGeneration: generation,
          recoveryCodes: {
            create: { id: recoveryId, generation, digest: recoveryDigest, pepperVersion: 'v1' },
          },
        },
      });
      await repository.createMfaChallenge({
        id: challengeId,
        adminId,
        challengeDigest,
        createdAt: base,
        expiresAt: at(base, 800),
      });
      await expect(
        repository.completeRecoveryChallenge({
          challengeDigest,
          now: base,
          maxAttempts: 5,
          failureWindowMs: 900_000,
          lockDurationMs: 900_000,
          recoveryGeneration: generation,
          recoveryCandidates: [{ pepperVersion: 'v1', digest: recoveryDigest }],
          session: {
            id: sessionId,
            adminId,
            familyId,
            refreshTokenDigest: uniqueDigest(),
            deviceName: 'PG-expiry',
            createdAt: base,
            expiresAt: at(base, 3_600_000),
          },
        }),
      ).resolves.toMatchObject({ kind: 'authenticated', session: { status: 'PENDING' } });

      await delay(900);
      await expect(
        repository.finalizeMfaSession({
          adminId,
          sessionId,
          familyId,
          challengeDigest,
          now: base,
        }),
      ).resolves.toBeNull();
      await expect(
        client.adminSession.findUniqueOrThrow({ where: { id: sessionId } }),
      ).resolves.toMatchObject({ status: 'CANCELLED' });
      await expect(
        client.mfaRecoveryCode.findUniqueOrThrow({ where: { id: recoveryId } }),
      ).resolves.toMatchObject({ consumedAt: null, reservedSessionId: null, reservedUntil: null });
    },
  );

  integration(
    'rechecks administrator state after locks and safely releases the reserved factor',
    async () => {
      const client = requirePrisma();
      const repository = new PrismaAdminAuthRepository(client);
      const base = await databaseNow(client);
      const adminId = register(fixtureAdminIds, generateUuidV7());
      const generation = generateUuidV7();
      const recoveryId = register(fixtureRecoveryIds, generateUuidV7());
      const recoveryDigest = uniqueDigest();
      const challengeId = register(fixtureChallengeIds, generateUuidV7());
      const challengeDigest = uniqueDigest();
      await client.adminUser.create({
        data: {
          id: adminId,
          email: `iam-disabled-finalize-${adminId}@example.test`,
          passwordHash: 'digest',
          status: 'ACTIVE',
          mfaEnabled: true,
          totpSecretCiphertext: 'ciphertext',
          recoveryGeneration: generation,
          recoveryCodes: {
            create: { id: recoveryId, generation, digest: recoveryDigest, pepperVersion: 'v1' },
          },
        },
      });
      await repository.createMfaChallenge({
        id: challengeId,
        adminId,
        challengeDigest,
        createdAt: base,
        expiresAt: at(base, 5 * 60_000),
      });
      const firstId = register(fixtureSessionIds, generateUuidV7());
      const firstFamily = generateUuidV7();
      await expect(
        repository.completeRecoveryChallenge({
          challengeDigest,
          now: base,
          maxAttempts: 5,
          failureWindowMs: 900_000,
          lockDurationMs: 900_000,
          recoveryGeneration: generation,
          recoveryCandidates: [{ pepperVersion: 'v1', digest: recoveryDigest }],
          session: pendingMfaSession(firstId, adminId, firstFamily, base),
        }),
      ).resolves.toMatchObject({ kind: 'authenticated' });
      await client.adminUser.update({ where: { id: adminId }, data: { status: 'DISABLED' } });

      await expect(
        repository.finalizeMfaSession({
          adminId,
          sessionId: firstId,
          familyId: firstFamily,
          challengeDigest,
          now: at(base, 1_000),
        }),
      ).resolves.toBeNull();
      await expect(
        client.adminSession.findUniqueOrThrow({ where: { id: firstId } }),
      ).resolves.toMatchObject({ status: 'CANCELLED' });
      await expect(
        client.mfaRecoveryCode.findUniqueOrThrow({ where: { id: recoveryId } }),
      ).resolves.toMatchObject({ consumedAt: null, reservedSessionId: null });

      await client.adminUser.update({ where: { id: adminId }, data: { status: 'ACTIVE' } });
      const retryId = register(fixtureSessionIds, generateUuidV7());
      const retryFamily = generateUuidV7();
      await expect(
        repository.completeRecoveryChallenge({
          challengeDigest,
          now: at(base, 2_000),
          maxAttempts: 5,
          failureWindowMs: 900_000,
          lockDurationMs: 900_000,
          recoveryGeneration: generation,
          recoveryCandidates: [{ pepperVersion: 'v1', digest: recoveryDigest }],
          session: pendingMfaSession(retryId, adminId, retryFamily, at(base, 2_000)),
        }),
      ).resolves.toMatchObject({ kind: 'authenticated' });
      await expect(
        repository.finalizeMfaSession({
          adminId,
          sessionId: retryId,
          familyId: retryFamily,
          challengeDigest,
          now: at(base, 3_000),
        }),
      ).resolves.toMatchObject({ status: 'ACTIVE' });
    },
  );

  integration(
    'does not activate a refresh successor after a family revoke transaction commits first',
    async () => {
      const client = requirePrisma();
      const repository = new PrismaAdminAuthRepository(client);
      const base = await databaseNow(client);
      const adminId = register(fixtureAdminIds, generateUuidV7());
      const familyId = generateUuidV7();
      const currentId = register(fixtureSessionIds, generateUuidV7());
      const successorId = register(fixtureSessionIds, generateUuidV7());
      const presentedDigest = uniqueDigest();
      await client.adminUser.create({
        data: {
          id: adminId,
          email: `iam-refresh-race-${adminId}@example.test`,
          passwordHash: 'digest',
          status: 'ACTIVE',
          sessions: {
            create: {
              id: currentId,
              familyId,
              refreshTokenDigest: presentedDigest,
              deviceName: 'PG-race',
              createdAt: base,
              expiresAt: at(base, 3_600_000),
              status: 'ACTIVE',
            },
          },
        },
      });
      await expect(
        repository.rotateSession({
          presentedDigest,
          now: base,
          successor: {
            id: successorId,
            refreshTokenDigest: uniqueDigest(),
            createdAt: base,
            expiresAt: at(base, 3_600_000),
          },
        }),
      ).resolves.toMatchObject({ kind: 'rotated' });

      let unlock = () => {};
      let markLocked = () => {};
      const unlockGate = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      const lockKeys = [`iam:admin:${adminId}`, `iam:session-family:${familyId}`].sort();
      const revoker = client.$transaction(async (transaction) => {
        for (const key of lockKeys) {
          await transaction.$queryRaw(
            Prisma.sql`
              SELECT 1::integer AS "acquired"
              FROM (SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))) AS "held_lock"
            `,
          );
        }
        markLocked();
        await unlockGate;
        await transaction.adminSession.updateMany({
          where: { adminId, familyId, revokedAt: null },
          data: { revokedAt: at(base, 1_000) },
        });
      });
      await locked;
      const finalizing = repository.finalizeRotatedSession({
        presentedDigest,
        successorId,
        now: at(base, 1_000),
      });
      try {
        await waitForAdvisoryWaiters(client, 1);
      } finally {
        unlock();
      }
      await revoker;

      await expect(finalizing).resolves.toBeNull();
      await expect(
        client.adminSession.findUniqueOrThrow({ where: { id: successorId } }),
      ).resolves.toMatchObject({ status: 'CANCELLED' });
    },
  );

  integration(
    'serializes disable before recovery finalization and releases the factor',
    async () => {
      const client = requirePrisma();
      const fixture = await createPendingRecoveryFixture(client, 'disable-first-recovery');
      const finalizerClient = createIntegrationClient();
      const disablerClient = createIntegrationClient();
      const finalizer = new PrismaAdminAuthRepository(finalizerClient);
      const disabler = new PrismaAdminAuthRepository(disablerClient);
      const barrier = await holdAdminAdvisoryLock(client, fixture.adminId);
      try {
        const disabling = disabler.disableAdminAccess(fixture.adminId, fixture.base);
        await waitForAdvisoryWaiters(client, 1);
        const finalizing = finalizer.finalizeMfaSession({
          adminId: fixture.adminId,
          sessionId: fixture.sessionId,
          familyId: fixture.familyId,
          challengeDigest: fixture.challengeDigest,
          now: fixture.base,
        });
        await waitForAdvisoryWaiters(client, 2);
        barrier.release();
        await expect(disabling).resolves.toBe('disabled');
        await expect(finalizing).resolves.toBeNull();
      } finally {
        barrier.release();
        await barrier.done;
        await finalizerClient.$disconnect();
        await disablerClient.$disconnect();
      }
      await expect(
        client.adminSession.findUniqueOrThrow({ where: { id: fixture.sessionId } }),
      ).resolves.toMatchObject({ status: 'CANCELLED' });
      await expect(
        client.mfaRecoveryCode.findUniqueOrThrow({ where: { id: fixture.recoveryId } }),
      ).resolves.toMatchObject({ consumedAt: null, reservedSessionId: null });
    },
  );

  integration('revokes a recovery session when finalization commits before disable', async () => {
    const client = requirePrisma();
    const fixture = await createPendingRecoveryFixture(client, 'finalize-first-recovery');
    const finalizerClient = createIntegrationClient();
    const disablerClient = createIntegrationClient();
    const finalizer = new PrismaAdminAuthRepository(finalizerClient);
    const disabler = new PrismaAdminAuthRepository(disablerClient);
    const barrier = await holdAdminAdvisoryLock(client, fixture.adminId);
    try {
      const finalizing = finalizer.finalizeMfaSession({
        adminId: fixture.adminId,
        sessionId: fixture.sessionId,
        familyId: fixture.familyId,
        challengeDigest: fixture.challengeDigest,
        now: fixture.base,
      });
      await waitForAdvisoryWaiters(client, 1);
      const disabling = disabler.disableAdminAccess(fixture.adminId, fixture.base);
      await waitForAdvisoryWaiters(client, 2);
      barrier.release();
      await expect(finalizing).resolves.toMatchObject({ status: 'ACTIVE' });
      await expect(disabling).resolves.toBe('disabled');
    } finally {
      barrier.release();
      await barrier.done;
      await finalizerClient.$disconnect();
      await disablerClient.$disconnect();
    }
    const persisted = await client.adminSession.findUniqueOrThrow({
      where: { id: fixture.sessionId },
    });
    expect(persisted.status).toBe('ACTIVE');
    expect(persisted.revokedAt).toBeInstanceOf(Date);
    await expect(
      client.adminSession.count({
        where: {
          adminId: fixture.adminId,
          status: { in: ['ACTIVE', 'PENDING'] },
          revokedAt: null,
        },
      }),
    ).resolves.toBe(0);
  });

  integration(
    'serializes disable before refresh finalization and keeps both tokens unusable',
    async () => {
      const client = requirePrisma();
      const fixture = await createPendingRefreshFixture(client, 'disable-first-refresh');
      const finalizerClient = createIntegrationClient();
      const disablerClient = createIntegrationClient();
      const finalizer = new PrismaAdminAuthRepository(finalizerClient);
      const disabler = new PrismaAdminAuthRepository(disablerClient);
      const barrier = await holdAdminAdvisoryLock(client, fixture.adminId);
      try {
        const disabling = disabler.disableAdminAccess(fixture.adminId, fixture.base);
        await waitForAdvisoryWaiters(client, 1);
        const finalizing = finalizer.finalizeRotatedSession({
          presentedDigest: fixture.presentedDigest,
          successorId: fixture.successorId,
          now: fixture.base,
        });
        await waitForAdvisoryWaiters(client, 2);
        barrier.release();
        await expect(disabling).resolves.toBe('disabled');
        await expect(finalizing).resolves.toBeNull();
      } finally {
        barrier.release();
        await barrier.done;
        await finalizerClient.$disconnect();
        await disablerClient.$disconnect();
      }
      const current = await client.adminSession.findUniqueOrThrow({
        where: { id: fixture.currentId },
      });
      const successor = await client.adminSession.findUniqueOrThrow({
        where: { id: fixture.successorId },
      });
      expect(current.status).toBe('ACTIVE');
      expect(current.revokedAt).toBeInstanceOf(Date);
      expect(successor.status).toBe('CANCELLED');
      expect(successor.revokedAt).toBeInstanceOf(Date);
    },
  );

  integration(
    'revokes the refresh successor when finalization commits before disable',
    async () => {
      const client = requirePrisma();
      const fixture = await createPendingRefreshFixture(client, 'finalize-first-refresh');
      const finalizerClient = createIntegrationClient();
      const disablerClient = createIntegrationClient();
      const finalizer = new PrismaAdminAuthRepository(finalizerClient);
      const disabler = new PrismaAdminAuthRepository(disablerClient);
      const barrier = await holdAdminAdvisoryLock(client, fixture.adminId);
      try {
        const finalizing = finalizer.finalizeRotatedSession({
          presentedDigest: fixture.presentedDigest,
          successorId: fixture.successorId,
          now: fixture.base,
        });
        await waitForAdvisoryWaiters(client, 1);
        const disabling = disabler.disableAdminAccess(fixture.adminId, fixture.base);
        await waitForAdvisoryWaiters(client, 2);
        barrier.release();
        await expect(finalizing).resolves.toMatchObject({ status: 'ACTIVE' });
        await expect(disabling).resolves.toBe('disabled');
      } finally {
        barrier.release();
        await barrier.done;
        await finalizerClient.$disconnect();
        await disablerClient.$disconnect();
      }
      const successor = await client.adminSession.findUniqueOrThrow({
        where: { id: fixture.successorId },
      });
      expect(successor.status).toBe('ACTIVE');
      expect(successor.revokedAt).toBeInstanceOf(Date);
      await expect(
        client.adminSession.count({
          where: {
            adminId: fixture.adminId,
            status: { in: ['ACTIVE', 'PENDING'] },
            revokedAt: null,
          },
        }),
      ).resolves.toBe(0);
    },
  );

  integration('cleans only bounded PENDING sessions whose expiry has passed', async () => {
    const client = requirePrisma();
    const repository = new PrismaAdminAuthRepository(client);
    const expired = await createPendingRecoveryFixture(client, 'cleanup-expired');
    const future = await createPendingRecoveryFixture(client, 'cleanup-future');
    const databaseTime = await databaseNow(client);
    await client.adminSession.update({
      where: { id: expired.sessionId },
      data: { pendingExpiresAt: at(databaseTime, -1_000) },
    });
    await client.adminSession.update({
      where: { id: future.sessionId },
      data: { pendingExpiresAt: at(databaseTime, 60_000) },
    });

    await expect(
      repository.cleanupExpiredPendingSessions(at(databaseTime, 86_400_000), 1),
    ).resolves.toBe(1);
    await expect(
      client.adminSession.findUniqueOrThrow({ where: { id: expired.sessionId } }),
    ).resolves.toMatchObject({ status: 'CANCELLED' });
    await expect(
      client.adminSession.findUniqueOrThrow({ where: { id: future.sessionId } }),
    ).resolves.toMatchObject({ status: 'PENDING' });
    await expect(
      client.mfaRecoveryCode.findUniqueOrThrow({ where: { id: expired.recoveryId } }),
    ).resolves.toMatchObject({ consumedAt: null, reservedSessionId: null });
    await expect(
      client.mfaRecoveryCode.findUniqueOrThrow({ where: { id: future.recoveryId } }),
    ).resolves.toMatchObject({ consumedAt: null, reservedSessionId: future.sessionId });
  });
});

function createIntegrationClient(): PrismaClient {
  if (!testDatabaseUrl) throw new Error('IAM_TEST_DATABASE_URL_REQUIRED');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl }) });
}

async function createPendingRecoveryFixture(client: PrismaClient, label: string) {
  const repository = new PrismaAdminAuthRepository(client);
  const base = await databaseNow(client);
  const adminId = register(fixtureAdminIds, generateUuidV7());
  const generation = generateUuidV7();
  const recoveryId = register(fixtureRecoveryIds, generateUuidV7());
  const recoveryDigest = uniqueDigest();
  const challengeId = register(fixtureChallengeIds, generateUuidV7());
  const challengeDigest = uniqueDigest();
  const sessionId = register(fixtureSessionIds, generateUuidV7());
  const familyId = generateUuidV7();
  await client.adminUser.create({
    data: {
      id: adminId,
      email: `iam-${label}-${adminId}@example.test`,
      passwordHash: 'digest',
      status: 'ACTIVE',
      mfaEnabled: true,
      totpSecretCiphertext: 'ciphertext',
      recoveryGeneration: generation,
      recoveryCodes: {
        create: { id: recoveryId, generation, digest: recoveryDigest, pepperVersion: 'v1' },
      },
    },
  });
  await repository.createMfaChallenge({
    id: challengeId,
    adminId,
    challengeDigest,
    createdAt: base,
    expiresAt: at(base, 5 * 60_000),
  });
  await expect(
    repository.completeRecoveryChallenge({
      challengeDigest,
      now: base,
      maxAttempts: 5,
      failureWindowMs: 900_000,
      lockDurationMs: 900_000,
      recoveryGeneration: generation,
      recoveryCandidates: [{ pepperVersion: 'v1', digest: recoveryDigest }],
      session: pendingMfaSession(sessionId, adminId, familyId, base),
    }),
  ).resolves.toMatchObject({ kind: 'authenticated', session: { status: 'PENDING' } });
  return { base, adminId, recoveryId, challengeDigest, sessionId, familyId };
}

async function createPendingRefreshFixture(client: PrismaClient, label: string) {
  const repository = new PrismaAdminAuthRepository(client);
  const base = await databaseNow(client);
  const adminId = register(fixtureAdminIds, generateUuidV7());
  const familyId = generateUuidV7();
  const currentId = register(fixtureSessionIds, generateUuidV7());
  const successorId = register(fixtureSessionIds, generateUuidV7());
  const presentedDigest = uniqueDigest();
  await client.adminUser.create({
    data: {
      id: adminId,
      email: `iam-${label}-${adminId}@example.test`,
      passwordHash: 'digest',
      status: 'ACTIVE',
      sessions: {
        create: {
          id: currentId,
          familyId,
          refreshTokenDigest: presentedDigest,
          deviceName: 'PG-barrier',
          createdAt: base,
          expiresAt: at(base, 3_600_000),
          status: 'ACTIVE',
        },
      },
    },
  });
  await expect(
    repository.rotateSession({
      presentedDigest,
      now: base,
      successor: {
        id: successorId,
        refreshTokenDigest: uniqueDigest(),
        createdAt: base,
        expiresAt: at(base, 3_600_000),
      },
    }),
  ).resolves.toMatchObject({ kind: 'rotated', session: { status: 'PENDING' } });
  return { base, adminId, familyId, currentId, successorId, presentedDigest };
}

async function holdAdminAdvisoryLock(client: PrismaClient, adminId: string) {
  let release = () => {};
  let ready = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = client.$transaction(async (transaction) => {
    await transaction.$queryRaw(
      Prisma.sql`
        SELECT 1::integer AS "acquired"
        FROM (
          SELECT pg_advisory_xact_lock(hashtextextended(${`iam:admin:${adminId}`}, 0))
        ) AS "held_lock"
      `,
    );
    ready();
    await gate;
  });
  await acquired;
  return { release, done };
}

function requirePrisma(): PrismaClient {
  if (!prisma) throw new Error('IAM_TEST_DATABASE_URL_REQUIRED');
  return prisma;
}

function register(target: Set<string>, value: string): string {
  target.add(value);
  return value;
}

function uniqueDigest(): string {
  return randomBytes(32).toString('hex');
}

function at(base: Date, offsetMs: number): Date {
  return new Date(base.getTime() + offsetMs);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pendingMfaSession(id: string, adminId: string, familyId: string, now: Date) {
  return {
    id,
    adminId,
    familyId,
    refreshTokenDigest: uniqueDigest(),
    deviceName: 'PG-retry',
    createdAt: now,
    expiresAt: at(now, 3_600_000),
  };
}

async function databaseNow(client: PrismaClient): Promise<Date> {
  const rows = await client.$queryRaw<{ now: Date }[]>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  const now = rows[0]?.now;
  if (!now) throw new Error('DATABASE_TIME_UNAVAILABLE');
  return now;
}

async function waitForAdvisoryWaiters(client: PrismaClient, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await client.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::integer AS "waiting"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
    `;
    if ((rows[0]?.waiting ?? 0) >= expected) return;
    await delay(10);
  }
  throw new Error('ADVISORY_WAITERS_NOT_OBSERVED');
}

async function cleanupFixtures(client: PrismaClient): Promise<void> {
  if (fixtureSessionIds.size > 0) {
    await client.adminSession.deleteMany({ where: { id: { in: [...fixtureSessionIds] } } });
  }
  if (fixtureChallengeIds.size > 0) {
    await client.mfaChallenge.deleteMany({ where: { id: { in: [...fixtureChallengeIds] } } });
  }
  if (fixtureRecoveryIds.size > 0)
    await client.mfaRecoveryCode.deleteMany({ where: { id: { in: [...fixtureRecoveryIds] } } });
  if (fixtureAdminIds.size > 0) {
    await client.adminUser.deleteMany({ where: { id: { in: [...fixtureAdminIds] } } });
  }
  fixtureSessionIds.clear();
  fixtureChallengeIds.clear();
  fixtureRecoveryIds.clear();
  fixtureAdminIds.clear();
}
