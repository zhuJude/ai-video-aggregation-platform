import {
  ProviderRuntimeError,
  type BeginExecutionInput,
  type BeginExecutionResult,
  type ClaimRetryInput,
  type ClaimRetryResult,
  type CommitAmbiguityInput,
  type CompleteExecutionInput,
  type ExecutionRepository,
  type PendingOutboxEvent,
  type PreflightQueuedInput,
  type RecordLateResultInput,
} from '../application/execution.service.js';
import type { PrismaClient } from '../generated/prisma/client.js';

interface CountResult {
  readonly count: number;
}
interface InboxRecord {
  readonly payloadSha256: string;
  readonly processedAt: Date | null;
  readonly lastError?: string | null;
}
interface ExecutionRecord {
  readonly id: string;
  readonly taskId?: string;
  readonly capabilityVersionId?: string;
  readonly parametersSnapshotSha256?: string;
  readonly providerId?: string;
  readonly modelCode?: string;
  readonly status: string;
  readonly currentAttempt?: number;
  readonly leaseToken?: string | null;
  readonly leaseExpiresAt?: Date | null;
}
interface FindUniqueDelegate<T> {
  findUnique(args: unknown): Promise<T | null>;
}
interface CreateDelegate {
  create(args: unknown): Promise<unknown>;
}
interface UpdateManyDelegate {
  updateMany(args: unknown): Promise<CountResult>;
}

export interface ProviderRuntimePrismaTransaction {
  readonly inboxMessage: FindUniqueDelegate<InboxRecord> & CreateDelegate & UpdateManyDelegate;
  readonly providerExecution: FindUniqueDelegate<ExecutionRecord> &
    CreateDelegate &
    UpdateManyDelegate;
  readonly providerAttempt: CreateDelegate & UpdateManyDelegate;
  readonly outboxEvent: CreateDelegate;
}
export interface ProviderRuntimePrismaClient {
  $transaction<T>(
    callback: (transaction: ProviderRuntimePrismaTransaction) => Promise<T>,
  ): Promise<T>;
}

export class PrismaExecutionRepository implements ExecutionRepository {
  constructor(private readonly prisma: ProviderRuntimePrismaClient) {}

  preflightQueued(input: PreflightQueuedInput): Promise<'CONTINUE' | 'REJECTED_BINDING'> {
    return this.prisma.$transaction(async (transaction) => {
      const inbox = await readInbox(transaction, input);
      if (inbox?.processedAt)
        return inbox.lastError === 'IMMUTABLE_BINDING_MISMATCH' ? 'REJECTED_BINDING' : 'CONTINUE';
      const execution = await transaction.providerExecution.findUnique({
        where: { taskId: input.taskId },
        select: {
          id: true,
          taskId: true,
          capabilityVersionId: true,
          parametersSnapshotSha256: true,
          status: true,
        },
      });
      if (
        execution === null ||
        (execution.taskId === input.taskId &&
          execution.capabilityVersionId === input.capabilityVersionId &&
          execution.parametersSnapshotSha256 === input.parametersSnapshotSha256)
      ) {
        return 'CONTINUE';
      }
      if (inbox === null) await createInbox(transaction, input, false);
      await createOutbox(transaction, {
        ...input.bindingMismatchOutbox,
        payload: {
          ...input.bindingMismatchOutbox.payload,
          executionId: execution.id,
          errorCode: 'IMMUTABLE_BINDING_MISMATCH',
          securityDisposition: true,
        },
      });
      await processInbox(transaction, input, input.receivedAt, 'IMMUTABLE_BINDING_MISMATCH');
      return 'REJECTED_BINDING';
    });
  }

