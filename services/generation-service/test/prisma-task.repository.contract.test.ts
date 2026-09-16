/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
  type IdempotencyClaim,
  type PersistTaskInput,
  type RepairRequiredInput,
} from '../src/application/create-task.service.js';
import { PrismaTaskRepository } from '../src/infrastructure/prisma-task.repository.js';

const USER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2';
const QUOTE_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a3';
const CAPABILITY_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4';
const TASK_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0';
const IDEMPOTENCY_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b1';
const TRANSITION_A = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b2';
const TRANSITION_B = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b3';
const EVENT_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b4';
const REPAIR_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b5';
const NOW = new Date('2026-08-31T08:00:00.000Z');
const EXPIRES_AT = new Date('2026-08-31T08:05:00.000Z');
const LEASE = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);

function claim(): IdempotencyClaim {
  return {
    id: IDEMPOTENCY_ID,
    userId: USER_ID,
    idempotencyKey: 'idem-1',
    requestSha256: FINGERPRINT,
    proposedTaskId: TASK_ID,
    quotedPoints: '1200',
    reserveBusinessKey: `task:${TASK_ID}:reserve`,
    compensationBusinessKey: `task:${TASK_ID}:create-compensation`,
    traceId: 'c'.repeat(32),
    leaseToken: LEASE,
    phase: 'CLAIMED',
    createdAt: NOW,
    expiresAt: EXPIRES_AT,
  };
}

function persistedRecord() {
  return {
    ...claim(),
    status: 'IN_PROGRESS' as const,
    response: null,
    taskId: null,
  };
}

function persistInput(): PersistTaskInput {
  const transitionBase = {
    source: 'API' as const,
    actorType: 'USER' as const,
    actorId: USER_ID,
    traceId: 'c'.repeat(32),
    metadata: { quoteId: QUOTE_ID },
    createdAt: NOW,
  };
  return {
    taskId: TASK_ID,
    userId: USER_ID,
    idempotencyKey: 'idem-1',
    requestSha256: FINGERPRINT,
    leaseToken: LEASE,
    quoteId: QUOTE_ID,
    capabilityVersionId: CAPABILITY_ID,
    status: 'QUEUED',
    version: 2,
    quoteSnapshot: { id: QUOTE_ID },
    quoteSnapshotSha256: 'd'.repeat(64),
    capabilitySnapshot: { id: CAPABILITY_ID },
    capabilitySnapshotSha256: 'e'.repeat(64),
    pricingSnapshot: { quotedPoints: '1200' },
    pricingSnapshotSha256: 'f'.repeat(64),
    parametersSnapshot: { prompt: 'ocean' },
    parametersSnapshotSha256: '1'.repeat(64),
    transitions: [
      {
        ...transitionBase,
        id: TRANSITION_A,
        fromStatus: 'QUOTED',
        toStatus: 'RESERVED',
        taskVersion: 1,
        reasonCode: 'POINTS_RESERVED',
      },
      {
        ...transitionBase,
        id: TRANSITION_B,
        fromStatus: 'RESERVED',
        toStatus: 'QUEUED',
        taskVersion: 2,
        reasonCode: 'TASK_CREATED',
      },
    ],
    event: {
      id: EVENT_ID,
      type: 'generation.task-queued.v1',
      version: 1,
      occurredAt: NOW.toISOString(),
      traceId: 'c'.repeat(32),
      correlationId: TASK_ID,
      causationId: QUOTE_ID,
      producer: 'generation-service',
      data: { taskId: TASK_ID, status: 'QUEUED' },
    },
    createdAt: NOW,
  };
}

