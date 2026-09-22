import { Prisma, type PrismaClient, type Session } from '../generated/prisma/client.js';
import type {
  CreateSessionRecord,
  RotateSessionInput,
  RotateSessionResult,
  SessionRecord,
  SessionRepository,
} from '../application/session.service.js';
import type { AccessSessionStatusRepository } from './jose-access-token.verifier.js';
import { identityLockKeys } from '../domain/identity-lock-key.js';

const TRANSACTION_OPTIONS = Object.freeze({
  isolationLevel: 'ReadCommitted' as const,
  maxWait: 5_000,
  timeout: 10_000,
});

type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export class PrismaSessionRepository implements SessionRepository, AccessSessionStatusRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateSessionRecord): Promise<SessionRecord> {
    return this.prisma.$transaction(
      async (transaction) => {
        await acquireSessionLocks(transaction, input.userId, input.familyId);
        const user = await transaction.user.findUnique({
          where: { id: input.userId },
          select: { status: true },
        });
        if (user?.status !== 'ACTIVE') throw stableError('USER_INACTIVE');
        return mapSession(
          await transaction.session.create({
            data: toCreateData(input),
          }),
        );
      },
      TRANSACTION_OPTIONS,
    );
  }

  rotate(input: RotateSessionInput): Promise<RotateSessionResult> {
    return this.prisma.$transaction(
      async (transaction) => {
        const located = await transaction.session.findUnique({
          where: { refreshTokenDigest: input.presentedDigest },
          select: { id: true, userId: true, familyId: true },
        });
        if (!located) return { kind: 'invalid' };
        await acquireSessionLocks(transaction, located.userId, located.familyId);
        return this.rotateInTransaction(transaction, input, located);
      },
      TRANSACTION_OPTIONS,
    );
  }

  async revokeById(userId: string, sessionId: string, now: Date): Promise<boolean> {
    return this.prisma.$transaction(
      async (transaction) => {
        const located = await transaction.session.findUnique({
          where: { id: sessionId },
          select: { id: true, userId: true, familyId: true },
        });
        if (!located || located.userId !== userId) return false;
        await acquireSessionLocks(transaction, userId, located.familyId);
        const current = await transaction.session.findUnique({
          where: { id: sessionId },
          select: { userId: true, familyId: true },
        });
        if (!current || current.userId !== userId || current.familyId !== located.familyId) {
          return false;
        }
        const result = await transaction.session.updateMany({
          where: { familyId: current.familyId, userId, revokedAt: null },
          data: { revokedAt: now },
        });
        return result.count > 0;
      },
      TRANSACTION_OPTIONS,
    );
  }

  async revokeFamilyByDigest(digest: string, now: Date): Promise<void> {
    await this.prisma.$transaction(
      async (transaction) => {
        const located = await transaction.session.findUnique({
          where: { refreshTokenDigest: digest },
          select: { userId: true, familyId: true },
        });
        if (!located) return;
        await acquireSessionLocks(transaction, located.userId, located.familyId);
        const current = await transaction.session.findUnique({
          where: { refreshTokenDigest: digest },
          select: { userId: true, familyId: true },
        });
        if (
          !current ||
          current.userId !== located.userId ||
          current.familyId !== located.familyId
        ) {
          return;
        }
        await revokeFamily(transaction, current.familyId, now);
      },
      TRANSACTION_OPTIONS,
    );
  }

  async listActive(userId: string, now: Date): Promise<SessionRecord[]> {
    const sessions = await this.prisma.session.findMany({
      where: {
        userId,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
        user: { status: 'ACTIVE' },
      },
      orderBy: { createdAt: 'desc' },
    });
    return sessions.map(mapSession);
  }

  async isActive(userId: string, sessionId: string, now: Date): Promise<boolean> {
    return (
      (await this.prisma.session.count({
        where: {
          id: sessionId,
          userId,
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
          user: { status: 'ACTIVE' },
        },
      })) === 1
    );
  }

  private async rotateInTransaction(
    transaction: TransactionClient,
    input: RotateSessionInput,
    located: { readonly id: string; readonly userId: string; readonly familyId: string },
  ): Promise<RotateSessionResult> {
    const current = await transaction.session.findUnique({
      where: { refreshTokenDigest: input.presentedDigest },
      include: { user: { select: { status: true } } },
    });
    if (!current) return { kind: 'invalid' };
    if (
      current.id !== located.id ||
      current.userId !== located.userId ||
      current.familyId !== located.familyId
    ) {
      return { kind: 'invalid' };
    }
    if (current.consumedAt) {
      await revokeFamily(transaction, current.familyId, input.now);
      return { kind: 'reuse' };
    }
    if (current.revokedAt) return { kind: 'revoked' };
    if (current.expiresAt <= input.now) return { kind: 'expired' };
    if (current.user.status !== 'ACTIVE') return { kind: 'user_inactive' };

    const consumed = await transaction.session.updateMany({
      where: {
        id: current.id,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: input.now },
      },
      data: { consumedAt: input.now },
    });
    if (consumed.count === 0) {
      const raced = await transaction.session.findUnique({ where: { id: current.id } });
      if (raced?.consumedAt) {
        await revokeFamily(transaction, current.familyId, input.now);
        return { kind: 'reuse' };
      }
      return raced?.revokedAt ? { kind: 'revoked' } : { kind: 'expired' };
    }

    const successor = await transaction.session.create({
      data: {
        ...input.successor,
        userId: current.userId,
        familyId: current.familyId,
        deviceName: current.deviceName,
      },
    });
    return { kind: 'rotated', session: mapSession(successor) };
  }
}

function toCreateData(input: CreateSessionRecord): Prisma.SessionUncheckedCreateInput {
  return input;
}

function mapSession(session: Session): SessionRecord {
  return {
    id: session.id,
    userId: session.userId,
    familyId: session.familyId,
    refreshTokenDigest: session.refreshTokenDigest,
    deviceName: session.deviceName,
    expiresAt: session.expiresAt,
    consumedAt: session.consumedAt,
    revokedAt: session.revokedAt,
    createdAt: session.createdAt,
  };
}

async function revokeFamily(
  transaction: TransactionClient,
  familyId: string,
  now: Date,
): Promise<void> {
  await transaction.session.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: now },
  });
}

async function acquireSessionLocks(
  transaction: TransactionClient,
  userId: string,
  familyId: string,
): Promise<void> {
  for (const lockKey of identityLockKeys({ userId, sessionFamilyId: familyId })) {
    await transaction.$queryRaw(
      Prisma.sql`
        SELECT 1::integer AS "acquired"
        FROM (
          SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
        ) AS "held_lock"
      `,
    );
  }
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
