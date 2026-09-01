import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type {
  AccountMutationRepository,
  AccountMutationLockScope,
  AccountMutationTransaction,
  AccountUser,
  OperationResultExpectation,
  OutboxWrite,
} from '../application/identity-account.service.js';
import { identityLockKeys } from '../domain/identity-lock-key.js';

const TRANSACTION_MAX_WAIT_MS = 5_000;
const TRANSACTION_TIMEOUT_MS = 10_000;

type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export class PrismaAccountMutationRepository implements AccountMutationRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly transactionClient?: TransactionClient,
  ) {}

  async transaction<T>(
    scope: AccountMutationLockScope | null,
    work: (transaction: AccountMutationTransaction) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const lockKeys = scope ? identityLockKeys(scope) : [];
            for (const lockKey of lockKeys) {
              await transaction.$queryRaw(
                Prisma.sql`
                  SELECT 1::integer AS "acquired"
                  FROM (
                    SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
                  ) AS "held_lock"
                `,
              );
            }
            return work(new PrismaAccountMutationRepository(this.prisma, transaction));
          },
          {
            isolationLevel: 'ReadCommitted',
            maxWait: TRANSACTION_MAX_WAIT_MS,
            timeout: TRANSACTION_TIMEOUT_MS,
          },
        );
      } catch (error: unknown) {
        if (isPrismaCode(error, 'P2034')) {
          if (attempt === 3) throw stableError('SERIALIZATION_RETRY_EXHAUSTED');
          continue;
        }
        if (isPrismaCode(error, 'P2002') && scope?.operationId) {
          if (attempt === 3) throw stableError('IDEMPOTENCY_KEY_REUSED');
          continue;
        }
        throw error;
      }
    }
    throw stableError('SERIALIZATION_RETRY_EXHAUSTED');
  }

  async getActiveUser(userId: string): Promise<AccountUser | null> {
    const user = await this.client.user.findFirst({ where: { id: userId, status: 'ACTIVE' } });
    return user ? mapUser(user) : null;
  }

  async findOrCreateActiveUserByPhone(
    phoneE164: string,
    create: { readonly id: string; readonly nickname: string },
  ): Promise<AccountUser> {
    try {
      return await this.transaction(null, async (transaction) => {
        const adapter = transaction as PrismaAccountMutationRepository;
        const existing = await adapter.client.user.findUnique({ where: { phoneE164 } });
        if (existing) {
          if (existing.status !== 'ACTIVE') throw stableError('USER_INACTIVE');
          return mapUser(existing);
        }
        return mapUser(
          await adapter.client.user.create({
            data: {
              id: create.id,
              phoneE164,
              nickname: create.nickname,
              status: 'ACTIVE',
            },
          }),
        );
      });
    } catch (error: unknown) {
      if (!isPrismaCode(error, 'P2002')) throw error;
      const winner = await this.prisma.user.findUnique({ where: { phoneE164 } });
      if (winner?.status === 'ACTIVE') return mapUser(winner);
      throw stableError('USER_INACTIVE');
    }
  }

  async isPhoneAvailable(phoneE164: string, excludingUserId: string): Promise<boolean> {
    return (
      (await this.client.user.count({
        where: { phoneE164, id: { not: excludingUserId } },
      })) === 0
    );
  }

  async updatePhone(userId: string, phoneE164: string): Promise<void> {
    try {
      await this.client.user.update({ where: { id: userId }, data: { phoneE164 } });
    } catch (error: unknown) {
      if (isPrismaCode(error, 'P2002')) {
        throw stableError('PHONE_ALREADY_IN_USE');
      }
      throw error;
    }
  }

  async updateNickname(userId: string, nickname: string): Promise<void> {
    await this.client.user.update({ where: { id: userId }, data: { nickname } });
  }

  async closeUser(userId: string): Promise<boolean> {
    const result = await this.client.user.updateMany({
      where: { id: userId, status: 'ACTIVE' },
      data: { status: 'CLOSED' },
    });
    return result.count > 0;
  }

  async revokeAllSessions(userId: string, now: Date): Promise<void> {
    await this.client.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  async getOperationResult(
    expectation: OperationResultExpectation,
  ): Promise<'missing' | 'completed'> {
    const existing = await this.client.outboxEvent.findUnique({
      where: { dedupeKey: expectation.dedupeKey },
      select: { aggregateId: true, type: true, data: true },
    });
    if (!existing) return 'missing';
    const persistedFingerprint = requestFingerprintFromJson(existing.data);
    if (
      existing.aggregateId === expectation.aggregateId &&
      existing.type === expectation.type &&
      persistedFingerprint !== undefined &&
      expectation.requestFingerprints.some(
        ({ digest, keyVersion }) =>
          digest === persistedFingerprint.digest &&
          keyVersion === persistedFingerprint.keyVersion,
      )
    ) {
      return 'completed';
    }
    throw stableError('IDEMPOTENCY_KEY_REUSED');
  }

  async appendOutbox(event: OutboxWrite): Promise<void> {
    await this.client.outboxEvent.create({
      data: {
        id: event.id,
        aggregateId: event.aggregateId,
        type: event.type,
        version: event.version,
        occurredAt: event.occurredAt,
        traceId: event.traceId,
        correlationId: event.correlationId,
        ...(event.causationId ? { causationId: event.causationId } : {}),
        producer: event.producer,
        data: event.data as Prisma.InputJsonObject,
        dedupeKey: event.dedupeKey,
      },
    });
  }

  private get client(): TransactionClient | PrismaClient {
    return this.transactionClient ?? this.prisma;
  }
}

function mapUser(user: {
  id: string;
  phoneE164: string;
  nickname: string;
  status: string;
}): AccountUser {
  return user;
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function requestFingerprintFromJson(
  data: Prisma.JsonValue,
): { readonly digest: string; readonly keyVersion: string } | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const fingerprint = data['requestFingerprint'];
  const keyVersion = data['requestFingerprintKeyVersion'];
  return typeof fingerprint === 'string' && typeof keyVersion === 'string'
    ? { digest: fingerprint, keyVersion }
    : undefined;
}