describe('PrismaTaskRepository generated-client contract', () => {
  it('interprets only a P2002 claim conflict and reads the compound owner key', async () => {
    const conflict = Object.assign(new Error('unique'), { code: 'P2002' });
    const create = vi.fn(async () => Promise.reject(conflict));
    const findUnique = vi.fn(async () => persistedRecord());
    const repository = new PrismaTaskRepository({
      taskIdempotency: { create, findUnique },
    } as unknown as PrismaClient);

    await expect(repository.claimIdempotency(claim())).resolves.toMatchObject({
      id: IDEMPOTENCY_ID,
      leaseToken: LEASE,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { userId_idempotencyKey: { userId: USER_ID, idempotencyKey: 'idem-1' } },
    });

    create.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'P1001' }));
    await expect(repository.claimIdempotency(claim())).rejects.toMatchObject({ code: 'P1001' });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('uses the full expired CLAIMED lease-token compare-and-set for reclaim', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const repository = new PrismaTaskRepository({
      taskIdempotency: { updateMany },
    } as unknown as PrismaClient);
    const newLease = '9'.repeat(64);
    const nextExpiry = new Date('2026-08-31T09:00:00.000Z');

    await expect(
      repository.tryReclaimIdempotency({
        userId: USER_ID,
        idempotencyKey: 'idem-1',
        requestSha256: FINGERPRINT,
        now: EXPIRES_AT,
        expiresAt: nextExpiry,
        expectedLeaseToken: LEASE,
        newLeaseToken: newLease,
      }),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        idempotencyKey: 'idem-1',
        requestSha256: FINGERPRINT,
        status: 'IN_PROGRESS',
        phase: 'CLAIMED',
        leaseToken: LEASE,
        expiresAt: { lte: EXPIRES_AT },
      },
      data: { expiresAt: nextExpiry, leaseToken: newLease },
    });
  });

  it('groups task, transitions, outbox, and fenced idempotency success atomically', async () => {
    const generationTaskCreate = vi.fn(async () => ({ id: TASK_ID }));
    const outboxCreate = vi.fn(async () => ({ id: EVENT_ID }));
    const idempotencyUpdate = vi.fn(async () => ({ count: 1 }));
    let committed = false;
    const transaction = {
      generationTask: { create: generationTaskCreate },
      outboxEvent: { create: outboxCreate },
      taskIdempotency: { updateMany: idempotencyUpdate },
    };
    const $transaction = vi.fn(async (work: (client: typeof transaction) => Promise<void>) => {
      await work(transaction);
      committed = true;
    });
    const repository = new PrismaTaskRepository({ $transaction } as unknown as PrismaClient);

    await expect(repository.persistTask(persistInput())).resolves.toEqual({
      taskId: TASK_ID,
      status: 'QUEUED',
      version: 2,
    });
    expect(committed).toBe(true);
    expect(generationTaskCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: TASK_ID,
          transitions: {
            create: expect.arrayContaining([
              expect.objectContaining({ taskVersion: 1 }),
              expect.objectContaining({ taskVersion: 2 }),
            ]),
          },
          saga: {
            create: expect.objectContaining({
              quotedPoints: '1200',
              settlementPoints: '1200',
              providerAccepted: false,
              routingFailoverAuthorized: false,
            }),
          },
        }),
      }),
    );
    expect(outboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aggregateId: TASK_ID,
          eventType: 'generation.task-queued.v1',
          deduplicationKey: `task:${TASK_ID}:queued:v2`,
        }),
      }),
    );
    expect(idempotencyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: USER_ID,
          idempotencyKey: 'idem-1',
          requestSha256: FINGERPRINT,
          leaseToken: LEASE,
          phase: 'RESERVED',
          status: 'IN_PROGRESS',
        }),
      }),
    );
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('rejects the whole task transaction when fenced success finalization loses ownership', async () => {
    const staged: string[] = [];
    let committed: readonly string[] = [];
    const transaction = {
      generationTask: { create: vi.fn(async () => void staged.push('task')) },
      outboxEvent: { create: vi.fn(async () => void staged.push('outbox')) },
      taskIdempotency: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    const $transaction = vi.fn(async (work: (client: typeof transaction) => Promise<void>) => {
      await work(transaction);
      committed = [...staged];
    });
    const repository = new PrismaTaskRepository({ $transaction } as unknown as PrismaClient);

    await expect(repository.persistTask(persistInput())).rejects.toThrow(
      'IDEMPOTENCY_FINALIZATION_CONFLICT',
    );
    expect(staged).toEqual(['task', 'outbox']);
    expect(committed).toEqual([]);
  });

  it('keeps repair evidence and REPAIR_REQUIRED finalization in one fenced transaction', async () => {
    const repair: RepairRequiredInput = {
      repairCaseId: REPAIR_ID,
      userId: USER_ID,
      idempotencyKey: 'idem-1',
      requestSha256: FINGERPRINT,
      leaseToken: LEASE,
      proposedTaskId: TASK_ID,
      quotedPoints: '1200',
      reserveBusinessKey: `task:${TASK_ID}:reserve`,
      compensationBusinessKey: `task:${TASK_ID}:create-compensation`,
      traceId: 'c'.repeat(32),
      phase: 'PERSISTENCE_FAILED',
      errorCode: 'TASK_CREATION_PHASE_STALLED',
      detectedAt: NOW,
    };
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const createRepair = vi.fn(async () => Promise.reject(new Error('repair insert failed')));
    let committed = false;
    const transaction = {
      taskIdempotency: {
        findUnique: vi.fn(async () => ({ id: IDEMPOTENCY_ID })),
        updateMany,
      },
      taskRepairCase: { create: createRepair },
    };
    const $transaction = vi.fn(async (work: (client: typeof transaction) => Promise<boolean>) => {
      const result = await work(transaction);
      committed = true;
      return result;
    });
    const repository = new PrismaTaskRepository({ $transaction } as unknown as PrismaClient);

    await expect(repository.recordRepairRequired(repair)).rejects.toThrow('repair insert failed');
    expect(committed).toBe(false);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: IDEMPOTENCY_ID,
          requestSha256: FINGERPRINT,
          leaseToken: LEASE,
          phase: 'PERSISTENCE_FAILED',
          status: 'IN_PROGRESS',
        }),
      }),
    );
    expect(createRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: null,
          idempotencyId: IDEMPOTENCY_ID,
          evidence: expect.objectContaining({
            reserveBusinessKey: `task:${TASK_ID}:reserve`,
            compensationBusinessKey: `task:${TASK_ID}:create-compensation`,
            phase: 'PERSISTENCE_FAILED',
          }),
        }),
      }),
    );
  });
});
