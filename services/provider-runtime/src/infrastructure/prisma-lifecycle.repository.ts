import type { CircuitAcquireResult, CircuitRepository } from '../domain/circuit-breaker.js';
import {
  decideProviderUpdate,
  isTerminalProviderStatus,
  type ObservableProviderStatus,
} from '../domain/provider-state.js';
import type {
  ApplyCallbackInput,
  ApplyCallbackResult,
  CallbackRepository,
} from '../http/provider-callback.controller.js';
import { ProviderCallbackError } from '../http/provider-callback.controller.js';
import { callbackDeduplicationKey } from '../http/provider-callback.controller.js';
import type {
  ClaimPollInput,
  ClaimPollResult,
  CompletePollInput,
  DeferPollInput,
  PollOutboxEvent,
  PollRepository,
} from '../application/polling.consumer.js';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';

type Transaction = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export class PrismaCallbackRepository implements CallbackRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async apply(input: ApplyCallbackInput): Promise<ApplyCallbackResult> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const prior = await transaction.callbackInbox.findUnique({
          where: {
            providerId_providerEventId: {
              providerId: input.providerId,
              providerEventId: input.providerEventId,
            },
          },
          select: {
            payloadSha256: true,
            providerTaskId: true,
            execution: { select: { providerId: true } },
          },
        });
        if (prior !== null) return duplicateCallback(prior, input);
        const execution = await transaction.providerExecution.findUnique({
          where: {
            providerId_providerTaskId: {
              providerId: input.providerId,
              providerTaskId: input.providerTaskId,
            },
          },
          select: {
            id: true,
            taskId: true,
            status: true,
            currentAttempt: true,
            lastProviderSequence: true,
            version: true,
            traceId: true,
            correlationId: true,
          },
        });
        if (execution === null) throw new ProviderCallbackError('EXECUTION_NOT_FOUND', 404);
        await transaction.callbackInbox.create({
          data: {
            id: input.inboxId,
            providerId: input.providerId,
            providerEventId: input.providerEventId,
            executionId: execution.id,
            providerTaskId: input.providerTaskId,
            sequence: input.sequence,
            payloadSha256: input.payloadSha256,
            receivedAt: input.receivedAt,
          },
        });
        const decision = decideProviderUpdate(
          { status: execution.status, lastSequence: execution.lastProviderSequence },
          input.state,
          input.sequence,
        );
        if (decision !== 'APPLY') {
          if (decision !== 'OUT_OF_ORDER') {
            const fenced = await transaction.providerExecution.updateMany({
              where: { id: execution.id, version: execution.version },
              data: { lastProviderSequence: input.sequence, version: { increment: 1 } },
            });
            if (fenced.count !== 1) throw new Error('STALE_CALLBACK_EXECUTION');
          }
          await transaction.callbackInbox.update({
            where: {
              providerId_providerEventId: {
                providerId: input.providerId,
                providerEventId: input.providerEventId,
              },
            },
            data: { processedAt: input.receivedAt, outcome: decision },
          });
          return { kind: decision };
        }
        const terminal = isTerminalProviderStatus(input.state);
        const updated = await transaction.providerExecution.updateMany({
          where: {
            id: execution.id,
            version: execution.version,
            lastProviderSequence: { lt: input.sequence },
          },
          data: {
            status: input.state,
            lastProviderSequence: input.sequence,
            ...(input.errorCode === undefined ? {} : { lastErrorCode: input.errorCode }),
            ...(terminal
              ? {
                  nextAction: 'NONE',
                  nextPollAt: null,
                  pollLeaseToken: null,
                  pollLeaseExpiresAt: null,
                }
              : {}),
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new Error('STALE_CALLBACK_EXECUTION');
        const attempt = await transaction.providerAttempt.updateMany({
          where: {
            executionId: execution.id,
            attemptNumber: execution.currentAttempt,
          },
          data: {
            status: input.state,
            providerTaskId: input.providerTaskId,
            ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
            ...(terminal ? { completedAt: input.receivedAt } : {}),
          },
        });
        if (attempt.count !== 1) throw new Error('CALLBACK_ATTEMPT_NOT_FOUND');
        await createOutbox(transaction, {
          id: input.outboxId,
          aggregateId: execution.taskId,
          eventType: eventTypeForState(input.state),
          eventVersion: 1,
          deduplicationKey: callbackDeduplicationKey(execution.id, input.providerEventId),
          payload: {
            executionId: execution.id,
            taskId: execution.taskId,
            providerId: input.providerId,
            providerTaskId: input.providerTaskId,
            attemptNumber: execution.currentAttempt,
            providerEventId: input.providerEventId,
            sequence: input.sequence,
            status: input.state,
            ...(input.resultUrls === undefined ? {} : { resultUrls: input.resultUrls }),
            ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
          },
          headers: {
            traceId: execution.traceId,
            correlationId: execution.correlationId,
            providerEventId: input.providerEventId,
          },
          occurredAt: input.receivedAt,
          availableAt: input.receivedAt,
        });
        await transaction.callbackInbox.update({
          where: {
            providerId_providerEventId: {
              providerId: input.providerId,
              providerEventId: input.providerEventId,
            },
          },
          data: { processedAt: input.receivedAt, outcome: 'APPLIED' },
        });
        return { kind: 'APPLIED' };
      });
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      const prior = await this.prisma.callbackInbox.findUnique({
        where: {
          providerId_providerEventId: {
            providerId: input.providerId,
            providerEventId: input.providerEventId,
          },
        },
        select: {
          payloadSha256: true,
          providerTaskId: true,
          execution: { select: { providerId: true } },
        },
      });
      if (prior === null) throw error;
      return duplicateCallback(prior, input);
    }
  }
}