  async begin(input: BeginExecutionInput): Promise<BeginExecutionResult> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const inbox = await readInbox(transaction, input);
        if (inbox?.processedAt) return { kind: 'DUPLICATE_COMPLETE' };
        const existing = await transaction.providerExecution.findUnique({
          where: { taskId: input.taskId },
          select: {
            id: true,
            taskId: true,
            capabilityVersionId: true,
            parametersSnapshotSha256: true,
            providerId: true,
            modelCode: true,
            status: true,
            currentAttempt: true,
            leaseToken: true,
            leaseExpiresAt: true,
          },
        });
        if (inbox !== null) return resolveExistingQueued(transaction, input, existing);
        if (existing !== null) {
          await createInbox(transaction, input, false);
          return resolveExistingQueued(transaction, input, existing);
        }
        await createInbox(transaction, input, false);
        await transaction.providerExecution.create({
          data: {
            id: input.executionId,
            taskId: input.taskId,
            capabilityVersionId: input.capabilityVersionId,
            parametersSnapshotSha256: input.parametersSnapshotSha256,
            providerId: input.providerId,
            modelCode: input.modelCode,
            idempotencyKey: input.idempotencyKey,
            status: 'SUBMITTING',
            currentAttempt: 1,
            nextAction: 'NONE',
            traceId: input.traceId,
            correlationId: input.correlationId,
            leaseToken: input.leaseToken,
            leaseExpiresAt: input.leaseExpiresAt,
            createdAt: input.receivedAt,
          },
        });
        await transaction.providerAttempt.create({
          data: {
            id: input.attemptId,
            executionId: input.executionId,
            attemptNumber: 1,
            action: 'CREATE',
            status: 'STARTED',
            idempotencyKey: input.taskId,
            leaseToken: input.leaseToken,
            startedAt: input.receivedAt,
          },
        });
        return {
          kind: 'STARTED',
          executionId: input.executionId,
          attemptId: input.attemptId,
          attemptNumber: 1,
          leaseToken: input.leaseToken,
        };
      });
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      return this.prisma.$transaction(async (transaction) => {
        const inbox = await readInbox(transaction, input);
        if (inbox === null) throw error;
        if (inbox.processedAt !== null) return { kind: 'DUPLICATE_COMPLETE' };
        const existing = await transaction.providerExecution.findUnique({
          where: { taskId: input.taskId },
          select: {
            id: true,
            taskId: true,
            capabilityVersionId: true,
            parametersSnapshotSha256: true,
            providerId: true,
            modelCode: true,
            status: true,
            currentAttempt: true,
            leaseToken: true,
            leaseExpiresAt: true,
          },
        });
        return resolveExistingQueued(transaction, input, existing);
      });
    }
  }

  async claimRetry(input: ClaimRetryInput): Promise<ClaimRetryResult> {
    if (input.receivedAt.getTime() < input.dueAt.getTime()) return { kind: 'NOT_DUE' };
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const inbox = await readInbox(transaction, input);
        if (inbox !== null) {
          if (inbox.processedAt !== null) return { kind: 'DUPLICATE_COMPLETE' };
          return recoverRetryOrWait(transaction, input);
        }
        await createInbox(transaction, input, false);
        const binding = {
          id: input.executionId,
          taskId: input.taskId,
          capabilityVersionId: input.capabilityVersionId,
          parametersSnapshotSha256: input.parametersSnapshotSha256,
          providerId: input.providerId,
          modelCode: input.modelCode,
          status: 'RETRY_SCHEDULED',
          nextAction: 'CREATE_RETRY',
          currentAttempt: input.priorAttemptNumber,
          nextAttemptAt: { lte: input.receivedAt },
        };
        if (input.priorAttemptNumber >= input.maxAttempts) {
          const exhausted = await transaction.providerExecution.updateMany({
            where: binding,
            data: {
              status: 'FAILED',
              nextAction: 'NONE',
              nextAttemptAt: null,
              lastErrorCode: 'MAX_ATTEMPTS_EXHAUSTED',
              leaseToken: null,
              leaseExpiresAt: null,
              version: { increment: 1 },
            },
          });
          if (exhausted.count !== 1) throw new ProviderRuntimeError('STALE_RETRY_EVENT');
          await createOutbox(transaction, input.exhaustedOutbox);
          await processInbox(transaction, input, input.receivedAt, 'MAX_ATTEMPTS_EXHAUSTED');
          return { kind: 'MAX_ATTEMPTS' };
        }
        const claimed = await transaction.providerExecution.updateMany({
          where: binding,
          data: {
            status: 'SUBMITTING',
            currentAttempt: { increment: 1 },
            nextAction: 'NONE',
            nextAttemptAt: null,
            lastErrorCode: null,
            lastHttpStatus: null,
            leaseToken: input.leaseToken,
            leaseExpiresAt: input.leaseExpiresAt,
            version: { increment: 1 },
          },
        });
        if (claimed.count !== 1) throw new ProviderRuntimeError('STALE_RETRY_EVENT');
        const attemptNumber = input.priorAttemptNumber + 1;
        await transaction.providerAttempt.create({
          data: {
            id: input.attemptId,
            executionId: input.executionId,
            attemptNumber,
            action: 'CREATE',
            status: 'STARTED',
            idempotencyKey: input.taskId,
            leaseToken: input.leaseToken,
            startedAt: input.receivedAt,
          },
        });
        return {
          kind: 'CLAIMED',
          executionId: input.executionId,
          attemptId: input.attemptId,
          attemptNumber,
          leaseToken: input.leaseToken,
        };
      });
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      return this.prisma.$transaction(async (transaction) => {
        const inbox = await readInbox(transaction, input);
        if (inbox === null) throw error;
        if (inbox.processedAt !== null) return { kind: 'DUPLICATE_COMPLETE' };
        return recoverRetryOrWait(transaction, input);
      });
    }
  }

  complete(input: CompleteExecutionInput): Promise<void> {
    return this.prisma.$transaction(async (transaction) => {
      const state = await requirePendingInbox(transaction, input);
      if (state === 'COMPLETE') return;
      const execution = await transaction.providerExecution.updateMany({
        where: {
          id: input.executionId,
          currentAttempt: input.attemptNumber,
          status: 'SUBMITTING',
          leaseToken: input.leaseToken,
        },
        data: {
          status: input.status,
          ...(input.providerTaskId === undefined ? {} : { providerTaskId: input.providerTaskId }),
          ...(input.errorCode === undefined ? {} : { lastErrorCode: input.errorCode }),
          ...(input.httpStatus === undefined ? {} : { lastHttpStatus: input.httpStatus }),
          nextAction: input.nextAction,
          ...(input.nextAttemptAt === undefined
            ? { nextAttemptAt: null }
            : { nextAttemptAt: input.nextAttemptAt }),
          ...(input.status === 'AMBIGUOUS' ? {} : { leaseToken: null, leaseExpiresAt: null }),
          version: { increment: 1 },
        },
      });
      if (execution.count !== 1) throw new ProviderRuntimeError('STALE_EXECUTION_ATTEMPT');
      const attempt = await transaction.providerAttempt.updateMany({
        where: {
          id: input.attemptId,
          executionId: input.executionId,
          attemptNumber: input.attemptNumber,
          status: 'STARTED',
          leaseToken: input.leaseToken,
        },
        data: {
          status: input.status,
          ...(input.providerTaskId === undefined ? {} : { providerTaskId: input.providerTaskId }),
          ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
          ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
          completedAt: input.completedAt,
        },
      });
      if (attempt.count !== 1) throw new ProviderRuntimeError('STALE_EXECUTION_ATTEMPT');
      await createOutbox(transaction, input.outbox);
      await processInbox(transaction, input, input.completedAt, null);
    });
  }

  recordCommitAmbiguity(input: CommitAmbiguityInput): Promise<void> {
    return this.prisma.$transaction(async (transaction) => {
      const state = await requirePendingInbox(transaction, input);
      if (state === 'COMPLETE') return;
      const execution = await transaction.providerExecution.updateMany({
        where: {
          id: input.executionId,
          currentAttempt: input.attemptNumber,
          status: 'SUBMITTING',
          leaseToken: input.leaseToken,
        },
        data: {
          status: 'AMBIGUOUS',
          nextAction: 'RECONCILE',
          lastErrorCode: input.errorCode,
          ...(input.providerTaskId === undefined ? {} : { providerTaskId: input.providerTaskId }),
          leaseToken: null,
          leaseExpiresAt: null,
          version: { increment: 1 },
        },
      });
      if (execution.count !== 1) throw new ProviderRuntimeError('STALE_EXECUTION_ATTEMPT');
      const attempt = await transaction.providerAttempt.updateMany({
        where: {
          id: input.attemptId,
          executionId: input.executionId,
          attemptNumber: input.attemptNumber,
          status: 'STARTED',
          leaseToken: input.leaseToken,
        },
        data: {
          status: 'AMBIGUOUS',
          errorCode: input.errorCode,
          ...(input.providerTaskId === undefined ? {} : { providerTaskId: input.providerTaskId }),
          completedAt: input.completedAt,
        },
      });
      if (attempt.count !== 1) throw new ProviderRuntimeError('STALE_EXECUTION_ATTEMPT');
      await createOutbox(transaction, input.outbox);
      await processInbox(transaction, input, input.completedAt, input.errorCode);
    });
  }

  recordLateResult(input: RecordLateResultInput): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const diagnosticCode =
        input.diagnosticCode ?? `LATE_PROVIDER_RESULT_${input.providerState ?? 'UNKNOWN'}`;
      const execution = await transaction.providerExecution.updateMany({
        where: {
          id: input.executionId,
          currentAttempt: input.attemptNumber,
          status: 'AMBIGUOUS',
          nextAction: 'RECONCILE',
          leaseToken: input.leaseToken,
        },
        data: {
          ...(input.providerTaskId === undefined ? {} : { providerTaskId: input.providerTaskId }),
          lastErrorCode: diagnosticCode,
          nextAction: 'RECONCILE',
          leaseToken: null,
          leaseExpiresAt: null,
          version: { increment: 1 },
        },
      });
      if (execution.count !== 1) return false;
      const attempt = await transaction.providerAttempt.updateMany({
        where: {
          id: input.attemptId,
          executionId: input.executionId,
          attemptNumber: input.attemptNumber,
          status: 'AMBIGUOUS',
          leaseToken: input.leaseToken,
        },
        data: {
          ...(input.providerTaskId === undefined ? {} : { providerTaskId: input.providerTaskId }),
          errorCode: diagnosticCode,
          leaseToken: null,
          completedAt: input.observedAt,
        },
      });
      if (attempt.count !== 1) throw new ProviderRuntimeError('STALE_EXECUTION_ATTEMPT');
      await createOutbox(transaction, input.outbox);
      return true;
    });
  }
}

