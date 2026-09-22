/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it, vi } from 'vitest';
import type {
  BeginExecutionInput,
  ClaimRetryInput,
  CommitAmbiguityInput,
  CompleteExecutionInput,
  RecordLateResultInput,
} from '../src/application/execution.service.js';
import {
  PrismaExecutionRepository,
  type ProviderRuntimePrismaClient,
  type ProviderRuntimePrismaTransaction,
} from '../src/infrastructure/prisma-execution.repository.js';

const NOW = new Date('2026-08-31T12:00:00.000Z');

function beginInput(): BeginExecutionInput {
  return {
    consumer: 'provider-runtime:generation-task-queued:v1',
    messageId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a6',
    eventType: 'generation.task-queued.v1',
    payloadSha256: 'a'.repeat(64),
    executionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
    attemptId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b1',
    taskId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
    routeEpoch: 0,
    failoverAuthorized: false,
    capabilityVersionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a5',
    parametersSnapshotSha256: 'b'.repeat(64),
    providerId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a7',
    modelCode: 'internal-model-v1',
    idempotencyKey: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
    traceId: '0123456789abcdef0123456789abcdef',
    correlationId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
    receivedAt: NOW,
    leaseToken: 'c'.repeat(64),
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    takeoverOutbox: {
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b3',
      aggregateId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
      eventType: 'provider.execution-ambiguous.v1',
      eventVersion: 1,
      deduplicationKey: 'takeover-1',
      payload: { taskId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2' },
      headers: {},
      occurredAt: NOW,
      availableAt: NOW,
    },
    bindingMismatchOutbox: {
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b4',
      aggregateId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
      eventType: 'provider.security-binding-rejected.v1',
      eventVersion: 1,
      deduplicationKey: 'binding-mismatch-1',
      payload: { taskId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2' },
      headers: {},
      occurredAt: NOW,
      availableAt: NOW,
    },
  };
}

function failoverInput(
  overrides: Partial<BeginExecutionInput> = {},
  includePriorExecution = true,
): BeginExecutionInput {
  const original = beginInput();
  return {
    ...original,
    messageId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d0',
    executionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d1',
    attemptId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d2',
    routeEpoch: 1,
    failoverAuthorized: true,
    ...(includePriorExecution ? { priorExecutionId: original.executionId } : {}),
    providerId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d3',
    modelCode: 'substitute-model-v1',
    ...overrides,
  };
}

function completeInput(): CompleteExecutionInput {
  const input = beginInput();
  return {
    consumer: input.consumer,
    messageId: input.messageId,
    payloadSha256: input.payloadSha256,
    executionId: input.executionId,
    attemptId: input.attemptId,
    attemptNumber: 1,
    leaseToken: input.leaseToken,
    status: 'RETRY_SCHEDULED',
    errorCode: 'PROVIDER_RATE_LIMITED',
    httpStatus: 429,
    nextAction: 'CREATE_RETRY',
    nextAttemptAt: new Date(NOW.getTime() + 2_000),
    completedAt: NOW,
    outbox: {
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b2',
      aggregateId: input.taskId,
      eventType: 'provider.execution-retry-scheduled.v1',
      eventVersion: 1,
      deduplicationKey: 'dedupe-1',
      payload: { taskId: input.taskId },
      headers: { traceId: input.traceId },
      occurredAt: NOW,
      availableAt: NOW,
    },
  };
}

function ambiguityInput(): CommitAmbiguityInput {
  const completion = completeInput();
  return {
    consumer: completion.consumer,
    messageId: completion.messageId,
    payloadSha256: completion.payloadSha256,
    executionId: completion.executionId,
    attemptId: completion.attemptId,
    attemptNumber: completion.attemptNumber,
    leaseToken: completion.leaseToken,
    providerTaskId: 'remote-1',
    errorCode: 'POST_ACCEPTANCE_PERSISTENCE_FAILED',
    completedAt: completion.completedAt,
    outbox: { ...completion.outbox, eventType: 'provider.execution-ambiguous.v1' },
  };
}

function lateResultInput(): RecordLateResultInput {
  const completion = completeInput();
  return {
    executionId: completion.executionId,
    attemptId: completion.attemptId,
    attemptNumber: completion.attemptNumber,
    leaseToken: completion.leaseToken,
    providerTaskId: 'remote-late-1',
    providerState: 'ACCEPTED',
    observedAt: new Date(NOW.getTime() + 30_001),
    outbox: {
      ...completion.outbox,
      eventType: 'provider.execution-late-result.v1',
      deduplicationKey: 'late-result-1',
      payload: { providerTaskId: 'remote-late-1', providerState: 'ACCEPTED' },
    },
  };
}

function claimInput(overrides: Partial<ClaimRetryInput> = {}): ClaimRetryInput {
  const begin = beginInput();
  return {
    consumer: 'provider-runtime:execution-retry-scheduled:v1',
    messageId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c0',
    eventType: 'provider.execution-retry-scheduled.v1',
    payloadSha256: 'd'.repeat(64),
    executionId: begin.executionId,
    attemptId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c1',
    taskId: begin.taskId,
    routeEpoch: begin.routeEpoch,
    capabilityVersionId: begin.capabilityVersionId,
    parametersSnapshotSha256: begin.parametersSnapshotSha256,
    providerId: begin.providerId,
    modelCode: begin.modelCode,
    priorAttemptNumber: 1,
    dueAt: NOW,
    receivedAt: NOW,
    leaseToken: 'e'.repeat(64),
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    maxAttempts: 5,
    traceId: begin.traceId,
    correlationId: begin.correlationId,
    exhaustedOutbox: {
      ...begin.takeoverOutbox,
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c2',
      eventType: 'provider.execution-failed.v1',
      deduplicationKey: 'exhausted-1',
    },
    takeoverOutbox: {
      ...begin.takeoverOutbox,
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c3',
      deduplicationKey: 'retry-takeover-1',
    },
    ...overrides,
  };
}

function createTransaction(overrides: Partial<ProviderRuntimePrismaTransaction> = {}) {
  const order: string[] = [];
  const transaction: ProviderRuntimePrismaTransaction = {
    inboxMessage: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(() => {
        order.push('inbox:create');
        return Promise.resolve({});
      }),
      updateMany: vi.fn().mockImplementation(() => {
        order.push('inbox:processed');
        return Promise.resolve({ count: 1 });
      }),
    },
    providerExecution: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(() => {
        order.push('execution:create');
        return Promise.resolve({});
      }),
      updateMany: vi.fn().mockImplementation(() => {
        order.push('execution:update');
        return Promise.resolve({ count: 1 });
      }),
    },
    providerAttempt: {
      create: vi.fn().mockImplementation(() => {
        order.push('attempt:create');
        return Promise.resolve({});
      }),
      updateMany: vi.fn().mockImplementation(() => {
        order.push('attempt:update');
        return Promise.resolve({ count: 1 });
      }),
    },
    outboxEvent: {
      create: vi.fn().mockImplementation(() => {
        order.push('outbox:create');
        return Promise.resolve({});
      }),
    },
    ...overrides,
  };
  return { order, transaction };
}