export class PrismaPollRepository implements PollRepository {
  constructor(private readonly prisma: PrismaClient) {}

  claim(input: ClaimPollInput): Promise<ClaimPollResult> {
    if (input.receivedAt.getTime() < input.dueAt.getTime())
      return Promise.resolve({ kind: 'NOT_DUE' });
    return this.prisma.$transaction(async (transaction) => {
      const inbox = await transaction.inboxMessage.findUnique({
        where: { consumer_messageId: { consumer: input.consumer, messageId: input.messageId } },
        select: { payloadSha256: true, processedAt: true },
      });
      if (inbox !== null && inbox.payloadSha256 !== input.payloadSha256)
        throw new Error('MESSAGE_PAYLOAD_CONFLICT');
      if (inbox?.processedAt) return { kind: 'DUPLICATE_COMPLETE' };
      if (inbox === null)
        await transaction.inboxMessage.create({
          data: {
            id: input.messageId,
            consumer: input.consumer,
            messageId: input.messageId,
            eventType: input.eventType,
            payloadSha256: input.payloadSha256,
            receivedAt: input.receivedAt,
          },
        });
      for (let retry = 0; retry < 2; retry += 1) {
        const execution = await transaction.providerExecution.findUnique({
          where: { id: input.executionId },
          select: {
            id: true,
            taskId: true,
            providerId: true,
            modelCode: true,
            providerTaskId: true,
            status: true,
            currentAttempt: true,
            pollCount: true,
            nextPollAt: true,
            pollLeaseToken: true,
            pollLeaseExpiresAt: true,
            version: true,
          },
        });
        if (execution === null) throw new Error('POLL_EXECUTION_NOT_FOUND');
        if (isTerminalProviderStatus(execution.status)) {
          await finishPollInbox(transaction, input, input.receivedAt, 'TERMINAL');
          return { kind: 'TERMINAL' };
        }
        if (execution.status === 'AMBIGUOUS' && execution.providerTaskId === null) {
          await finishPollInbox(transaction, input, input.receivedAt, 'MANUAL_RECONCILE');
          return { kind: 'MANUAL_RECONCILE' };
        }
        if (
          execution.taskId !== input.taskId ||
          execution.providerId !== input.providerId ||
          execution.modelCode !== input.modelCode ||
          execution.providerTaskId !== input.providerTaskId ||
          execution.currentAttempt !== input.attemptNumber ||
          execution.pollCount + 1 !== input.pollNumber
        )
          throw new Error('STALE_POLL_EVENT');
        if (
          execution.nextPollAt === null ||
          execution.nextPollAt.getTime() > input.receivedAt.getTime()
        )
          return { kind: 'NOT_DUE' };
        if (
          execution.pollLeaseToken !== null &&
          execution.pollLeaseExpiresAt !== null &&
          execution.pollLeaseExpiresAt.getTime() > input.receivedAt.getTime()
        )
          return { kind: 'DUPLICATE_PENDING' };
        const claimed = await transaction.providerExecution.updateMany({
          where: {
            id: execution.id,
            version: execution.version,
            status: execution.status,
            currentAttempt: input.attemptNumber,
            pollCount: input.pollNumber - 1,
            nextPollAt: { lte: input.receivedAt },
            OR: [
              { pollLeaseToken: null },
              { pollLeaseExpiresAt: null },
              { pollLeaseExpiresAt: { lte: input.receivedAt } },
            ],
          },
          data: {
            pollLeaseToken: input.leaseToken,
            pollLeaseExpiresAt: input.leaseExpiresAt,
            version: { increment: 1 },
          },
        });
        if (claimed.count !== 1) continue;
        return {
          kind: 'CLAIMED',
          executionId: execution.id,
          taskId: execution.taskId,
          attemptNumber: execution.currentAttempt,
          pollNumber: input.pollNumber,
          providerTaskId: input.providerTaskId,
          leaseToken: input.leaseToken,
        };
      }
      const latest = await transaction.providerExecution.findUnique({
        where: { id: input.executionId },
        select: { status: true, providerTaskId: true },
      });
      if (latest === null) throw new Error('POLL_EXECUTION_NOT_FOUND');
      if (isTerminalProviderStatus(latest.status)) {
        await finishPollInbox(transaction, input, input.receivedAt, 'TERMINAL');
        return { kind: 'TERMINAL' };
      }
      if (latest.status === 'AMBIGUOUS' && latest.providerTaskId === null) {
        await finishPollInbox(transaction, input, input.receivedAt, 'MANUAL_RECONCILE');
        return { kind: 'MANUAL_RECONCILE' };
      }
      return { kind: 'DUPLICATE_PENDING' };
    });
  }

