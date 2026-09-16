/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from 'vitest';
import type { ProviderCallbackError } from '../src/index.js';
import {
  PrismaCallbackRepository,
  PrismaPollRepository,
  ProviderPollingService,
  type ClaimPollInput,
  type CompletePollInput,
} from '../src/index.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

const PROVIDER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a7';
const EXECUTION_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0';
const TASK_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2';
const NOW = new Date('2026-08-31T12:00:00.000Z');

function callbackInput() {
  return {
    providerId: PROVIDER_ID,
    providerEventId: 'provider-event-3',
    providerTaskId: 'remote-1',
    sequence: 3,
    state: 'SUCCEEDED' as const,
    resultUrls: ['https://mock.invalid/result.mp4'],
    payloadSha256: 'a'.repeat(64),
    receivedAt: NOW,
    inboxId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c0',
    outboxId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c1',
  };
}

function callbackHarness(
  prior: {
    payloadSha256: string;
    providerTaskId: string;
    execution: { providerId: string };
  } | null = null,
) {
  const transaction = {
    callbackInbox: {
      findUnique: vi.fn().mockResolvedValue(prior),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    providerExecution: {
      findUnique: vi.fn().mockResolvedValue({
        id: EXECUTION_ID,
        taskId: TASK_ID,
        status: 'RUNNING',
        currentAttempt: 2,
        lastProviderSequence: 2,
        version: 4,
        traceId: '0123456789abcdef0123456789abcdef',
        correlationId: TASK_ID,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    providerAttempt: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    outboxEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const callbackInbox = {
    findUnique: vi.fn().mockResolvedValue(prior),
  };
  const prisma = {
    callbackInbox,
    $transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as PrismaClient;
  return { prisma, subject: new PrismaCallbackRepository(prisma), transaction };
}

describe('Prisma callback atomicity', () => {
  it('commits callback inbox, execution, attempt and outbox in one transaction', async () => {
    const { prisma, subject, transaction } = callbackHarness();
    await expect(subject.apply(callbackInput())).resolves.toEqual({ kind: 'APPLIED' });
    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledOnce();
    expect(transaction.callbackInbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerId: PROVIDER_ID,
          providerEventId: 'provider-event-3',
        }),
      }),
    );
    expect(transaction.callbackInbox.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          providerId_providerEventId: {
            providerId: PROVIDER_ID,
            providerEventId: 'provider-event-3',
          },
        },
      }),
    );
    expect(transaction.providerExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SUCCEEDED', lastProviderSequence: 3 }),
      }),
    );
    expect(transaction.providerAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCEEDED' }) }),
    );
    expect(transaction.outboxEvent.create).toHaveBeenCalledOnce();
    expect(transaction.callbackInbox.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ outcome: 'APPLIED' }) }),
    );
  });

  it('deduplicates the same signed event and rejects a reused ID with different bytes', async () => {
    const duplicate = callbackHarness({
      payloadSha256: 'a'.repeat(64),
      providerTaskId: 'remote-1',
      execution: { providerId: PROVIDER_ID },
    });
    await expect(duplicate.subject.apply(callbackInput())).resolves.toEqual({ kind: 'DUPLICATE' });
    expect(duplicate.transaction.providerExecution.findUnique).not.toHaveBeenCalled();

    const conflict = callbackHarness({
      payloadSha256: 'b'.repeat(64),
      providerTaskId: 'remote-1',
      execution: { providerId: PROVIDER_ID },
    });
    await expect(conflict.subject.apply(callbackInput())).rejects.toEqual(
      expect.objectContaining<Partial<ProviderCallbackError>>({
        code: 'CALLBACK_EVENT_CONFLICT',
        statusCode: 409,
      }),
    );
  });

  it('does not let an event ID collision suppress another provider task', async () => {
    const collision = callbackHarness({
      payloadSha256: 'a'.repeat(64),
      providerTaskId: 'another-remote-task',
      execution: { providerId: PROVIDER_ID },
    });
    await expect(collision.subject.apply(callbackInput())).rejects.toMatchObject({
      code: 'CALLBACK_EVENT_CONFLICT',
      statusCode: 409,
    });
  });

  it('records an out-of-order callback without mutating execution or emitting outbox', async () => {
    const { subject, transaction } = callbackHarness();
    transaction.providerExecution.findUnique.mockResolvedValueOnce({
      id: EXECUTION_ID,
      taskId: TASK_ID,
      status: 'SUCCEEDED',
      currentAttempt: 2,
      lastProviderSequence: 3,
      version: 5,
      traceId: '0123456789abcdef0123456789abcdef',
      correlationId: TASK_ID,
    });
    await expect(
      subject.apply({ ...callbackInput(), sequence: 2, state: 'RUNNING' }),
    ).resolves.toEqual({ kind: 'OUT_OF_ORDER' });
    expect(transaction.providerExecution.updateMany).not.toHaveBeenCalled();
    expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
    expect(transaction.callbackInbox.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ outcome: 'OUT_OF_ORDER' }) }),
    );
  });
});