export function createPrismaExecutionRepository(prisma: PrismaClient): PrismaExecutionRepository {
  return new PrismaExecutionRepository(prisma as unknown as ProviderRuntimePrismaClient);
}

async function resolveExistingQueued(
  transaction: ProviderRuntimePrismaTransaction,
  input: BeginExecutionInput,
  execution: ExecutionRecord | null,
): Promise<BeginExecutionResult> {
  if (execution === null) return { kind: 'DUPLICATE_PENDING' };
  if (!immutableBindingMatches(input, execution)) {
    await createOutbox(transaction, {
      ...input.bindingMismatchOutbox,
      payload: {
        ...input.bindingMismatchOutbox.payload,
        executionId: execution.id,
        errorCode: 'IMMUTABLE_BINDING_MISMATCH',
        securityDisposition: true,
      },
    });
    await processInbox(transaction, input, input.receivedAt, 'IMMUTABLE_BINDING_MISMATCH');
    return { kind: 'REJECTED_BINDING' };
  }
  if (execution.status !== 'SUBMITTING') {
    await processInbox(transaction, input, input.receivedAt, null);
    return { kind: 'DUPLICATE_COMPLETE' };
  }
  return recoverOrWait(transaction, input, execution);
}

function immutableBindingMatches(input: BeginExecutionInput, execution: ExecutionRecord): boolean {
  return (
    execution.taskId === input.taskId &&
    execution.capabilityVersionId === input.capabilityVersionId &&
    execution.parametersSnapshotSha256 === input.parametersSnapshotSha256 &&
    execution.providerId === input.providerId &&
    execution.modelCode === input.modelCode
  );
}