  complete(input: CompletePollInput): Promise<void> {
    return this.prisma.$transaction(async (transaction) => {
      const inbox = await transaction.inboxMessage.findUnique({
        where: { consumer_messageId: { consumer: input.consumer, messageId: input.messageId } },
        select: { payloadSha256: true, processedAt: true },
      });
      if (inbox === null) throw new Error('POLL_INBOX_NOT_FOUND');
      if (inbox.payloadSha256 !== input.payloadSha256) throw new Error('MESSAGE_PAYLOAD_CONFLICT');
      if (inbox.processedAt !== null) return;
      for (let retry = 0; retry < 3; retry += 1) {
        const execution = await transaction.providerExecution.findUnique({
          where: { id: input.executionId },
          select: {
            id: true,
            status: true,
            currentAttempt: true,
            pollCount: true,
            pollLeaseToken: true,
            version: true,
          },
        });
        if (execution === null) throw new Error('POLL_EXECUTION_NOT_FOUND');
        if (isTerminalProviderStatus(execution.status)) {
          await finishPollInbox(transaction, input, input.completedAt, 'TERMINAL');
          return;
        }
        if (
          execution.currentAttempt !== input.attemptNumber ||
          execution.pollCount !== input.pollNumber - 1 ||
          execution.pollLeaseToken !== input.leaseToken
        )
          throw new Error('STALE_POLL_CLAIM');
        const terminal = isTerminalProviderStatus(input.state);
        const applyState = providerRank(input.state) >= providerRank(execution.status);
        const updated = await transaction.providerExecution.updateMany({
          where: {
            id: input.executionId,
            version: execution.version,
            status: execution.status,
            currentAttempt: input.attemptNumber,
            pollCount: input.pollNumber - 1,
            pollLeaseToken: input.leaseToken,
          },
          data: {
            ...(applyState ? { status: input.state } : {}),
            pollCount: input.pollNumber,
            nextPollAt: input.nextPollAt ?? null,
            nextAction: terminal ? 'NONE' : 'POLL',
            pollLeaseToken: null,
            pollLeaseExpiresAt: null,
            ...(input.errorCode === undefined ? {} : { lastErrorCode: input.errorCode }),
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1) continue;
        if (applyState) {
          const attempt = await transaction.providerAttempt.updateMany({
            where: { executionId: input.executionId, attemptNumber: input.attemptNumber },
            data: {
              status: input.state,
              ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
              ...(terminal ? { completedAt: input.completedAt } : {}),
            },
          });
          if (attempt.count !== 1) throw new Error('POLL_ATTEMPT_NOT_FOUND');
        }
        if (applyState && execution.status !== input.state)
          await createOutbox(transaction, input.stateOutbox);
        if (!terminal && input.nextPollOutbox !== undefined)
          await createOutbox(transaction, input.nextPollOutbox);
        await finishPollInbox(
          transaction,
          input,
          input.completedAt,
          applyState ? input.state : 'STATE_REGRESSION',
        );
        return;
      }
      throw new Error('STALE_POLL_CLAIM');
    });
  }

  defer(input: DeferPollInput): Promise<void> {
    return this.prisma.$transaction(async (transaction) => {
      const inbox = await transaction.inboxMessage.findUnique({
        where: { consumer_messageId: { consumer: input.consumer, messageId: input.messageId } },
        select: { payloadSha256: true, processedAt: true },
      });
      if (inbox === null) throw new Error('POLL_INBOX_NOT_FOUND');
      if (inbox.payloadSha256 !== input.payloadSha256) throw new Error('MESSAGE_PAYLOAD_CONFLICT');
      if (inbox.processedAt !== null) return;
      for (let retry = 0; retry < 3; retry += 1) {
        const execution = await transaction.providerExecution.findUnique({
          where: { id: input.executionId },
          select: {
            status: true,
            currentAttempt: true,
            pollCount: true,
            pollLeaseToken: true,
            version: true,
          },
        });
        if (execution === null) throw new Error('POLL_EXECUTION_NOT_FOUND');
        if (isTerminalProviderStatus(execution.status)) {
          await finishPollInbox(transaction, input, input.deferredAt, 'TERMINAL');
          return;
        }
        if (
          execution.currentAttempt !== input.attemptNumber ||
          execution.pollCount !== input.pollNumber - 1 ||
          execution.pollLeaseToken !== input.leaseToken
        )
          throw new Error('STALE_POLL_CLAIM');
        const updated = await transaction.providerExecution.updateMany({
          where: {
            id: input.executionId,
            version: execution.version,
            status: execution.status,
            currentAttempt: input.attemptNumber,
            pollCount: input.pollNumber - 1,
            pollLeaseToken: input.leaseToken,
          },
          data: {
            pollCount: input.pollNumber,
            nextPollAt: input.nextPollAt,
            nextAction: 'POLL',
            pollLeaseToken: null,
            pollLeaseExpiresAt: null,
            lastErrorCode: input.errorCode,
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1) continue;
        await createOutbox(transaction, input.nextPollOutbox);
        await finishPollInbox(transaction, input, input.deferredAt, 'DEFERRED');
        return;
      }
      throw new Error('STALE_POLL_CLAIM');
    });
  }
}

export class PrismaCircuitRepository implements CircuitRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ids: { next(): string },
  ) {}

  async acquire(input: Parameters<CircuitRepository['acquire']>[0]): Promise<CircuitAcquireResult> {
    for (let retry = 0; retry < 2; retry += 1) {
      try {
        return await this.prisma.$transaction(async (transaction) => {
          const state = await transaction.circuitState.upsert({
            where: {
              providerId_modelCode: {
                providerId: input.key.providerId,
                modelCode: input.key.modelCode,
              },
            },
            update: {},
            create: {
              id: this.ids.next(),
              ...input.key,
              status: 'CLOSED',
            },
          });
          if (state.status === 'CLOSED') return { kind: 'ALLOW', token: input.probeToken };
          if (
            state.status === 'OPEN' &&
            state.openUntil !== null &&
            state.openUntil.getTime() <= input.now.getTime()
          ) {
            const probe = await transaction.circuitState.updateMany({
              where: {
                id: state.id,
                version: state.version,
                status: 'OPEN',
                openUntil: { lte: input.now },
                halfOpenProbeInFlight: false,
              },
              data: {
                status: 'HALF_OPEN',
                halfOpenProbeInFlight: true,
                halfOpenProbeToken: input.probeToken,
                halfOpenProbeExpiresAt: new Date(input.now.getTime() + input.probeLeaseMs),
                version: { increment: 1 },
              },
            });
            if (probe.count === 1) return { kind: 'HALF_OPEN_PROBE', token: input.probeToken };
          }
          if (
            state.status === 'HALF_OPEN' &&
            state.halfOpenProbeExpiresAt !== null &&
            state.halfOpenProbeExpiresAt.getTime() <= input.now.getTime()
          ) {
            const replacement = await transaction.circuitState.updateMany({
              where: {
                id: state.id,
                version: state.version,
                status: 'HALF_OPEN',
                halfOpenProbeInFlight: true,
                halfOpenProbeExpiresAt: { lte: input.now },
              },
              data: {
                halfOpenProbeToken: input.probeToken,
                halfOpenProbeExpiresAt: new Date(input.now.getTime() + input.probeLeaseMs),
                version: { increment: 1 },
              },
            });
            if (replacement.count === 1)
              return { kind: 'HALF_OPEN_PROBE', token: input.probeToken };
          }
          return { kind: 'REJECT', reason: 'OPEN' };
        });
      } catch (error) {
        if (!isUniqueConstraint(error) || retry === 1) throw error;
      }
    }
    return { kind: 'REJECT', reason: 'OPEN' };
  }

  async record(input: Parameters<CircuitRepository['record']>[0]): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const candidate = await transaction.circuitState.findUnique({
        where: {
          providerId_modelCode: {
            providerId: input.key.providerId,
            modelCode: input.key.modelCode,
          },
        },
        select: { id: true },
      });
      if (candidate === null) throw new Error('CIRCUIT_NOT_FOUND');
      await transaction.$queryRaw`
        SELECT "id"
        FROM "CircuitState"
        WHERE "id" = ${candidate.id}::uuid
        FOR UPDATE
      `;
      const state = await transaction.circuitState.findUnique({
        where: {
          providerId_modelCode: {
            providerId: input.key.providerId,
            modelCode: input.key.modelCode,
          },
        },
      });
      if (state === null) throw new Error('CIRCUIT_NOT_FOUND');
      if (input.permit.kind === 'HALF_OPEN_PROBE') {
        const probe = await transaction.circuitState.updateMany({
          where: {
            id: state.id,
            status: 'HALF_OPEN',
            halfOpenProbeInFlight: true,
            halfOpenProbeToken: input.permit.token,
            halfOpenProbeExpiresAt: { gt: input.now },
          },
          data:
            input.outcome === 'SUCCESS'
              ? {
                  status: 'CLOSED',
                  halfOpenProbeInFlight: false,
                  halfOpenProbeToken: null,
                  halfOpenProbeExpiresAt: null,
                  openedAt: null,
                  openUntil: null,
                  reasonCode: null,
                  windowRequests: 0,
                  windowFailures: 0,
                  version: { increment: 1 },
                }
              : {
                  status: 'OPEN',
                  halfOpenProbeInFlight: false,
                  halfOpenProbeToken: null,
                  halfOpenProbeExpiresAt: null,
                  openedAt: input.now,
                  openUntil: new Date(input.now.getTime() + input.openDurationMs),
                  reasonCode: 'HALF_OPEN_PROBE_FAILED',
                  version: { increment: 1 },
                },
        });
        if (probe.count !== 1) throw new Error('STALE_HALF_OPEN_PROBE');
        if (input.outcome === 'SUCCESS')
          await transaction.circuitObservation.deleteMany({ where: { circuitId: state.id } });
        return;
      }
      const cutoff = new Date(input.now.getTime() - input.windowMs);
      await transaction.circuitObservation.deleteMany({
        where: { circuitId: state.id, observedAt: { lte: cutoff } },
      });
      await transaction.circuitObservation.create({
        data: {
          id: this.ids.next(),
          circuitId: state.id,
          failed: input.outcome === 'QUALIFYING_FAILURE',
          observedAt: input.now,
        },
      });
      if (state.status !== 'CLOSED') return;
      const [samples, failures] = await Promise.all([
        transaction.circuitObservation.count({ where: { circuitId: state.id } }),
        transaction.circuitObservation.count({ where: { circuitId: state.id, failed: true } }),
      ]);
      const shouldOpen =
        failures >= input.minimumFailures && failures / samples >= input.failureThreshold;
      await transaction.circuitState.update({
        where: { id: state.id },
        data: {
          windowStartedAt: cutoff,
          windowRequests: samples,
          windowFailures: failures,
          ...(shouldOpen
            ? {
                status: 'OPEN',
                openedAt: input.now,
                openUntil: new Date(input.now.getTime() + input.openDurationMs),
                reasonCode: 'FAILURE_RATE',
              }
            : {}),
          version: { increment: 1 },
        },
      });
    });
  }

  tripImmediately(input: Parameters<CircuitRepository['tripImmediately']>[0]): Promise<void> {
    return this.prisma.$transaction(async (transaction) => {
      const state = await transaction.circuitState.upsert({
        where: {
          providerId_modelCode: {
            providerId: input.key.providerId,
            modelCode: input.key.modelCode,
          },
        },
        update: {
          status: 'OPEN',
          openedAt: input.now,
          openUntil: input.openUntil,
          halfOpenProbeInFlight: false,
          halfOpenProbeToken: null,
          halfOpenProbeExpiresAt: null,
          reasonCode: input.reason,
          version: { increment: 1 },
        },
        create: {
          id: this.ids.next(),
          ...input.key,
          status: 'OPEN',
          openedAt: input.now,
          openUntil: input.openUntil,
          reasonCode: input.reason,
        },
      });
      const deduplicationKey = `${state.id}:${input.reason}:${input.now.toISOString()}`;
      await transaction.outboxEvent.upsert({
        where: { deduplicationKey },
        update: {},
        create: {
          id: input.outbox.id,
          aggregateType: 'ProviderExecution',
          aggregateId: input.outbox.aggregateId,
          eventType: input.outbox.eventType,
          eventVersion: 1,
          deduplicationKey,
          payload: input.outbox.payload as unknown as Prisma.InputJsonValue,
          headers: {},
          occurredAt: input.outbox.occurredAt,
          availableAt: input.outbox.occurredAt,
        },
      });
    });
  }
}