function pollInput(): ClaimPollInput {
  return {
    consumer: 'provider-runtime:execution-poll-due:v1',
    messageId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d0',
    eventType: 'provider.execution-poll-due.v1',
    payloadSha256: 'c'.repeat(64),
    executionId: EXECUTION_ID,
    taskId: TASK_ID,
    providerId: PROVIDER_ID,
    modelCode: 'internal-model-v1',
    providerTaskId: 'remote-1',
    attemptNumber: 2,
    pollNumber: 1,
    dueAt: NOW,
    receivedAt: NOW,
    leaseToken: 'd'.repeat(64),
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
  };
}

function pollHarness() {
  const inboxMessage = {
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const providerExecution = {
    findUnique: vi.fn().mockResolvedValue({
      id: EXECUTION_ID,
      taskId: TASK_ID,
      providerId: PROVIDER_ID,
      modelCode: 'internal-model-v1',
      providerTaskId: 'remote-1',
      status: 'RUNNING',
      currentAttempt: 2,
      pollCount: 0,
      version: 4,
      nextPollAt: NOW,
      pollLeaseToken: null,
      pollLeaseExpiresAt: null,
    }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const transaction = {
    inboxMessage,
    providerExecution,
    providerAttempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as PrismaClient;
  return { subject: new PrismaPollRepository(prisma), transaction };
}

describe('Prisma polling atomicity', () => {
  it('persists the inbox before claiming one due poll with optimistic fencing', async () => {
    const { subject, transaction } = pollHarness();
    await expect(subject.claim(pollInput())).resolves.toMatchObject({
      kind: 'CLAIMED',
      attemptNumber: 2,
      pollNumber: 1,
    });
    expect(transaction.inboxMessage.create).toHaveBeenCalledOnce();
    expect(transaction.providerExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          version: 4,
          status: 'RUNNING',
          currentAttempt: 2,
          pollCount: 0,
        }),
        data: expect.objectContaining({ pollLeaseToken: 'd'.repeat(64) }),
      }),
    );
  });

  it('re-reads a missed claim fence and completes the inbox when callback became terminal', async () => {
    const { subject, transaction } = pollHarness();
    transaction.providerExecution.findUnique
      .mockResolvedValueOnce({
        id: EXECUTION_ID,
        taskId: TASK_ID,
        providerId: PROVIDER_ID,
        modelCode: 'internal-model-v1',
        providerTaskId: 'remote-1',
        status: 'RUNNING',
        currentAttempt: 2,
        pollCount: 0,
        nextPollAt: NOW,
        pollLeaseToken: null,
        pollLeaseExpiresAt: null,
        version: 4,
      })
      .mockResolvedValueOnce({
        id: EXECUTION_ID,
        taskId: TASK_ID,
        providerId: PROVIDER_ID,
        modelCode: 'internal-model-v1',
        providerTaskId: 'remote-1',
        status: 'SUCCEEDED',
        currentAttempt: 2,
        pollCount: 0,
        nextPollAt: null,
        pollLeaseToken: null,
        pollLeaseExpiresAt: null,
        version: 5,
      });
    transaction.providerExecution.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(subject.claim(pollInput())).resolves.toEqual({ kind: 'TERMINAL' });
    expect(transaction.inboxMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { processedAt: NOW, lastError: 'TERMINAL' } }),
    );
  });

  it('never calls queryTask when a terminal callback commits between poll claim read and write', async () => {
    const { subject, transaction } = pollHarness();
    transaction.providerExecution.findUnique
      .mockResolvedValueOnce({
        id: EXECUTION_ID,
        taskId: TASK_ID,
        providerId: PROVIDER_ID,
        modelCode: 'internal-model-v1',
        providerTaskId: 'remote-1',
        status: 'RUNNING',
        currentAttempt: 2,
        pollCount: 0,
        nextPollAt: NOW,
        pollLeaseToken: null,
        pollLeaseExpiresAt: null,
        version: 4,
      })
      .mockResolvedValueOnce({
        id: EXECUTION_ID,
        taskId: TASK_ID,
        providerId: PROVIDER_ID,
        modelCode: 'internal-model-v1',
        providerTaskId: 'remote-1',
        status: 'SUCCEEDED',
        currentAttempt: 2,
        pollCount: 0,
        nextPollAt: null,
        pollLeaseToken: null,
        pollLeaseExpiresAt: null,
        version: 5,
      });
    transaction.providerExecution.updateMany.mockResolvedValueOnce({ count: 0 });
    const queryTask = vi.fn();
    const service = new ProviderPollingService({
      repository: subject,
      adapters: { resolve: vi.fn().mockResolvedValue({ queryTask }) },
      circuit: {
        acquire: vi.fn(),
        record: vi.fn(),
        tripImmediately: vi.fn(),
      },
      clock: { now: () => NOW },
      ids: { next: () => '0198f4d4-21c2-7b7d-8a03-08a0da2a51ff' },
    });
    await expect(
      service.handle({
        id: pollInput().messageId,
        type: 'provider.execution-poll-due.v1',
        version: 1,
        occurredAt: NOW.toISOString(),
        traceId: '0123456789abcdef0123456789abcdef',
        correlationId: TASK_ID,
        producer: 'provider-runtime',
        data: {
          executionId: EXECUTION_ID,
          taskId: TASK_ID,
          providerId: PROVIDER_ID,
          modelCode: 'internal-model-v1',
          providerTaskId: 'remote-1',
          attemptNumber: 2,
          pollNumber: 1,
          dueAt: NOW.toISOString(),
        },
      }),
    ).resolves.toEqual({ ack: true, outcome: 'TERMINAL' });
    expect(queryTask).not.toHaveBeenCalled();
  });

  it('atomically advances the poll number, emits the next poll and completes its inbox', async () => {
    const { subject, transaction } = pollHarness();
    transaction.inboxMessage.findUnique.mockResolvedValueOnce({
      payloadSha256: 'c'.repeat(64),
      processedAt: null,
    });
    transaction.providerExecution.findUnique.mockResolvedValueOnce({
      id: EXECUTION_ID,
      status: 'ACCEPTED',
      currentAttempt: 2,
      pollCount: 0,
      pollLeaseToken: 'd'.repeat(64),
      version: 4,
    });
    const nextPollAt = new Date(NOW.getTime() + 30_000);
    const input: CompletePollInput = {
      ...pollInput(),
      state: 'RUNNING',
      completedAt: NOW,
      stateOutbox: {
        id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d1',
        aggregateId: TASK_ID,
        eventType: 'provider.execution-running.v1',
        eventVersion: 1,
        deduplicationKey: 'poll-state',
        payload: {},
        headers: {},
        occurredAt: NOW,
        availableAt: NOW,
      },
      nextPollAt,
      nextPollOutbox: {
        id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d2',
        aggregateId: TASK_ID,
        eventType: 'provider.execution-poll-due.v1',
        eventVersion: 1,
        deduplicationKey: 'poll-next',
        payload: {},
        headers: {},
        occurredAt: NOW,
        availableAt: nextPollAt,
      },
    };
    await subject.complete(input);
    expect(transaction.providerExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'RUNNING', pollCount: 1, nextPollAt }),
      }),
    );
    expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(2);
    expect(transaction.inboxMessage.updateMany).toHaveBeenCalledOnce();
  });

  it('re-reads after a callback wins the version fence and never regresses terminal state', async () => {
    const { subject, transaction } = pollHarness();
    transaction.inboxMessage.findUnique.mockResolvedValueOnce({
      payloadSha256: 'c'.repeat(64),
      processedAt: null,
    });
    transaction.providerExecution.findUnique
      .mockResolvedValueOnce({
        id: EXECUTION_ID,
        status: 'RUNNING',
        currentAttempt: 2,
        pollCount: 0,
        pollLeaseToken: 'd'.repeat(64),
        version: 4,
      })
      .mockResolvedValueOnce({
        id: EXECUTION_ID,
        status: 'SUCCEEDED',
        currentAttempt: 2,
        pollCount: 0,
        pollLeaseToken: null,
        version: 5,
      });
    transaction.providerExecution.updateMany.mockResolvedValueOnce({ count: 0 });
    await subject.complete({
      ...pollInput(),
      state: 'RUNNING',
      completedAt: NOW,
      stateOutbox: {
        id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d1',
        aggregateId: TASK_ID,
        eventType: 'provider.execution-running.v1',
        eventVersion: 1,
        deduplicationKey: 'poll-state',
        payload: {},
        headers: {},
        occurredAt: NOW,
        availableAt: NOW,
      },
    });
    expect(transaction.providerExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ version: 4, status: 'RUNNING' }),
      }),
    );
    expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
    expect(transaction.providerAttempt.updateMany).not.toHaveBeenCalled();
    expect(transaction.inboxMessage.updateMany).toHaveBeenCalledOnce();
  });
});