async function recoverOrWait(
  transaction: ProviderRuntimePrismaTransaction,
  input: BeginExecutionInput,
  execution: ExecutionRecord | null,
): Promise<BeginExecutionResult> {
  if (
    execution === null ||
    execution.status !== 'SUBMITTING' ||
    execution.leaseExpiresAt === undefined ||
    execution.leaseExpiresAt === null ||
    execution.leaseExpiresAt.getTime() > input.receivedAt.getTime()
  )
    return { kind: 'DUPLICATE_PENDING' };
  const recovered = await transaction.providerExecution.updateMany({
    where: {
      id: execution.id,
      status: 'SUBMITTING',
      currentAttempt: execution.currentAttempt,
      leaseToken: execution.leaseToken,
      leaseExpiresAt: { lte: input.receivedAt },
    },
    data: {
      status: 'AMBIGUOUS',
      nextAction: 'RECONCILE',
      lastErrorCode: 'STALE_SUBMISSION_LEASE',
      leaseToken: null,
      leaseExpiresAt: null,
      version: { increment: 1 },
    },
  });
  if (recovered.count !== 1) return { kind: 'DUPLICATE_PENDING' };
  const attempt = await transaction.providerAttempt.updateMany({
    where: {
      executionId: execution.id,
      attemptNumber: execution.currentAttempt,
      status: 'STARTED',
      leaseToken: execution.leaseToken,
    },
    data: {
      status: 'AMBIGUOUS',
      errorCode: 'STALE_SUBMISSION_LEASE',
      completedAt: input.receivedAt,
    },
  });
  if (attempt.count !== 1) throw new ProviderRuntimeError('STALE_EXECUTION_ATTEMPT');
  await createOutbox(transaction, {
    ...input.takeoverOutbox,
    payload: {
      ...input.takeoverOutbox.payload,
      executionId: execution.id,
      attemptNumber: execution.currentAttempt,
    },
  });
  await processInbox(transaction, input, input.receivedAt, 'STALE_SUBMISSION_LEASE');
  return { kind: 'RECOVERED_AMBIGUOUS' };
}
async function recoverRetryOrWait(
  transaction: ProviderRuntimePrismaTransaction,
  input: ClaimRetryInput,
): Promise<ClaimRetryResult> {
  const execution = await transaction.providerExecution.findUnique({
    where: { id: input.executionId },
    select: {
      id: true,
      status: true,
      currentAttempt: true,
      leaseToken: true,
      leaseExpiresAt: true,
    },
  });
  if (
    execution === null ||
    execution.status !== 'SUBMITTING' ||
    execution.currentAttempt !== input.priorAttemptNumber + 1 ||
    execution.leaseExpiresAt === undefined ||
    execution.leaseExpiresAt === null ||
    execution.leaseExpiresAt.getTime() > input.receivedAt.getTime()
  )
    return { kind: 'DUPLICATE_PENDING' };
  const recovered = await transaction.providerExecution.updateMany({
    where: {
      id: execution.id,
      status: 'SUBMITTING',
      currentAttempt: execution.currentAttempt,
      leaseToken: execution.leaseToken,
      leaseExpiresAt: { lte: input.receivedAt },
    },
    data: {
      status: 'AMBIGUOUS',
      nextAction: 'RECONCILE',
      lastErrorCode: 'STALE_SUBMISSION_LEASE',
      leaseToken: null,
      leaseExpiresAt: null,
      version: { increment: 1 },
    },
  });
  if (recovered.count !== 1) return { kind: 'DUPLICATE_PENDING' };
  const attempt = await transaction.providerAttempt.updateMany({
    where: {
      executionId: execution.id,
      attemptNumber: execution.currentAttempt,
      status: 'STARTED',
      leaseToken: execution.leaseToken,
    },
    data: {
      status: 'AMBIGUOUS',
      errorCode: 'STALE_SUBMISSION_LEASE',
      completedAt: input.receivedAt,
    },
  });
  if (attempt.count !== 1) throw new ProviderRuntimeError('STALE_EXECUTION_ATTEMPT');
  await createOutbox(transaction, input.takeoverOutbox);
  await processInbox(transaction, input, input.receivedAt, 'STALE_SUBMISSION_LEASE');
  return { kind: 'RECOVERED_AMBIGUOUS' };
}
async function readInbox(
  transaction: ProviderRuntimePrismaTransaction,
  input: { consumer: string; messageId: string; payloadSha256: string },
): Promise<InboxRecord | null> {
  const inbox = await transaction.inboxMessage.findUnique({
    where: { consumer_messageId: { consumer: input.consumer, messageId: input.messageId } },
    select: { payloadSha256: true, processedAt: true, lastError: true },
  });
  if (inbox !== null && inbox.payloadSha256 !== input.payloadSha256)
    throw new ProviderRuntimeError('MESSAGE_PAYLOAD_CONFLICT');
  return inbox;
}
function createInbox(
  transaction: ProviderRuntimePrismaTransaction,
  input: {
    messageId: string;
    consumer: string;
    eventType: string;
    payloadSha256: string;
    receivedAt: Date;
  },
  complete: boolean,
): Promise<unknown> {
  return transaction.inboxMessage.create({
    data: {
      id: input.messageId,
      consumer: input.consumer,
      messageId: input.messageId,
      eventType: input.eventType,
      payloadSha256: input.payloadSha256,
      receivedAt: input.receivedAt,
      ...(complete ? { processedAt: input.receivedAt } : {}),
    },
  });
}
async function requirePendingInbox(
  transaction: ProviderRuntimePrismaTransaction,
  input: { consumer: string; messageId: string; payloadSha256: string },
): Promise<'PENDING' | 'COMPLETE'> {
  const inbox = await readInbox(transaction, input);
  if (inbox === null) throw new ProviderRuntimeError('INBOX_MESSAGE_NOT_FOUND');
  return inbox.processedAt === null ? 'PENDING' : 'COMPLETE';
}
async function processInbox(
  transaction: ProviderRuntimePrismaTransaction,
  input: { consumer: string; messageId: string; payloadSha256: string },
  at: Date,
  lastError: string | null,
): Promise<void> {
  const inbox = await transaction.inboxMessage.updateMany({
    where: {
      consumer: input.consumer,
      messageId: input.messageId,
      payloadSha256: input.payloadSha256,
      processedAt: null,
    },
    data: { processedAt: at, lastError },
  });
  if (inbox.count !== 1) throw new ProviderRuntimeError('STALE_INBOX_MESSAGE');
}
function createOutbox(
  transaction: ProviderRuntimePrismaTransaction,
  outbox: PendingOutboxEvent,
): Promise<unknown> {
  return transaction.outboxEvent.create({
    data: {
      id: outbox.id,
      aggregateType: 'ProviderExecution',
      aggregateId: outbox.aggregateId,
      eventType: outbox.eventType,
      eventVersion: outbox.eventVersion,
      deduplicationKey: outbox.deduplicationKey,
      payload: outbox.payload,
      headers: outbox.headers,
      occurredAt: outbox.occurredAt,
      availableAt: outbox.availableAt,
    },
  });
}
function isUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