export function createPrismaLifecycleRepositories(
  prisma: PrismaClient,
  ids: { next(): string },
): {
  readonly callbacks: PrismaCallbackRepository;
  readonly polling: PrismaPollRepository;
  readonly circuit: PrismaCircuitRepository;
} {
  return {
    callbacks: new PrismaCallbackRepository(prisma),
    polling: new PrismaPollRepository(prisma),
    circuit: new PrismaCircuitRepository(prisma, ids),
  };
}

function duplicateCallback(
  existing: {
    readonly payloadSha256: string;
    readonly providerTaskId: string;
    readonly execution: { readonly providerId: string };
  },
  incoming: Pick<ApplyCallbackInput, 'payloadSha256' | 'providerTaskId' | 'providerId'>,
): ApplyCallbackResult {
  if (
    existing.payloadSha256 !== incoming.payloadSha256 ||
    existing.providerTaskId !== incoming.providerTaskId ||
    existing.execution.providerId !== incoming.providerId
  )
    throw new ProviderCallbackError('CALLBACK_EVENT_CONFLICT', 409);
  return { kind: 'DUPLICATE' };
}

async function finishPollInbox(
  transaction: Transaction,
  input: Pick<ClaimPollInput, 'consumer' | 'messageId' | 'payloadSha256'>,
  at: Date,
  outcome: string,
): Promise<void> {
  const updated = await transaction.inboxMessage.updateMany({
    where: {
      consumer: input.consumer,
      messageId: input.messageId,
      payloadSha256: input.payloadSha256,
      processedAt: null,
    },
    data: { processedAt: at, lastError: outcome },
  });
  if (updated.count !== 1) throw new Error('STALE_POLL_INBOX');
}

function eventTypeForState(state: ObservableProviderStatus): PollOutboxEvent['eventType'] {
  return {
    ACCEPTED: 'provider.execution-accepted.v1',
    RUNNING: 'provider.execution-running.v1',
    SUCCEEDED: 'provider.execution-succeeded.v1',
    FAILED: 'provider.execution-failed.v1',
    CANCELED: 'provider.execution-canceled.v1',
  }[state] as PollOutboxEvent['eventType'];
}

function providerRank(status: string): number {
  return status === 'ACCEPTED'
    ? 1
    : status === 'RUNNING'
      ? 2
      : isTerminalProviderStatus(status)
        ? 3
        : 0;
}

function createOutbox(transaction: Transaction, outbox: PollOutboxEvent): Promise<unknown> {
  return transaction.outboxEvent.create({
    data: {
      id: outbox.id,
      aggregateType: 'ProviderExecution',
      aggregateId: outbox.aggregateId,
      eventType: outbox.eventType,
      eventVersion: outbox.eventVersion,
      deduplicationKey: outbox.deduplicationKey,
      payload: outbox.payload as unknown as Prisma.InputJsonValue,
      headers: outbox.headers as unknown as Prisma.InputJsonValue,
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
