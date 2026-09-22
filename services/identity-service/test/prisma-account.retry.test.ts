import { Prisma } from '../src/generated/prisma/client.js';
import { describe, expect, it, vi } from 'vitest';

import { PrismaAccountMutationRepository } from '../src/adapters/prisma-account-mutation.repository.js';
import type { OutboxWrite } from '../src/application/identity-account.service.js';

function serializationError() {
  return new Prisma.PrismaClientKnownRequestError('serialization conflict', {
    code: 'P2034',
    clientVersion: '7.10.0',
  });
}

function uniqueError() {
  return new Prisma.PrismaClientKnownRequestError('unique conflict', {
    code: 'P2002',
    clientVersion: '7.10.0',
  });
}

describe('PrismaAccountMutationRepository serialization retries', () => {
  it('acquires operation and account locks before reading with a fresh READ COMMITTED snapshot', async () => {
    let committedOutboxVisible = false;
    let transactionOptions:
      | { readonly isolationLevel: unknown; readonly maxWait?: unknown; readonly timeout?: unknown }
      | undefined;
    const lockQueries: unknown[] = [];
    const transactionClient = {
      $queryRaw: (query: unknown) => {
        lockQueries.push(query);
        committedOutboxVisible = true;
        return Promise.resolve([{ locked: true }]);
      },
      outboxEvent: {
        findUnique: () =>
          Promise.resolve(
            transactionOptions?.isolationLevel === 'ReadCommitted' && committedOutboxVisible
              ? {
                  aggregateId: '0198fabc-1234-7abc-8abc-111111111111',
                  type: 'identity.user-phone-changed.v1',
                  data: {
                    requestFingerprint: 'a'.repeat(64),
                    requestFingerprintKeyVersion: 'v1',
                  },
                }
              : null,
          ),
      },
    };
    const prisma = {
      $transaction: async (
        work: (transaction: object) => Promise<boolean>,
        options: { isolationLevel: unknown; maxWait?: unknown; timeout?: unknown },
      ) => {
        transactionOptions = options;
        return work(transactionClient);
      },
    };
    const repository = new PrismaAccountMutationRepository(prisma as never);

    await expect(
      repository.transaction(
        {
          userId: '0198fabc-1234-7abc-8abc-111111111111',
          operationId: '0198fabc-1234-7abc-8abc-222222222222',
        },
        (transaction) =>
          transaction.getOperationResult({
            dedupeKey: 'phone-change:0198fabc-1234-7abc-8abc-222222222222',
            aggregateId: '0198fabc-1234-7abc-8abc-111111111111',
            type: 'identity.user-phone-changed.v1',
            requestFingerprints: [{ digest: 'a'.repeat(64), keyVersion: 'v1' }],
          }),
      ),
    ).resolves.toBe('completed');
    expect(transactionOptions).toMatchObject({
      isolationLevel: 'ReadCommitted',
      maxWait: 5_000,
      timeout: 10_000,
    });
    expect(lockQueries).toHaveLength(2);
    expect(lockQueries.map((query) => (query as { values: unknown[] }).values[0])).toEqual([
      'identity-account:0198fabc-1234-7abc-8abc-111111111111',
      'identity-operation:0198fabc-1234-7abc-8abc-222222222222',
    ]);
  });

  it('retries two P2034 conflicts before succeeding', async () => {
    let attempts = 0;
    const prisma = {
      $transaction: async (work: (transaction: object) => Promise<string>) => {
        attempts += 1;
        if (attempts < 3) throw serializationError();
        return work({});
      },
    };
    const repository = new PrismaAccountMutationRepository(prisma as never);

    await expect(repository.transaction(null, () => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(attempts).toBe(3);
  });

  it('maps a third P2034 conflict to a stable business error', async () => {
    let attempts = 0;
    const prisma = {
      $transaction: () => {
        attempts += 1;
        return Promise.reject(serializationError());
      },
    };
    const repository = new PrismaAccountMutationRepository(prisma as never);

    await expect(
      repository.transaction(null, () => Promise.resolve('never')),
    ).rejects.toMatchObject({ code: 'SERIALIZATION_RETRY_EXHAUSTED' });
    expect(attempts).toBe(3);
  });

  it('retries an operation-scoped P2002 so the next snapshot can resolve its result', async () => {
    let attempts = 0;
    const prisma = {
      $transaction: async (work: (transaction: object) => Promise<string>) => {
        attempts += 1;
        if (attempts === 1) throw uniqueError();
        return work({ $queryRaw: () => Promise.resolve([]) });
      },
    };
    const repository = new PrismaAccountMutationRepository(prisma as never);

    await expect(
      repository.transaction(
        {
          userId: '0198fabc-1234-7abc-8abc-111111111111',
          operationId: '0198fabc-1234-7abc-8abc-222222222222',
        },
        () => Promise.resolve('completed'),
      ),
    ).resolves.toBe('completed');
    expect(attempts).toBe(2);
  });

  it('serializes the same operation id even when callers use different accounts', async () => {
    const lockTails = new Map<string, Promise<void>>();
    const prisma = {
      $transaction: async (work: (transaction: object) => Promise<void>) => {
        const releases: Array<() => void> = [];
        const transaction = {
          $queryRaw: async (query: { values: unknown[] }) => {
            const key = String(query.values[0]);
            const previous = lockTails.get(key) ?? Promise.resolve();
            let release: () => void = () => undefined;
            const gate = new Promise<void>((resolve) => {
              release = resolve;
            });
            lockTails.set(
              key,
              previous.then(() => gate),
            );
            await previous;
            releases.push(release);
            return [];
          },
        };
        try {
          await work(transaction);
        } finally {
          for (const release of releases.reverse()) release();
        }
      },
    };
    const repository = new PrismaAccountMutationRepository(prisma as never);
    const operationId = '0198fabc-1234-7abc-8abc-222222222222';
    let active = 0;
    let maxActive = 0;
    const work = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    };

    await Promise.all([
      repository.transaction({ userId: '0198fabc-1234-7abc-8abc-111111111111', operationId }, work),
      repository.transaction({ userId: '0198fabc-1234-7abc-8abc-333333333333', operationId }, work),
    ]);

    expect(maxActive).toBe(1);
  });
});

describe('PrismaAccountMutationRepository persistence methods', () => {
  it('distinguishes a completed operation from a reused idempotency key', async () => {
    const client = {
      outboxEvent: {
        findUnique: vi.fn().mockResolvedValue({
          aggregateId: '0198fabc-1234-7abc-8abc-111111111111',
          type: 'identity.user-phone-changed.v1',
          data: {
            requestFingerprint: 'a'.repeat(64),
            requestFingerprintKeyVersion: 'v1',
          },
        }),
      },
    };
    const repository = new PrismaAccountMutationRepository({} as never, client as never);
    const expectation = {
      dedupeKey: 'phone-change:0198fabc-1234-7abc-8abc-222222222222',
      aggregateId: '0198fabc-1234-7abc-8abc-111111111111',
      type: 'identity.user-phone-changed.v1' as const,
      requestFingerprints: [{ digest: 'a'.repeat(64), keyVersion: 'v1' }],
    };

    await expect(repository.getOperationResult(expectation)).resolves.toBe('completed');
    await expect(
      repository.getOperationResult({
        ...expectation,
        requestFingerprints: [{ digest: 'b'.repeat(64), keyVersion: 'v2' }],
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('finds or creates ACTIVE users without exposing a duplicate registration', async () => {
    const existing = {
      id: '0198fabc-1234-7abc-8abc-111111111111',
      phoneE164: '+8613800138000',
      nickname: 'existing',
      status: 'ACTIVE',
    };
    const transactionClient = {
      user: {
        findUnique: vi.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(null),
        create: vi.fn().mockResolvedValue({ ...existing, nickname: 'created' }),
      },
    };
    const prisma = {
      $transaction: (work: (client: object) => Promise<unknown>) => work(transactionClient),
      user: { findUnique: vi.fn() },
    };
    const repository = new PrismaAccountMutationRepository(prisma as never);

    await expect(
      repository.findOrCreateActiveUserByPhone(existing.phoneE164, {
        id: existing.id,
        nickname: 'ignored',
      }),
    ).resolves.toMatchObject({ nickname: 'existing' });
    await expect(
      repository.findOrCreateActiveUserByPhone('+8613900139000', {
        id: existing.id,
        nickname: 'created',
      }),
    ).resolves.toMatchObject({ nickname: 'created' });
  });

  it('maps closed registration and phone uniqueness conflicts to stable errors', async () => {
    const closed = {
      id: '0198fabc-1234-7abc-8abc-111111111111',
      phoneE164: '+8613800138000',
      nickname: 'closed',
      status: 'CLOSED',
    };
    const transactionClient = {
      user: { findUnique: vi.fn().mockResolvedValue(closed), create: vi.fn() },
    };
    const prisma = {
      $transaction: (work: (client: object) => Promise<unknown>) => work(transactionClient),
      user: { findUnique: vi.fn().mockResolvedValue(closed) },
    };
    const repository = new PrismaAccountMutationRepository(prisma as never);
    await expect(
      repository.findOrCreateActiveUserByPhone(closed.phoneE164, {
        id: closed.id,
        nickname: 'new',
      }),
    ).rejects.toMatchObject({ code: 'USER_INACTIVE' });

    const txAdapter = new PrismaAccountMutationRepository(
      {} as never,
      { user: { update: () => Promise.reject(uniqueError()) } } as never,
    );
    await expect(txAdapter.updatePhone(closed.id, '+8613900139000')).rejects.toMatchObject({
      code: 'PHONE_ALREADY_IN_USE',
    });
  });

  it('handles a concurrent registration P2002 by returning the winning ACTIVE user', async () => {
    const winner = {
      id: '0198fabc-1234-7abc-8abc-111111111111',
      phoneE164: '+8613800138000',
      nickname: 'winner',
      status: 'ACTIVE',
    };
    const prisma = {
      $transaction: () => Promise.reject(uniqueError()),
      user: { findUnique: vi.fn().mockResolvedValue(winner) },
    };
    const repository = new PrismaAccountMutationRepository(prisma as never);
    await expect(
      repository.findOrCreateActiveUserByPhone(winner.phoneE164, {
        id: '0198fabc-1234-7abc-8abc-222222222222',
        nickname: 'loser',
      }),
    ).resolves.toMatchObject({ id: winner.id });
  });

  it('persists account mutations and the complete outbox envelope', async () => {
    const user = {
      id: '0198fabc-1234-7abc-8abc-111111111111',
      phoneE164: '+8613800138000',
      nickname: 'user',
      status: 'ACTIVE',
    };
    const client = {
      user: {
        findFirst: vi.fn().mockResolvedValue(user),
        count: vi.fn().mockResolvedValue(0),
        update: vi.fn().mockResolvedValue(user),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      session: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      outboxEvent: {
        findUnique: vi.fn().mockResolvedValue({
          aggregateId: user.id,
          type: 'identity.user-closed.v1',
          data: {
            requestFingerprint: 'a'.repeat(64),
            requestFingerprintKeyVersion: 'v1',
          },
        }),
        create: vi.fn().mockResolvedValue({}),
      },
    };
    const repository = new PrismaAccountMutationRepository({} as never, client as never);
    await expect(repository.getActiveUser(user.id)).resolves.toMatchObject({ id: user.id });
    await expect(repository.isPhoneAvailable('+8613900139000', user.id)).resolves.toBe(true);
    await repository.updatePhone(user.id, '+8613900139000');
    await repository.updateNickname(user.id, 'updated');
    await expect(repository.closeUser(user.id)).resolves.toBe(true);
    await repository.revokeAllSessions(user.id, new Date('2026-09-01T00:00:00Z'));
    await expect(
      repository.getOperationResult({
        dedupeKey: 'operation',
        aggregateId: user.id,
        type: 'identity.user-closed.v1',
        requestFingerprints: [{ digest: 'a'.repeat(64), keyVersion: 'v1' }],
      }),
    ).resolves.toBe('completed');
    const event: OutboxWrite = {
      id: '0198fabc-1234-7abc-8abc-222222222222',
      aggregateId: user.id,
      type: 'identity.user-closed.v1',
      version: 1,
      occurredAt: new Date('2026-09-01T00:00:00Z'),
      traceId: '0123456789abcdef0123456789abcdef',
      correlationId: '0198fabc-1234-7abc-8abc-333333333333',
      causationId: '0198fabc-1234-7abc-8abc-444444444444',
      producer: 'identity-service',
      data: {
        userId: user.id,
        requestFingerprint: 'a'.repeat(64),
        requestFingerprintKeyVersion: 'v1',
      },
      dedupeKey: 'operation',
    };
    await repository.appendOutbox(event);
    const persisted: unknown = client.outboxEvent.create.mock.calls[0]?.[0];
    expect(persisted).toMatchObject({
      data: {
        id: event.id,
        version: 1,
        traceId: event.traceId,
        correlationId: event.correlationId,
        causationId: event.causationId,
        producer: 'identity-service',
        data: { userId: user.id },
        dedupeKey: event.dedupeKey,
      },
    });
  });
});