function repository(transaction: ProviderRuntimePrismaTransaction) {
  const transactionMock = vi.fn(
    (callback: (tx: ProviderRuntimePrismaTransaction) => Promise<unknown>) => callback(transaction),
  );
  const prisma: ProviderRuntimePrismaClient = {
    $transaction: transactionMock as ProviderRuntimePrismaClient['$transaction'],
  };
  return { transactionMock, repository: new PrismaExecutionRepository(prisma) };
}

describe('PrismaExecutionRepository', () => {
  it('durably preflights core event binding before dispatch resolution', async () => {
    const input = beginInput();
    const { order, transaction } = createTransaction();
    vi.mocked(transaction.providerExecution.findUnique).mockResolvedValue({
      id: input.executionId,
      taskId: input.taskId,
      routeEpoch: input.routeEpoch,
      capabilityVersionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51ff',
      parametersSnapshotSha256: input.parametersSnapshotSha256,
      providerId: input.providerId,
      modelCode: input.modelCode,
      status: 'ACCEPTED',
    });
    const { repository: subject } = repository(transaction);
    await expect(
      subject.preflightQueued({
        consumer: input.consumer,
        messageId: input.messageId,
        eventType: input.eventType,
        payloadSha256: input.payloadSha256,
        taskId: input.taskId,
        routeEpoch: input.routeEpoch,
        failoverAuthorized: input.failoverAuthorized,
        capabilityVersionId: input.capabilityVersionId,
        parametersSnapshotSha256: input.parametersSnapshotSha256,
        receivedAt: input.receivedAt,
        bindingMismatchOutbox: input.bindingMismatchOutbox,
      }),
    ).resolves.toEqual('REJECTED_BINDING');
    expect(order).toEqual(['inbox:create', 'outbox:create', 'inbox:processed']);
  });

  it('idempotently ACKs a previously persisted binding-security disposition', async () => {
    const input = beginInput();
    const { transaction } = createTransaction();
    vi.mocked(transaction.inboxMessage.findUnique).mockResolvedValue({
      payloadSha256: input.payloadSha256,
      processedAt: NOW,
      lastError: 'IMMUTABLE_BINDING_MISMATCH',
    });
    const { repository: subject } = repository(transaction);
    await expect(
      subject.preflightQueued({
        consumer: input.consumer,
        messageId: input.messageId,
        eventType: input.eventType,
        payloadSha256: input.payloadSha256,
        taskId: input.taskId,
        routeEpoch: input.routeEpoch,
        failoverAuthorized: input.failoverAuthorized,
        capabilityVersionId: input.capabilityVersionId,
        parametersSnapshotSha256: input.parametersSnapshotSha256,
        receivedAt: input.receivedAt,
        bindingMismatchOutbox: input.bindingMismatchOutbox,
      }),
    ).resolves.toBe('REJECTED_BINDING');
    expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('atomically creates inbox, execution and attempt before returning STARTED', async () => {
    const { order, transaction } = createTransaction();
    const { transactionMock, repository: subject } = repository(transaction);

    await expect(subject.begin(beginInput())).resolves.toEqual({
      kind: 'STARTED',
      executionId: beginInput().executionId,
      attemptId: beginInput().attemptId,
      attemptNumber: 1,
      leaseToken: beginInput().leaseToken,
    });

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['inbox:create', 'execution:create', 'attempt:create']);
    expect(transaction.providerAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attemptNumber: 1,
        idempotencyKey: beginInput().taskId,
        action: 'CREATE',
        status: 'STARTED',
      }),
    });
  });

  it('creates an explicitly authorized next route epoch against a different provider', async () => {
    const input = failoverInput();
    const original = beginInput();
    const { transaction } = createTransaction();
    vi.mocked(transaction.providerExecution.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: original.executionId,
        taskId: original.taskId,
        routeEpoch: 0,
        providerId: original.providerId,
        status: 'SUBMITTING',
      });

    await expect(repository(transaction).repository.begin(input)).resolves.toMatchObject({
      kind: 'STARTED',
      executionId: input.executionId,
    });
    expect(transaction.providerExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: input.taskId,
        routeEpoch: 1,
        providerId: input.providerId,
        idempotencyKey: input.taskId,
      }),
    });
    expect(transaction.providerAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ idempotencyKey: input.taskId }),
    });
  });

  it('durably rejects a failover begin without authorization proof', async () => {
    const input = failoverInput({ failoverAuthorized: false }, false);
    const { order, transaction } = createTransaction();

    await expect(repository(transaction).repository.begin(input)).resolves.toEqual({
      kind: 'REJECTED_BINDING',
    });
    expect(order).toEqual(['inbox:create', 'outbox:create', 'inbox:processed']);
    expect(transaction.providerExecution.create).not.toHaveBeenCalled();
  });

  it('durably rejects a failover preflight whose prior epoch cannot be verified', async () => {
    const input = failoverInput();
    const { order, transaction } = createTransaction();

    await expect(
      repository(transaction).repository.preflightQueued({
        consumer: input.consumer,
        messageId: input.messageId,
        eventType: input.eventType,
        payloadSha256: input.payloadSha256,
        taskId: input.taskId,
        routeEpoch: input.routeEpoch,
        failoverAuthorized: input.failoverAuthorized,
        ...(input.priorExecutionId === undefined
          ? {}
          : { priorExecutionId: input.priorExecutionId }),
        capabilityVersionId: input.capabilityVersionId,
        parametersSnapshotSha256: input.parametersSnapshotSha256,
        receivedAt: input.receivedAt,
        bindingMismatchOutbox: input.bindingMismatchOutbox,
      }),
    ).resolves.toEqual('REJECTED_BINDING');
    expect(order).toEqual(['inbox:create', 'outbox:create', 'inbox:processed']);
  });

  it('rejects same-provider failover even when the route epoch proof is otherwise valid', async () => {
    const original = beginInput();
    const input = failoverInput({ providerId: original.providerId });
    const { order, transaction } = createTransaction();
    vi.mocked(transaction.providerExecution.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: original.executionId,
        taskId: original.taskId,
        routeEpoch: 0,
        providerId: original.providerId,
        status: 'SUBMITTING',
      });

    await expect(repository(transaction).repository.begin(input)).resolves.toEqual({
      kind: 'REJECTED_BINDING',
    });
    expect(order).toEqual(['inbox:create', 'outbox:create', 'inbox:processed']);
    expect(transaction.providerExecution.create).not.toHaveBeenCalled();
  });

  it.each([
    [new Date('2026-08-31T12:00:01.000Z'), 'DUPLICATE_COMPLETE'],
    [null, 'DUPLICATE_PENDING'],
  ] as const)('deduplicates a durable inbox row', async (processedAt, kind) => {
    const { transaction } = createTransaction();
    vi.mocked(transaction.inboxMessage.findUnique).mockResolvedValue({
      payloadSha256: beginInput().payloadSha256,
      processedAt,
    });
    const { repository: subject } = repository(transaction);
    await expect(subject.begin(beginInput())).resolves.toEqual({ kind });
    expect(transaction.providerExecution.create).not.toHaveBeenCalled();
    expect(transaction.providerAttempt.create).not.toHaveBeenCalled();
  });

  it('rejects the same message identity with different bytes', async () => {
    const { transaction } = createTransaction();
    vi.mocked(transaction.inboxMessage.findUnique).mockResolvedValue({
      payloadSha256: 'f'.repeat(64),
      processedAt: null,
    });
    const { repository: subject } = repository(transaction);
    await expect(subject.begin(beginInput())).rejects.toMatchObject({
      code: 'MESSAGE_PAYLOAD_CONFLICT',
    });
  });

  it.each([
    ['SUBMITTING', 'DUPLICATE_PENDING'],
    ['ACCEPTED', 'DUPLICATE_COMPLETE'],
  ] as const)('deduplicates a different delivery for an existing %s task', async (status, kind) => {
    const { transaction } = createTransaction();
    vi.mocked(transaction.providerExecution.findUnique).mockResolvedValue({
      id: beginInput().executionId,
      taskId: beginInput().taskId,
      routeEpoch: beginInput().routeEpoch,
      capabilityVersionId: beginInput().capabilityVersionId,
      parametersSnapshotSha256: beginInput().parametersSnapshotSha256,
      providerId: beginInput().providerId,
      modelCode: beginInput().modelCode,
      status,
    });
    const { repository: subject } = repository(transaction);
    await expect(subject.begin(beginInput())).resolves.toEqual({ kind });
    expect(transaction.inboxMessage.create).toHaveBeenCalledTimes(1);
    expect(transaction.providerAttempt.create).not.toHaveBeenCalled();
  });

  it('finishes a different-message inbox when the original submission later becomes terminal', async () => {
    const input = beginInput();
    const { order, transaction } = createTransaction();
    vi.mocked(transaction.inboxMessage.findUnique).mockResolvedValue({
      payloadSha256: input.payloadSha256,
      processedAt: null,
    });
    vi.mocked(transaction.providerExecution.findUnique).mockResolvedValue({
      id: input.executionId,
      taskId: input.taskId,
      routeEpoch: input.routeEpoch,
      capabilityVersionId: input.capabilityVersionId,
      parametersSnapshotSha256: input.parametersSnapshotSha256,
      providerId: input.providerId,
      modelCode: input.modelCode,
      status: 'ACCEPTED',
      currentAttempt: 1,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    await expect(repository(transaction).repository.begin(input)).resolves.toEqual({
      kind: 'DUPLICATE_COMPLETE',
    });
    expect(order).toEqual(['inbox:processed']);
  });

  it.each([
    ['taskId', '0198f4d4-21c2-7b7d-8a03-08a0da2a51fd'],
    ['capabilityVersionId', '0198f4d4-21c2-7b7d-8a03-08a0da2a51ff'],
    ['parametersSnapshotSha256', 'f'.repeat(64)],
    ['providerId', '0198f4d4-21c2-7b7d-8a03-08a0da2a51fc'],
    ['modelCode', 'drifted-model'],
  ] as const)(
    'durably rejects a different-message duplicate whose %s binding drifts',
    async (key, value) => {
      const input = beginInput();
      const { order, transaction } = createTransaction();
      vi.mocked(transaction.providerExecution.findUnique).mockResolvedValue({
        id: input.executionId,
        taskId: input.taskId,
        routeEpoch: input.routeEpoch,
        capabilityVersionId: input.capabilityVersionId,
        parametersSnapshotSha256: input.parametersSnapshotSha256,
        providerId: input.providerId,
        modelCode: input.modelCode,
        status: 'ACCEPTED',
        currentAttempt: 1,
        leaseToken: null,
        leaseExpiresAt: null,
        [key]: value,
      });
      await expect(repository(transaction).repository.begin(input)).resolves.toEqual({
        kind: 'REJECTED_BINDING',
      });
      expect(order).toEqual(['inbox:create', 'outbox:create', 'inbox:processed']);
      expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'provider.security-binding-rejected.v1',
          payload: expect.objectContaining({ errorCode: 'IMMUTABLE_BINDING_MISMATCH' }),
        }),
      });
      expect(transaction.inboxMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lastError: 'IMMUTABLE_BINDING_MISMATCH' }),
        }),
      );
      expect(transaction.providerAttempt.create).not.toHaveBeenCalled();
    },
  );

  it('recovers a concurrent unique constraint race by reading the winning inbox row', async () => {
    const { transaction } = createTransaction();
    vi.mocked(transaction.inboxMessage.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        payloadSha256: beginInput().payloadSha256,
        processedAt: null,
      });
    vi.mocked(transaction.inboxMessage.create).mockRejectedValueOnce({ code: 'P2002' });
    const { transactionMock, repository: subject } = repository(transaction);
    await expect(subject.begin(beginInput())).resolves.toEqual({ kind: 'DUPLICATE_PENDING' });
    expect(transactionMock).toHaveBeenCalledTimes(2);
  });

  it('does not mask a non-unique begin failure', async () => {
    const { transaction } = createTransaction();
    vi.mocked(transaction.inboxMessage.create).mockRejectedValueOnce(new Error('database down'));
    const { repository: subject } = repository(transaction);
    await expect(subject.begin(beginInput())).rejects.toThrow('database down');
  });

  it('commits execution, attempt, outbox and processed inbox in one ordered transaction', async () => {
    const { order, transaction } = createTransaction();
    vi.mocked(transaction.inboxMessage.findUnique).mockResolvedValue({
      payloadSha256: beginInput().payloadSha256,
      processedAt: null,
    });
    const { transactionMock, repository: subject } = repository(transaction);
    await subject.complete(completeInput());

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      'execution:update',
      'attempt:update',
      'outbox:create',
      'inbox:processed',
    ]);
    expect(transaction.providerExecution.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: completeInput().executionId,
        currentAttempt: 1,
        status: 'SUBMITTING',
      }),
      data: expect.objectContaining({
        status: 'RETRY_SCHEDULED',
        nextAction: 'CREATE_RETRY',
        nextAttemptAt: completeInput().nextAttemptAt,
      }),
    });
  });

  it('rolls back by throwing if an optimistic execution update is stale', async () => {
    const { transaction } = createTransaction();
    vi.mocked(transaction.inboxMessage.findUnique).mockResolvedValue({
      payloadSha256: beginInput().payloadSha256,
      processedAt: null,
    });
    vi.mocked(transaction.providerExecution.updateMany).mockResolvedValue({ count: 0 });
    const { repository: subject } = repository(transaction);
    await expect(subject.complete(completeInput())).rejects.toMatchObject({
      code: 'STALE_EXECUTION_ATTEMPT',
    });
    expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('does not duplicate an outbox event for an already completed inbox row', async () => {
    const { transaction } = createTransaction();
    vi.mocked(transaction.inboxMessage.findUnique).mockResolvedValue({
      payloadSha256: beginInput().payloadSha256,
      processedAt: NOW,
    });
    const { repository: subject } = repository(transaction);
    await subject.complete(completeInput());
    expect(transaction.providerExecution.updateMany).not.toHaveBeenCalled();
    expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('rejects completion when its durable inbox row is missing or has different bytes', async () => {
    const { transaction } = createTransaction();
    const { repository: subject } = repository(transaction);
    await expect(subject.complete(completeInput())).rejects.toMatchObject({
      code: 'INBOX_MESSAGE_NOT_FOUND',
    });
    vi.mocked(transaction.inboxMessage.findUnique).mockResolvedValue({
      payloadSha256: 'f'.repeat(64),
      processedAt: null,
    });
    await expect(subject.complete(completeInput())).rejects.toMatchObject({
      code: 'MESSAGE_PAYLOAD_CONFLICT',
    });
  });

  it('rolls back when the attempt or inbox optimistic update is stale', async () => {
    const first = createTransaction();
    vi.mocked(first.transaction.inboxMessage.findUnique).mockResolvedValue({
      payloadSha256: beginInput().payloadSha256,
      processedAt: null,
    });
    vi.mocked(first.transaction.providerAttempt.updateMany).mockResolvedValue({ count: 0 });
    await expect(
      repository(first.transaction).repository.complete(completeInput()),
    ).rejects.toMatchObject({
      code: 'STALE_EXECUTION_ATTEMPT',
    });

    const second = createTransaction();
    vi.mocked(second.transaction.inboxMessage.findUnique).mockResolvedValue({
      payloadSha256: beginInput().payloadSha256,
      processedAt: null,
    });
    vi.mocked(second.transaction.inboxMessage.updateMany).mockResolvedValue({ count: 0 });
    await expect(
      repository(second.transaction).repository.complete(completeInput()),
    ).rejects.toMatchObject({
      code: 'STALE_INBOX_MESSAGE',
    });
  });

  it('durably records post-acceptance ambiguity and repair outbox in one transaction', async () => {
    const { order, transaction } = createTransaction();
    vi.mocked(transaction.inboxMessage.findUnique).mockResolvedValue({
      payloadSha256: beginInput().payloadSha256,
      processedAt: null,
    });
    const { repository: subject } = repository(transaction);
    await subject.recordCommitAmbiguity(ambiguityInput());
    expect(order).toEqual([
      'execution:update',
      'attempt:update',
      'outbox:create',
      'inbox:processed',
    ]);
    expect(transaction.providerExecution.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ status: 'SUBMITTING' }),
      data: expect.objectContaining({
        status: 'AMBIGUOUS',
        nextAction: 'RECONCILE',
        providerTaskId: 'remote-1',
      }),
    });
  });

  it('treats ambiguity repair as idempotent when the original commit actually won', async () => {
    const { transaction } = createTransaction();
    vi.mocked(transaction.inboxMessage.findUnique).mockResolvedValue({
      payloadSha256: beginInput().payloadSha256,
      processedAt: NOW,
    });
    const { repository: subject } = repository(transaction);
    await subject.recordCommitAmbiguity(ambiguityInput());
    expect(transaction.providerExecution.updateMany).not.toHaveBeenCalled();
  });

  it('fences and durably records a late accepted provider result', async () => {
    const { order, transaction } = createTransaction();
    const { repository: subject } = repository(transaction);

    await expect(subject.recordLateResult(lateResultInput())).resolves.toBe(true);

    expect(order).toEqual(['execution:update', 'attempt:update', 'outbox:create']);
    expect(transaction.providerExecution.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: lateResultInput().executionId,
        currentAttempt: 1,
        status: 'AMBIGUOUS',
        leaseToken: lateResultInput().leaseToken,
      }),
      data: expect.objectContaining({
        providerTaskId: 'remote-late-1',
        nextAction: 'RECONCILE',
        leaseToken: null,
      }),
    });
    expect(transaction.providerAttempt.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: lateResultInput().attemptId,
        status: 'AMBIGUOUS',
        leaseToken: lateResultInput().leaseToken,
      }),
      data: expect.objectContaining({ providerTaskId: 'remote-late-1', leaseToken: null }),
    });
  });

  it('ignores a late provider result after the execution fence has moved', async () => {
    const { transaction } = createTransaction();
    vi.mocked(transaction.providerExecution.updateMany).mockResolvedValue({ count: 0 });
    const { repository: subject } = repository(transaction);

    await expect(subject.recordLateResult(lateResultInput())).resolves.toBe(false);

    expect(transaction.providerAttempt.updateMany).not.toHaveBeenCalled();
    expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('claims a due retry with a fenced attempt N+1 in one transaction', async () => {
    const { order, transaction } = createTransaction();
    const { repository: subject } = repository(transaction);
    await expect(subject.claimRetry(claimInput())).resolves.toMatchObject({
      kind: 'CLAIMED',
      attemptNumber: 2,
      leaseToken: claimInput().leaseToken,
    });
    expect(order).toEqual(['inbox:create', 'execution:update', 'attempt:create']);
    expect(transaction.providerExecution.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: 'RETRY_SCHEDULED',
        currentAttempt: 1,
        nextAttemptAt: { lte: NOW },
      }),
      data: expect.objectContaining({
        status: 'SUBMITTING',
        currentAttempt: { increment: 1 },
        leaseToken: claimInput().leaseToken,
      }),
    });
    expect(transaction.providerAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ attemptNumber: 2, idempotencyKey: claimInput().taskId }),
    });
  });

  it('does not persist or claim a retry delivered before dueAt', async () => {
    const { transaction } = createTransaction();
    const { repository: subject } = repository(transaction);
    await expect(
      subject.claimRetry(claimInput({ receivedAt: new Date(NOW.getTime() - 1), dueAt: NOW })),
    ).resolves.toEqual({ kind: 'NOT_DUE' });
    expect(transaction.inboxMessage.create).not.toHaveBeenCalled();
    expect(transaction.providerExecution.updateMany).not.toHaveBeenCalled();
  });

  it('durably finalizes max attempts and processes the retry inbox', async () => {
    const { order, transaction } = createTransaction();
    const { repository: subject } = repository(transaction);
    await expect(
      subject.claimRetry(claimInput({ priorAttemptNumber: 5, maxAttempts: 5 })),
    ).resolves.toEqual({ kind: 'MAX_ATTEMPTS' });
    expect(order).toEqual(['inbox:create', 'execution:update', 'outbox:create', 'inbox:processed']);
    expect(transaction.providerAttempt.create).not.toHaveBeenCalled();
  });

  it('deduplicates a concurrent retry event and does not create attempt N+1 twice', async () => {
    const { transaction } = createTransaction();
    vi.mocked(transaction.inboxMessage.findUnique).mockResolvedValue({
      payloadSha256: claimInput().payloadSha256,
      processedAt: null,
    });
    const { repository: subject } = repository(transaction);
    await expect(subject.claimRetry(claimInput())).resolves.toEqual({
      kind: 'DUPLICATE_PENDING',
    });
    expect(transaction.providerAttempt.create).not.toHaveBeenCalled();
  });

  it('takes over an expired pending retry claim as ambiguous instead of NACKing forever', async () => {
    const input = claimInput();
    const { order, transaction } = createTransaction();
    vi.mocked(transaction.inboxMessage.findUnique).mockResolvedValue({
      payloadSha256: input.payloadSha256,
      processedAt: null,
    });
    vi.mocked(transaction.providerExecution.findUnique).mockResolvedValue({
      id: input.executionId,
      taskId: input.taskId,
      routeEpoch: input.routeEpoch,
      capabilityVersionId: input.capabilityVersionId,
      parametersSnapshotSha256: input.parametersSnapshotSha256,
      providerId: input.providerId,
      modelCode: input.modelCode,
      status: 'SUBMITTING',
      currentAttempt: 2,
      leaseToken: 'f'.repeat(64),
      leaseExpiresAt: new Date(NOW.getTime() - 1),
    });
    const { repository: subject } = repository(transaction);
    await expect(subject.claimRetry(input)).resolves.toEqual({ kind: 'RECOVERED_AMBIGUOUS' });
    expect(order).toEqual([
      'execution:update',
      'attempt:update',
      'outbox:create',
      'inbox:processed',
    ]);
    expect(transaction.providerAttempt.create).not.toHaveBeenCalled();
  });

  it('takes over an expired submission lease as ambiguous without another create attempt', async () => {
    const input = beginInput();
    const { order, transaction } = createTransaction();
    vi.mocked(transaction.inboxMessage.findUnique).mockResolvedValue({
      payloadSha256: input.payloadSha256,
      processedAt: null,
    });
    vi.mocked(transaction.providerExecution.findUnique).mockResolvedValue({
      id: input.executionId,
      taskId: input.taskId,
      routeEpoch: input.routeEpoch,
      capabilityVersionId: input.capabilityVersionId,
      parametersSnapshotSha256: input.parametersSnapshotSha256,
      providerId: input.providerId,
      modelCode: input.modelCode,
      status: 'SUBMITTING',
      currentAttempt: 1,
      leaseToken: input.leaseToken,
      leaseExpiresAt: new Date(NOW.getTime() - 1),
    });
    const { repository: subject } = repository(transaction);
    await expect(subject.begin(input)).resolves.toEqual({ kind: 'RECOVERED_AMBIGUOUS' });
    expect(order).toEqual([
      'execution:update',
      'attempt:update',
      'outbox:create',
      'inbox:processed',
    ]);
    expect(transaction.providerAttempt.create).not.toHaveBeenCalled();
  });

  it('nacks an unexpired submission and fences a losing concurrent takeover', async () => {
    for (const count of [1, 0]) {
      const input = beginInput();
      const { transaction } = createTransaction();
      vi.mocked(transaction.inboxMessage.findUnique).mockResolvedValue({
        payloadSha256: input.payloadSha256,
        processedAt: null,
      });
      vi.mocked(transaction.providerExecution.findUnique).mockResolvedValue({
        id: input.executionId,
        taskId: input.taskId,
        routeEpoch: input.routeEpoch,
        capabilityVersionId: input.capabilityVersionId,
        parametersSnapshotSha256: input.parametersSnapshotSha256,
        providerId: input.providerId,
        modelCode: input.modelCode,
        status: 'SUBMITTING',
        currentAttempt: 1,
        leaseToken: input.leaseToken,
        leaseExpiresAt: count === 1 ? new Date(NOW.getTime() + 1) : new Date(NOW.getTime() - 1),
      });
      if (count === 0) {
        vi.mocked(transaction.providerExecution.updateMany).mockResolvedValue({ count: 0 });
      }
      await expect(repository(transaction).repository.begin(input)).resolves.toEqual({
        kind: 'DUPLICATE_PENDING',
      });
      expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
    }
  });
});
