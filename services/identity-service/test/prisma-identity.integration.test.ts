import { randomInt } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { HmacPrivacyIdentifierHasher } from '../src/adapters/hmac-privacy-identifier.hasher.js';
import { PrismaAccountMutationRepository } from '../src/adapters/prisma-account-mutation.repository.js';
import { PrismaSessionRepository } from '../src/adapters/prisma-session.repository.js';
import { IdentityAccountService } from '../src/application/identity-account.service.js';
import { SessionService } from '../src/application/session.service.js';
import { EventMetadata } from '../src/domain/event-metadata.js';
import { generateUuidV7 } from '../src/domain/uuid-v7.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { resolveIdentityTestDatabaseUrl } from './test-targets.js';

const databaseUrl = resolveIdentityTestDatabaseUrl(process.env);
const operationFingerprintHasher = new HmacPrivacyIdentifierHasher(
  { getPrivacyIdentifierSecret: () => Promise.resolve(Buffer.alloc(32, 9)) },
  'kms://identity/account-operation#version=2026-09-01',
);

describe.skipIf(!databaseUrl)('Prisma identity integration', () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl ?? 'postgresql://unused/skip' }),
  });
  const userIds: string[] = [];
  const sentinelId = generateUuidV7();
  const sentinelPhone = uniquePhone();

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.user.create({
      data: {
        id: sentinelId,
        phoneE164: sentinelPhone,
        nickname: `sentinel-${sentinelId}`,
        status: 'ACTIVE',
      },
    });
  });

  afterAll(async () => {
    try {
      if (userIds.length > 0) {
        await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: userIds } } });
        await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
      await expect(prisma.user.findUnique({ where: { id: sentinelId } })).resolves.toMatchObject({
        id: sentinelId,
        phoneE164: sentinelPhone,
      });
    } finally {
      try {
        await prisma.user.deleteMany({ where: { id: sentinelId } });
      } finally {
        await prisma.$disconnect();
      }
    }
  });

  it('executes typed advisory locks and blocks a concurrent transaction on the same scope', async () => {
    const lockUserId = generateUuidV7();
    const applicationName = `identity-lock-${lockUserId}`;
    const connectionString = withApplicationName(
      databaseUrl ?? 'postgresql://unused/skip',
      applicationName,
    );
    const firstClient = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
    const secondClient = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
    const firstEntered = deferredSignal();
    const releaseFirst = deferredSignal();
    let secondEntered = false;
    try {
      await Promise.all([firstClient.$connect(), secondClient.$connect()]);
      const first = new PrismaAccountMutationRepository(firstClient).transaction(
        { userId: lockUserId },
        async () => {
          firstEntered.resolve();
          await releaseFirst.promise;
        },
      );
      await Promise.race([firstEntered.promise, first]);

      const second = new PrismaAccountMutationRepository(secondClient).transaction(
        { userId: lockUserId },
        () => {
          secondEntered = true;
          return Promise.resolve();
        },
      );
      await waitForAdvisoryWaiter(prisma, applicationName);
      expect(secondEntered).toBe(false);

      releaseFirst.resolve();
      await Promise.all([first, second]);
      expect(secondEntered).toBe(true);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([firstClient.$disconnect(), secondClient.$disconnect()]);
    }
  });

  it('revokes a family after two real concurrent refresh rotations', async () => {
    const userId = generateUuidV7();
    userIds.push(userId);
    await prisma.user.create({
      data: { id: userId, phoneE164: uniquePhone(), nickname: 'pg-session', status: 'ACTIVE' },
    });
    const service = new SessionService({
      repository: new PrismaSessionRepository(prisma),
      accessTokenIssuer: { issue: ({ sessionId }) => Promise.resolve(`access.${sessionId}`) },
    });
    const first = await service.create(userId, 'integration');

    const rotations = await Promise.allSettled([
      service.rotate(first.refreshToken),
      service.rotate(first.refreshToken),
    ]);
    expect(rotations.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const family = await prisma.session.findMany({ where: { familyId: first.session.familyId } });
    expect(family).toSatisfy((sessions: Array<{ revokedAt: Date | null }>) =>
      sessions.every((session) => session.revokedAt !== null),
    );
  });

  it('converges concurrent registration and rejects a competing phone bind', async () => {
    const repository = new PrismaAccountMutationRepository(prisma);
    const phone = uniquePhone();
    const firstCandidateId = generateUuidV7();
    const secondCandidateId = generateUuidV7();
    userIds.push(firstCandidateId, secondCandidateId);
    const users = await Promise.all([
      repository.findOrCreateActiveUserByPhone(phone, {
        id: firstCandidateId,
        nickname: 'register-a',
      }),
      repository.findOrCreateActiveUserByPhone(phone, {
        id: secondCandidateId,
        nickname: 'register-b',
      }),
    ]);
    const [firstUser, secondUser] = users;
    expect(firstUser.id).toBe(secondUser.id);

    const secondId = generateUuidV7();
    userIds.push(secondId);
    await prisma.user.create({
      data: { id: secondId, phoneE164: uniquePhone(), nickname: 'second', status: 'ACTIVE' },
    });
    const targetPhone = uniquePhone();
    const verifier = { verify: () => Promise.resolve(true) };
    const account = new IdentityAccountService({
      repository,
      smsVerifier: verifier,
      operationFingerprintHasher,
    });
    const results = await Promise.allSettled([
      account.changePhone({
        userId: firstUser.id,
        currentPhoneCode: '111111',
        newPhoneE164: targetPhone,
        newPhoneCode: '222222',
        operationId: generateUuidV7(),
        eventMetadata: EventMetadata.create(),
      }),
      account.changePhone({
        userId: secondId,
        currentPhoneCode: '333333',
        newPhoneE164: targetPhone,
        newPhoneCode: '444444',
        operationId: generateUuidV7(),
        eventMetadata: EventMetadata.create(),
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('commits one same-operation phone change and rejects a different fingerprint', async () => {
    const userId = generateUuidV7();
    userIds.push(userId);
    const originalPhone = uniquePhone();
    const targetPhone = uniquePhone();
    await prisma.user.create({
      data: { id: userId, phoneE164: originalPhone, nickname: 'idempotency', status: 'ACTIVE' },
    });
    const verify = vi.fn().mockResolvedValue(true);
    const repository = new PrismaAccountMutationRepository(prisma);
    const account = new IdentityAccountService({
      repository,
      smsVerifier: { verify },
      operationFingerprintHasher,
    });
    const operationId = generateUuidV7();
    const input = {
      userId,
      currentPhoneCode: '111111',
      newPhoneE164: targetPhone,
      newPhoneCode: '222222',
      operationId,
      eventMetadata: EventMetadata.create(),
    };

    await expect(Promise.all([account.changePhone(input), account.changePhone(input)])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(verify).toHaveBeenCalledTimes(2);
    await expect(
      account.changePhone({ ...input, newPhoneE164: uniquePhone() }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('rolls back a mutation when the transactional outbox path fails and exposes envelope columns', async () => {
    const userId = generateUuidV7();
    userIds.push(userId);
    await prisma.user.create({
      data: { id: userId, phoneE164: uniquePhone(), nickname: 'before', status: 'ACTIVE' },
    });
    const repository = new PrismaAccountMutationRepository(prisma);
    await expect(
      repository.transaction(null, async (transaction) => {
        await transaction.updateNickname(userId, 'after');
        throw new Error('FORCED_OUTBOX_FAILURE');
      }),
    ).rejects.toThrow('FORCED_OUTBOX_FAILURE');
    await expect(prisma.user.findUnique({ where: { id: userId } })).resolves.toMatchObject({
      nickname: 'before',
    });

    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'outbox_events'
    `;
    expect(columns.map((column) => column.column_name)).toEqual(
      expect.arrayContaining([
        'version',
        'trace_id',
        'correlation_id',
        'causation_id',
        'producer',
        'data',
      ]),
    );
  });

  it('revokes the latest descendant when an ancestor reuse races its rotation', async () => {
    const userId = generateUuidV7();
    userIds.push(userId);
    await prisma.user.create({
      data: { id: userId, phoneE164: uniquePhone(), nickname: 'ancestor-race', status: 'ACTIVE' },
    });
    const service = sessionService(prisma);
    const ancestor = await service.create(userId, 'race');
    const descendant = await service.rotate(ancestor.refreshToken);

    await Promise.allSettled([
      service.rotate(ancestor.refreshToken),
      service.rotate(descendant.refreshToken),
    ]);

    const family = await prisma.session.findMany({
      where: { familyId: ancestor.session.familyId },
    });
    expect(family.length).toBeGreaterThanOrEqual(2);
    expect(family.every(({ revokedAt }) => revokedAt !== null)).toBe(true);
  });

  it('leaves no active successor when family revoke races refresh rotation', async () => {
    const userId = generateUuidV7();
    userIds.push(userId);
    await prisma.user.create({
      data: { id: userId, phoneE164: uniquePhone(), nickname: 'revoke-race', status: 'ACTIVE' },
    });
    const repository = new PrismaSessionRepository(prisma);
    const service = sessionService(prisma, repository);
    const first = await service.create(userId, 'race');

    await Promise.allSettled([
      repository.revokeById(userId, first.session.id, new Date()),
      service.rotate(first.refreshToken),
    ]);

    const family = await prisma.session.findMany({ where: { familyId: first.session.familyId } });
    expect(family.every(({ revokedAt }) => revokedAt !== null)).toBe(true);
  });

  it('serializes account close against session create and rotation without a phantom session', async () => {
    const userId = generateUuidV7();
    userIds.push(userId);
    await prisma.user.create({
      data: { id: userId, phoneE164: uniquePhone(), nickname: 'close-race', status: 'ACTIVE' },
    });
    const service = sessionService(prisma);
    const first = await service.create(userId, 'existing');
    const account = new IdentityAccountService({
      repository: new PrismaAccountMutationRepository(prisma),
      smsVerifier: { verify: () => Promise.resolve(true) },
      operationFingerprintHasher,
    });

    await Promise.allSettled([
      account.closeAccount({
        userId,
        code: '111111',
        operationId: generateUuidV7(),
        eventMetadata: EventMetadata.create(),
      }),
      service.create(userId, 'concurrent-create'),
      service.rotate(first.refreshToken),
    ]);

    await expect(prisma.user.findUnique({ where: { id: userId } })).resolves.toMatchObject({
      status: 'CLOSED',
    });
    const sessions = await prisma.session.findMany({ where: { userId } });
    expect(sessions.every(({ revokedAt }) => revokedAt !== null)).toBe(true);
  });

  it('allows a legacy insert without family_id and generates a UUIDv7 default', async () => {
    const userId = generateUuidV7();
    const sessionId = generateUuidV7();
    userIds.push(userId);
    await prisma.user.create({
      data: { id: userId, phoneE164: uniquePhone(), nickname: 'legacy-writer', status: 'ACTIVE' },
    });

    await prisma.$executeRaw`
      INSERT INTO sessions
        (id, user_id, refresh_token_hash, device_name, expires_at, created_at)
      VALUES
        (${sessionId}::uuid, ${userId}::uuid, ${`legacy-${sessionId}`}, 'legacy', NOW() + INTERVAL '1 day', NOW())
    `;

    const inserted = await prisma.session.findUnique({ where: { id: sessionId } });
    expect(inserted?.familyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/i);
  });
});

function sessionService(
  prisma: PrismaClient,
  repository: PrismaSessionRepository = new PrismaSessionRepository(prisma),
): SessionService {
  return new SessionService({
    repository,
    accessTokenIssuer: { issue: ({ sessionId }) => Promise.resolve(`access.${sessionId}`) },
  });
}

function uniquePhone(): string {
  return `+86188${randomInt(0, 100_000_000).toString().padStart(8, '0')}`;
}

function deferredSignal(): {
  readonly promise: Promise<undefined>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<undefined>((fulfill) => {
    resolve = () => {
      fulfill(undefined);
    };
  });
  return { promise, resolve };
}

function withApplicationName(connectionString: string, applicationName: string): string {
  const target = new URL(connectionString);
  target.searchParams.set('application_name', applicationName);
  return target.toString();
}

async function waitForAdvisoryWaiter(prisma: PrismaClient, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
    `;
    if ((rows[0]?.waiting ?? 0) >= 1) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('ADVISORY_LOCK_WAITER_NOT_OBSERVED');
}
