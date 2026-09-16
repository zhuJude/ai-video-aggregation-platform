/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import type { SagaWrite } from '../src/application/provider-events.consumer.js';
import { PrismaProviderEventRepository } from '../src/infrastructure/prisma-provider-event.repository.js';

const TASK_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0';
const USER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2';
const MESSAGE_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51c0';
const REPAIR_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51c1';
const OUTBOX_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51c2';
const NOW = new Date('2026-09-01T08:00:00.000Z');
const PAYLOAD_HASH = 'a'.repeat(64);
const LEASE = 'b'.repeat(64);

function durableTask() {
  return {
    id: TASK_ID,
    userId: USER_ID,
    quoteId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a3',
    status: 'RUNNING' as const,
    version: 4,
    capabilityVersionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4',
    parametersSnapshotSha256: 'f'.repeat(64),
    updatedAt: NOW,
    saga: {
      taskId: TASK_ID,
      version: 2,
      quotedPoints: '1200',
      settlementPoints: '900',
      providerAccepted: true,
      providerStateRank: 2,
      providerId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a5',
      providerTaskId: 'provider-task-1',
      modelCode: 'mock-video-v1',
      executionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b6',
      routeEpoch: 0,
      assetImportRequested: false,
      assetImportDispatched: false,
      assetId: null,
      routingFailoverAuthorized: false,
      cancellationChargePoints: null,
      cancelRequested: false,
      financialDisposition: null,
      financialSettlementKey: null,
      financialReleaseKey: null,
      substitute: null,
    },
  };
}

describe('PrismaProviderEventRepository', () => {
  it('claims an inbox lease and returns the durable task Saga in one transaction', async () => {
    const inboxCreate = vi.fn(async () => ({ id: MESSAGE_ID }));
    const taskFind = vi.fn(async () => durableTask());
    const transaction = {
      $executeRaw: vi.fn(async () => 1),
      inboxMessage: { create: inboxCreate },
      generationTask: { findUnique: taskFind },
    };
    const $transaction = vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) =>
      work(transaction),
    );
    const repository = new PrismaProviderEventRepository({
      $transaction,
    } as unknown as PrismaClient);

    await expect(
      repository.claim({
        consumer: 'generation-service:provider-events:v1',
        messageId: MESSAGE_ID,
        eventType: 'provider.execution-running.v1',
        payloadSha256: PAYLOAD_HASH,
        taskId: TASK_ID,
        receivedAt: NOW,
        leaseToken: LEASE,
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      }),
    ).resolves.toMatchObject({
      kind: 'CLAIMED',
      task: { taskId: TASK_ID, sagaVersion: 2, status: 'RUNNING', settlementPoints: '900' },
    });
    expect(inboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: MESSAGE_ID,
        consumer: 'generation-service:provider-events:v1',
        leaseToken: LEASE,
      }),
    });
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('does not let a different owner continue an unexpired pending Inbox delivery', async () => {
    const inboxUpdate = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      $transaction: vi.fn(async () => {
        throw Object.assign(new Error('unique constraint'), { code: 'P2002' });
      }),
      inboxMessage: {
        findUnique: vi.fn(async () => ({
          id: MESSAGE_ID,
          eventType: 'provider.execution-running.v1',
          payloadSha256: PAYLOAD_HASH,
          processedAt: null,
          leaseToken: 'c'.repeat(64),
          leaseExpiresAt: new Date(NOW.getTime() + 1),
        })),
        updateMany: inboxUpdate,
      },
      generationTask: { findUnique: vi.fn(async () => durableTask()) },
    };
    const repository = new PrismaProviderEventRepository(prisma as unknown as PrismaClient);

    await expect(
      repository.claim({
        consumer: 'generation-service:provider-events:v1',
        messageId: MESSAGE_ID,
        eventType: 'provider.execution-running.v1',
        payloadSha256: PAYLOAD_HASH,
        taskId: TASK_ID,
        receivedAt: NOW,
        leaseToken: LEASE,
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      }),
    ).resolves.toMatchObject({ kind: 'DUPLICATE_PENDING', task: { taskId: TASK_ID } });
    expect(inboxUpdate).not.toHaveBeenCalled();
  });

  it('atomically takes over an expired pending Inbox lease with a new owner token', async () => {
    const inboxUpdate = vi.fn(async () => ({ count: 1 }));
    const oldLease = 'c'.repeat(64);
    const oldExpiry = new Date(NOW.getTime() - 1);
    const prisma = {
      $transaction: vi.fn(async () => {
        throw Object.assign(new Error('unique constraint'), { code: 'P2002' });
      }),
      inboxMessage: {
        findUnique: vi.fn(async () => ({
          id: MESSAGE_ID,
          eventType: 'provider.execution-running.v1',
          payloadSha256: PAYLOAD_HASH,
          processedAt: null,
          leaseToken: oldLease,
          leaseExpiresAt: oldExpiry,
        })),
        updateMany: inboxUpdate,
      },
      generationTask: { findUnique: vi.fn(async () => durableTask()) },
    };
    const repository = new PrismaProviderEventRepository(prisma as unknown as PrismaClient);
    const nextExpiry = new Date(NOW.getTime() + 60_000);

    await expect(
      repository.claim({
        consumer: 'generation-service:provider-events:v1',
        messageId: MESSAGE_ID,
        eventType: 'provider.execution-running.v1',
        payloadSha256: PAYLOAD_HASH,
        taskId: TASK_ID,
        receivedAt: NOW,
        leaseToken: LEASE,
        leaseExpiresAt: nextExpiry,
      }),
    ).resolves.toMatchObject({ kind: 'CLAIMED', task: { taskId: TASK_ID } });
    expect(inboxUpdate).toHaveBeenCalledWith({
      where: {
        id: MESSAGE_ID,
        processedAt: null,
        leaseToken: oldLease,
        leaseExpiresAt: oldExpiry,
      },
      data: { leaseToken: LEASE, leaseExpiresAt: nextExpiry },
    });
  });

  it('renews only the current unexpired owner using database-server time', async () => {
    const executeRaw = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const repository = new PrismaProviderEventRepository({
      $executeRaw: executeRaw,
    } as unknown as PrismaClient);
    const input = {
      messageId: MESSAGE_ID,
      payloadSha256: PAYLOAD_HASH,
      leaseToken: LEASE,
      leaseDurationMs: 60_000,
    };

    await expect(repository.renewLease(input)).resolves.toEqual({ kind: 'RENEWED' });
    await expect(repository.renewLease(input)).resolves.toEqual({ kind: 'FENCED' });
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it('atomically fences task/Saga, records transition, operator case/outbox, and completes inbox', async () => {
    const taskUpdate = vi.fn(async () => ({ count: 1 }));
    const sagaUpdate = vi.fn(async () => ({ count: 1 }));
    const transitionCreate = vi.fn(async () => ({ count: 1 }));
    const caseUpsert = vi.fn(async () => ({ id: REPAIR_ID }));
    const outboxCreate = vi.fn(async () => ({ id: OUTBOX_ID }));
    const inboxUpdate = vi.fn(async () => ({ count: 1 }));
    const taskFind = vi.fn(async () => ({
      ...durableTask(),
      status: 'SUCCEEDED' as const,
      version: 5,
      saga: { ...durableTask().saga, version: 3, assetImportRequested: true },
    }));
    const transaction = {
      $executeRaw: vi.fn(async () => 1),
      generationTask: { updateMany: taskUpdate, findUnique: taskFind },
      taskSaga: { updateMany: sagaUpdate },
      taskTransition: { createMany: transitionCreate },
      taskRepairCase: { upsert: caseUpsert },
      outboxEvent: { create: outboxCreate },
      inboxMessage: { updateMany: inboxUpdate },
    };
    const $transaction = vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) =>
      work(transaction),
    );
    const repository = new PrismaProviderEventRepository({
      $transaction,
    } as unknown as PrismaClient);
    const write: SagaWrite = {
      messageId: MESSAGE_ID,
      payloadSha256: PAYLOAD_HASH,
      leaseToken: LEASE,
      taskId: TASK_ID,
      expectedVersion: 4,
      expectedSagaVersion: 2,
      patch: { status: 'SUCCEEDED', assetImportRequested: true },
      transitions: [
        {
          id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c3',
          fromStatus: 'RUNNING',
          toStatus: 'SUCCEEDED',
          taskVersion: 5,
          reasonCode: 'PROVIDER_SUCCEEDED',
          source: 'WORKER',
          actorType: 'PROVIDER',
          actorId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a5',
          traceId: 'c'.repeat(32),
          metadata: { messageId: MESSAGE_ID },
          createdAt: NOW,
        },
      ],
      occurredAt: NOW,
      committedAt: NOW,
      completeMessage: true,
      operatorCase: {
        id: REPAIR_ID,
        kind: 'TEST_CASE',
        summary: 'test operator case',
        evidence: { messageId: MESSAGE_ID },
        deduplicationKey: `task:${TASK_ID}:test-case`,
      },
      outbox: {
        id: OUTBOX_ID,
        eventType: 'generation.task-queued.v1',
        deduplicationKey: `task:${TASK_ID}:failover:v4`,
        payload: { taskId: TASK_ID },
        headers: { traceId: 'c'.repeat(32) },
        occurredAt: NOW,
        availableAt: NOW,
      },
    };

    await expect(repository.write(write)).resolves.toMatchObject({
      kind: 'APPLIED',
      task: { status: 'SUCCEEDED', sagaVersion: 3 },
    });

    expect(taskUpdate).toHaveBeenCalledWith({
      where: { id: TASK_ID, version: 4 },
      data: { status: 'SUCCEEDED', version: 5, updatedAt: NOW },
    });
    expect(sagaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskId: TASK_ID, version: 2 },
        data: expect.objectContaining({ version: { increment: 1 }, assetImportRequested: true }),
      }),
    );
    expect(transitionCreate).toHaveBeenCalledTimes(1);
    expect(caseUpsert).toHaveBeenCalledWith({
      where: { deduplicationKey: `task:${TASK_ID}:test-case` },
      create: expect.objectContaining({ deduplicationKey: `task:${TASK_ID}:test-case` }),
      update: {},
    });
    expect(outboxCreate).toHaveBeenCalledTimes(1);
    expect(inboxUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          messageId: MESSAGE_ID,
          payloadSha256: PAYLOAD_HASH,
          leaseToken: LEASE,
          processedAt: null,
        }),
      }),
    );
  });

  it('rejects a stale Inbox owner when its lease token no longer owns completion', async () => {
    const inboxUpdate = vi.fn(async () => ({ count: 0 }));
    const transaction = {
      $executeRaw: vi.fn(async () => 0),
      generationTask: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => durableTask()),
      },
      taskSaga: { updateMany: vi.fn(async () => ({ count: 1 })) },
      taskTransition: { createMany: vi.fn(async () => ({ count: 0 })) },
      taskRepairCase: { create: vi.fn(), upsert: vi.fn() },
      outboxEvent: { create: vi.fn() },
      inboxMessage: { updateMany: inboxUpdate },
    };
    const repository = new PrismaProviderEventRepository({
      $transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) =>
        work(transaction),
      ),
    } as unknown as PrismaClient);

    await expect(
      repository.write({
        messageId: MESSAGE_ID,
        payloadSha256: PAYLOAD_HASH,
        leaseToken: LEASE,
        taskId: TASK_ID,
        expectedVersion: 4,
        expectedSagaVersion: 2,
        patch: {},
        transitions: [],
        occurredAt: NOW,
        committedAt: NOW,
        completeMessage: true,
      }),
    ).resolves.toEqual({ kind: 'STALE' });
    expect(inboxUpdate).not.toHaveBeenCalled();
  });

  it('fences an expired owner before any intermediate task, Saga, or outbox mutation', async () => {
    const inboxFence = vi.fn(async () => 0);
    const taskUpdate = vi.fn(async () => ({ count: 1 }));
    const sagaUpdate = vi.fn(async () => ({ count: 1 }));
    const outboxCreate = vi.fn(async () => ({ id: OUTBOX_ID }));
    const transaction = {
      $executeRaw: inboxFence,
      inboxMessage: { updateMany: vi.fn() },
      generationTask: { updateMany: taskUpdate, findUnique: vi.fn(async () => durableTask()) },
      taskSaga: { updateMany: sagaUpdate },
      taskTransition: { createMany: vi.fn() },
      taskRepairCase: { create: vi.fn(), upsert: vi.fn() },
      outboxEvent: { create: outboxCreate },
    };
    const repository = new PrismaProviderEventRepository({
      $transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) =>
        work(transaction),
      ),
    } as unknown as PrismaClient);

    await expect(
      repository.write({
        messageId: MESSAGE_ID,
        payloadSha256: PAYLOAD_HASH,
        leaseToken: LEASE,
        taskId: TASK_ID,
        expectedVersion: 4,
        expectedSagaVersion: 2,
        patch: { assetImportRequested: true },
        transitions: [],
        occurredAt: NOW,
        committedAt: NOW,
        completeMessage: false,
        outbox: {
          id: OUTBOX_ID,
          eventType: 'generation.asset-import-requested.v1',
          deduplicationKey: `task:${TASK_ID}:asset-import`,
          payload: { taskId: TASK_ID },
          headers: { traceId: 'c'.repeat(32) },
          occurredAt: NOW,
          availableAt: NOW,
        },
      }),
    ).resolves.toEqual({ kind: 'STALE' });

    expect(inboxFence).toHaveBeenCalledTimes(1);
    expect(taskUpdate).not.toHaveBeenCalled();
    expect(sagaUpdate).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
  });

  it('maps durable open repair kinds to bounded categories and keeps financial phases exclusive', async () => {
    const taskFindFirst = vi.fn().mockResolvedValue(null);
    const repairGroupBy = vi.fn().mockResolvedValue([
      { kind: 'PROVIDER_ACCEPTANCE_OR_BILLING_AMBIGUOUS', _count: { _all: 2 } },
      { kind: 'TASK_CREATION_FINANCIAL_UNCERTAIN', _count: { _all: 3 } },
      { kind: 'REPAIR_TASK_ERROR', _count: { _all: 4 } },
    ]);
    const repository = new PrismaProviderEventRepository({
      taskRepairCase: { groupBy: repairGroupBy },
      generationTask: { findFirst: taskFindFirst },
    } as unknown as PrismaClient);

    await expect(repository.repairMetricsSnapshot({ now: NOW, deadlinesMs: {} })).resolves.toEqual({
      repairCases: {
        AMBIGUOUS_PROVIDER_RESULT: 2,
        FINANCIAL_EFFECT_PENDING: 3,
        STALE_STATUS: 4,
      },
      financialSagaLag: { ASSET_IMPORT: 0, RELEASE: 0, SETTLEMENT: 0 },
    });

    const settlementFilter = {
      status: { notIn: ['SETTLED', 'REFUNDED'] },
      saga: {
        is: {
          financialDisposition: 'SUCCESS_SETTLEMENT',
          NOT: { assetImportRequested: true, assetId: null },
        },
      },
    };
    expect(repairGroupBy).toHaveBeenCalledWith({
      by: ['kind'],
      where: { status: { in: ['OPEN', 'IN_PROGRESS'] } },
      _count: { _all: true },
    });
    expect(taskFindFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: settlementFilter }),
    );
  });
});
