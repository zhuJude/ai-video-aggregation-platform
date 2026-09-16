import { createHash } from 'node:crypto';
import { EventEnvelopeSchema, PointsStringSchema, UuidSchema } from '@repo/contracts/common';
import type { VideoProviderAdapter } from '@repo/provider-sdk';
import { z } from 'zod';
import { canonicalJson, StrictJsonError } from '../domain/canonical-json.js';
import type {
  CircuitAcquireResult,
  CircuitKey,
  CircuitOutcome,
  CircuitPermit,
  ImmediateCircuitReason,
} from '../domain/circuit-breaker.js';
import {
  backoffMs,
  classifyProviderFailure,
  type ProviderFailure,
} from '../domain/retry-policy.js';

export const QueuedConsumerName = 'provider-runtime:generation-task-queued:v1' as const;
export const RetryConsumerName = 'provider-runtime:execution-retry-scheduled:v1' as const;
export type ConsumerName = typeof QueuedConsumerName | typeof RetryConsumerName;

const QueuedTaskDataSchema = z.strictObject({
  taskId: UuidSchema,
  userId: UuidSchema,
  quoteId: UuidSchema,
  capabilityVersionId: UuidSchema,
  status: z.literal('QUEUED'),
  taskVersion: z.int().positive(),
  quotedPoints: PointsStringSchema,
  parametersSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const RetryDataSchema = z.strictObject({
  executionId: UuidSchema,
  taskId: UuidSchema,
  capabilityVersionId: UuidSchema,
  parametersSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  providerId: UuidSchema,
  modelCode: z.string().min(1).max(160),
  priorAttemptNumber: z.int().positive(),
  dueAt: z.iso.datetime({ offset: true }),
});
type QueuedTaskData = z.infer<typeof QueuedTaskDataSchema>;
type RetryData = z.infer<typeof RetryDataSchema>;

export interface ResolvedDispatch {
  readonly taskId: string;
  readonly capabilityVersionId: string;
  readonly parametersSnapshotSha256: string;
  readonly providerId: string;
  readonly modelCode: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly adapter: VideoProviderAdapter;
  readonly callbackMode?: 'EXPECTED' | 'UNAVAILABLE';
  readonly callbackDeadlineMs?: number;
  readonly pollIntervalMs?: number;
}
export interface DispatchResolver {
  resolve(input: {
    readonly taskId: string;
    readonly capabilityVersionId: string;
    readonly parametersSnapshotSha256: string;
  }): Promise<ResolvedDispatch | null>;
}

export interface PendingOutboxEvent {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType:
    | 'provider.execution-accepted.v1'
    | 'provider.execution-running.v1'
    | 'provider.execution-succeeded.v1'
    | 'provider.execution-canceled.v1'
    | 'provider.execution-failed.v1'
    | 'provider.execution-retry-scheduled.v1'
    | 'provider.execution-ambiguous.v1'
    | 'provider.execution-late-result.v1'
    | 'provider.security-binding-rejected.v1'
    | 'provider.execution-poll-due.v1'
    | 'provider.health.auth-failed.v1'
    | 'provider.health.zero-balance.v1';
  readonly eventVersion: 1;
  readonly deduplicationKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly availableAt: Date;
}

export interface BeginExecutionInput {
  readonly consumer: typeof QueuedConsumerName;
  readonly messageId: string;
  readonly eventType: 'generation.task-queued.v1';
  readonly payloadSha256: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly capabilityVersionId: string;
  readonly parametersSnapshotSha256: string;
  readonly providerId: string;
  readonly modelCode: string;
  readonly idempotencyKey: string;
  readonly traceId: string;
  readonly correlationId: string;
  readonly receivedAt: Date;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly takeoverOutbox: PendingOutboxEvent;
  readonly bindingMismatchOutbox: PendingOutboxEvent;
}
export type BeginExecutionResult =
  | {
      readonly kind: 'STARTED';
      readonly executionId: string;
      readonly attemptId: string;
      readonly attemptNumber: number;
      readonly leaseToken: string;
    }
  | { readonly kind: 'RECOVERED_AMBIGUOUS' }
  | { readonly kind: 'REJECTED_BINDING' }
  | { readonly kind: 'DUPLICATE_COMPLETE' }
  | { readonly kind: 'DUPLICATE_PENDING' };

export interface PreflightQueuedInput {
  readonly consumer: typeof QueuedConsumerName;
  readonly messageId: string;
  readonly eventType: 'generation.task-queued.v1';
  readonly payloadSha256: string;
  readonly taskId: string;
  readonly capabilityVersionId: string;
  readonly parametersSnapshotSha256: string;
  readonly receivedAt: Date;
  readonly bindingMismatchOutbox: PendingOutboxEvent;
}

export interface ClaimRetryInput {
  readonly consumer: typeof RetryConsumerName;
  readonly messageId: string;
  readonly eventType: 'provider.execution-retry-scheduled.v1';
  readonly payloadSha256: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly capabilityVersionId: string;
  readonly parametersSnapshotSha256: string;
  readonly providerId: string;
  readonly modelCode: string;
  readonly priorAttemptNumber: number;
  readonly dueAt: Date;
  readonly receivedAt: Date;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly maxAttempts: number;
  readonly traceId: string;
  readonly correlationId: string;
  readonly exhaustedOutbox: PendingOutboxEvent;
  readonly takeoverOutbox: PendingOutboxEvent;
}
export type ClaimRetryResult =
  | {
      readonly kind: 'CLAIMED';
      readonly executionId: string;
      readonly attemptId: string;
      readonly attemptNumber: number;
      readonly leaseToken: string;
    }
  | { readonly kind: 'NOT_DUE' }
  | { readonly kind: 'MAX_ATTEMPTS' }
  | { readonly kind: 'RECOVERED_AMBIGUOUS' }
  | { readonly kind: 'DUPLICATE_COMPLETE' }
  | { readonly kind: 'DUPLICATE_PENDING' };

export type ExecutionCompletionStatus =
  'ACCEPTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'RETRY_SCHEDULED' | 'AMBIGUOUS';
export interface CompleteExecutionInput {
  readonly consumer: ConsumerName;
  readonly messageId: string;
  readonly payloadSha256: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly leaseToken: string;
  readonly status: ExecutionCompletionStatus;
  readonly providerTaskId?: string;
  readonly errorCode?: string;
  readonly httpStatus?: number;
  readonly nextAction: 'NONE' | 'CREATE_RETRY' | 'RECONCILE' | 'POLL';
  readonly nextAttemptAt?: Date;
  readonly completedAt: Date;
  readonly outbox: PendingOutboxEvent;
  readonly pollSchedule?: {
    readonly callbackExpected: boolean;
    readonly callbackDeadlineAt?: Date;
    readonly nextPollAt: Date;
    readonly outbox: PendingOutboxEvent;
  };
}
export interface CommitAmbiguityInput {
  readonly consumer: ConsumerName;
  readonly messageId: string;
  readonly payloadSha256: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly leaseToken: string;
  readonly providerTaskId?: string;
  readonly errorCode: 'POST_ACCEPTANCE_PERSISTENCE_FAILED';
  readonly completedAt: Date;
  readonly outbox: PendingOutboxEvent;
}
export interface RecordLateResultInput {
  readonly executionId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly leaseToken: string;
  readonly providerTaskId?: string;
  readonly providerState?: 'ACCEPTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  readonly diagnosticCode?: string;
  readonly observedAt: Date;
  readonly outbox: PendingOutboxEvent;
}
export interface ExecutionRepository {
  preflightQueued(input: PreflightQueuedInput): Promise<'CONTINUE' | 'REJECTED_BINDING'>;
  begin(input: BeginExecutionInput): Promise<BeginExecutionResult>;
  claimRetry(input: ClaimRetryInput): Promise<ClaimRetryResult>;
  complete(input: CompleteExecutionInput): Promise<void>;
  recordCommitAmbiguity(input: CommitAmbiguityInput): Promise<void>;
  recordLateResult(input: RecordLateResultInput): Promise<boolean>;
}
export interface ProviderCircuitGate {
  acquire(key: CircuitKey): Promise<CircuitAcquireResult>;
  record(key: CircuitKey, permit: CircuitPermit, outcome: CircuitOutcome): Promise<void>;
  tripImmediately(key: CircuitKey, reason: ImmediateCircuitReason): Promise<void>;
}
export interface ProviderExecutionResult {
  readonly ack: boolean;
  readonly outcome:
    | 'ACCEPTED'
    | 'RUNNING'
    | 'SUCCEEDED'
    | 'CANCELED'
    | 'FAILED'
    | 'RETRY_SCHEDULED'
    | 'AMBIGUOUS'
    | 'NOT_DUE'
    | 'DUPLICATE_COMPLETE'
    | 'DUPLICATE_PENDING'
    | 'REJECTED_BINDING';
}
export class ProviderRuntimeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ProviderRuntimeError';
  }
}

interface Dependencies {
  readonly repository: ExecutionRepository;
  readonly resolver: DispatchResolver;
  readonly clock: { now(): Date };
  readonly ids: { next(): string };
  readonly maxAttempts?: number;
  readonly leaseDurationMs?: number;
  readonly createTimeoutMs?: number;
  readonly timers?: {
    set(callback: () => void, delayMs: number): unknown;
    clear(handle: unknown): void;
  };
  readonly circuit: ProviderCircuitGate;
}
interface ParsedEvent<T> {
  readonly id: string;
  readonly type: 'generation.task-queued.v1' | 'provider.execution-retry-scheduled.v1';
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly data: T;
}
interface ActiveExecution {
  readonly event: ParsedEvent<QueuedTaskData | RetryData>;
  readonly dispatch: ResolvedDispatch;
  readonly consumer: ConsumerName;
  readonly payloadSha256: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly leaseToken: string;
}

export class ProviderExecutionService {
  private readonly maxAttempts: number;
  private readonly leaseDurationMs: number;
  private readonly createTimeoutMs: number;
  private readonly timers: NonNullable<Dependencies['timers']>;
  constructor(private readonly dependencies: Dependencies) {
    this.maxAttempts = dependencies.maxAttempts ?? 5;
    this.leaseDurationMs = dependencies.leaseDurationMs ?? 60_000;
    this.createTimeoutMs = dependencies.createTimeoutMs ?? 30_000;
    this.timers = dependencies.timers ?? {
      set: (callback, delayMs) => setTimeout(callback, delayMs),
      clear: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    };
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1)
      throw new ProviderRuntimeError('INVALID_MAX_ATTEMPTS');
    if (!Number.isInteger(this.leaseDurationMs) || this.leaseDurationMs < 1)
      throw new ProviderRuntimeError('INVALID_LEASE_DURATION');
    if (!Number.isInteger(this.createTimeoutMs) || this.createTimeoutMs < 1)
      throw new ProviderRuntimeError('INVALID_CREATE_TIMEOUT');
  }

  async handle(rawEvent: unknown): Promise<ProviderExecutionResult> {
    if (
      typeof rawEvent === 'object' &&
      rawEvent !== null &&
      'type' in rawEvent &&
      rawEvent.type === 'provider.execution-retry-scheduled.v1'
    ) {
      return this.handleRetry(rawEvent);
    }
    return this.handleQueued(rawEvent);
  }

  private async handleQueued(rawEvent: unknown): Promise<ProviderExecutionResult> {
    const event = parseQueuedEvent(rawEvent);
    const payloadSha256 = sha256(rawEvent);
    const now = this.dependencies.clock.now();
    const bindingMismatchOutbox: PendingOutboxEvent = {
      id: this.dependencies.ids.next(),
      aggregateId: event.data.taskId,
      eventType: 'provider.security-binding-rejected.v1',
      eventVersion: 1,
      deduplicationKey: `${event.id}:provider.security-binding-rejected.v1`,
      payload: {
        taskId: event.data.taskId,
        capabilityVersionId: event.data.capabilityVersionId,
        parametersSnapshotSha256: event.data.parametersSnapshotSha256,
        errorCode: 'IMMUTABLE_BINDING_MISMATCH',
        securityDisposition: true,
        terminal: false,
      },
      headers: {
        traceId: event.traceId,
        correlationId: event.correlationId,
        causationId: event.id,
      },
      occurredAt: now,
      availableAt: now,
    };
    const preflight = await this.dependencies.repository.preflightQueued({
      consumer: QueuedConsumerName,
      messageId: event.id,
      eventType: 'generation.task-queued.v1',
      payloadSha256,
      taskId: event.data.taskId,
      capabilityVersionId: event.data.capabilityVersionId,
      parametersSnapshotSha256: event.data.parametersSnapshotSha256,
      receivedAt: now,
      bindingMismatchOutbox,
    });
    if (preflight === 'REJECTED_BINDING') return { ack: true, outcome: 'REJECTED_BINDING' };
    const dispatch = await this.resolve(event.data);
    const executionId = this.dependencies.ids.next();
    const attemptId = this.dependencies.ids.next();
    const leaseToken = fencingToken(event.id, attemptId);
    const begun = await this.dependencies.repository.begin({
      consumer: QueuedConsumerName,
      messageId: event.id,
      eventType: 'generation.task-queued.v1',
      payloadSha256,
      executionId,
      attemptId,
      taskId: event.data.taskId,
      capabilityVersionId: event.data.capabilityVersionId,
      parametersSnapshotSha256: event.data.parametersSnapshotSha256,
      providerId: dispatch.providerId,
      modelCode: dispatch.modelCode,
      idempotencyKey: event.data.taskId,
      traceId: event.traceId,
      correlationId: event.correlationId,
      receivedAt: now,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs),
      takeoverOutbox: this.outboxFor(
        event,
        dispatch,
        executionId,
        1,
        'provider.execution-ambiguous.v1',
        'AMBIGUOUS',
        now,
        { errorCode: 'STALE_SUBMISSION_LEASE', repairRequired: true },
      ),
      bindingMismatchOutbox: {
        ...bindingMismatchOutbox,
        payload: {
          ...bindingMismatchOutbox.payload,
          providerId: dispatch.providerId,
          modelCode: dispatch.modelCode,
        },
      },
    });
    if (begun.kind === 'DUPLICATE_COMPLETE') return duplicateComplete();
    if (begun.kind === 'DUPLICATE_PENDING') return duplicatePending();
    if (begun.kind === 'RECOVERED_AMBIGUOUS') return { ack: true, outcome: 'AMBIGUOUS' };
    if (begun.kind === 'REJECTED_BINDING') return { ack: true, outcome: 'REJECTED_BINDING' };
    return this.invoke({ event, dispatch, consumer: QueuedConsumerName, payloadSha256, ...begun });
  }

  private async handleRetry(rawEvent: unknown): Promise<ProviderExecutionResult> {
    const event = parseRetryEvent(rawEvent);
    const payloadSha256 = sha256(rawEvent);
    const dispatch = await this.resolve(event.data);
    if (
      dispatch.providerId !== event.data.providerId ||
      dispatch.modelCode !== event.data.modelCode
    )
      throw new ProviderRuntimeError('DISPATCH_ROUTE_MISMATCH');
    const now = this.dependencies.clock.now();
    const attemptId = this.dependencies.ids.next();
    const leaseToken = fencingToken(event.id, attemptId);
    const claim = await this.dependencies.repository.claimRetry({
      consumer: RetryConsumerName,
      messageId: event.id,
      eventType: 'provider.execution-retry-scheduled.v1',
      payloadSha256,
      executionId: event.data.executionId,
      attemptId,
      taskId: event.data.taskId,
      capabilityVersionId: event.data.capabilityVersionId,
      parametersSnapshotSha256: event.data.parametersSnapshotSha256,
      providerId: event.data.providerId,
      modelCode: event.data.modelCode,
      priorAttemptNumber: event.data.priorAttemptNumber,
      dueAt: new Date(event.data.dueAt),
      receivedAt: now,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs),
      maxAttempts: this.maxAttempts,
      traceId: event.traceId,
      correlationId: event.correlationId,
      exhaustedOutbox: this.outboxFor(
        event,
        dispatch,
        event.data.executionId,
        event.data.priorAttemptNumber,
        'provider.execution-failed.v1',
        'FAILED',
        now,
        { errorCode: 'MAX_ATTEMPTS_EXHAUSTED', nextAction: 'NONE' },
      ),
      takeoverOutbox: this.outboxFor(
        event,
        dispatch,
        event.data.executionId,
        event.data.priorAttemptNumber + 1,
        'provider.execution-ambiguous.v1',
        'AMBIGUOUS',
        now,
        { errorCode: 'STALE_SUBMISSION_LEASE', repairRequired: true },
      ),
    });
    if (claim.kind === 'NOT_DUE') return { ack: false, outcome: 'NOT_DUE' };
    if (claim.kind === 'DUPLICATE_PENDING') return duplicatePending();
    if (claim.kind === 'DUPLICATE_COMPLETE') return duplicateComplete();
    if (claim.kind === 'MAX_ATTEMPTS') return { ack: true, outcome: 'FAILED' };
    if (claim.kind === 'RECOVERED_AMBIGUOUS') return { ack: true, outcome: 'AMBIGUOUS' };
    return this.invoke({ event, dispatch, consumer: RetryConsumerName, payloadSha256, ...claim });
  }

  private async resolve(
    data: Pick<QueuedTaskData, 'taskId' | 'capabilityVersionId' | 'parametersSnapshotSha256'>,
  ): Promise<ResolvedDispatch> {
    const dispatch = await this.dependencies.resolver.resolve(data);
    if (dispatch === null) throw new ProviderRuntimeError('DISPATCH_NOT_FOUND');
    validateDispatch(data, dispatch);
    return dispatch;
  }

  private async invoke(active: ActiveExecution): Promise<ProviderExecutionResult> {
    const circuitKey = {
      providerId: active.dispatch.providerId,
      modelCode: active.dispatch.modelCode,
    };
    const permit = await this.acquireCircuit(circuitKey);
    if (permit === null) return this.completeCircuitOpen(active);
    let raced: Awaited<ReturnType<ProviderExecutionService['createWithDeadline']>>;
    try {
      raced = await this.createWithDeadline(active);
    } catch (error) {
      const failure = classifyProviderFailure(error);
      await this.recordCircuitFailure(circuitKey, permit, failure);
      return this.completeFailure(active, failure);
    }
    if (raced.kind === 'TIMED_OUT') {
      const timeoutFailure = {
        kind: 'TIMEOUT' as const,
        retryable: true as const,
        ambiguous: true as const,
        code: 'PROVIDER_TIMEOUT' as const,
      };
      await this.recordCircuitFailure(circuitKey, permit, timeoutFailure);
      const completion = this.completeFailure(active, {
        ...timeoutFailure,
      });
      this.observeLateResult(active, raced.operation, completion);
      return completion;
    }
    const created: Awaited<ReturnType<VideoProviderAdapter['createTask']>> = raced.result;
    if (!isValidCreateResult(created)) {
      const failure = {
        kind: 'UNKNOWN',
        retryable: false,
        ambiguous: false,
        code: 'PROVIDER_PROTOCOL_ERROR',
      } as const;
      await this.recordCircuitFailure(circuitKey, permit, failure);
      return this.completeFailure(active, failure);
    }
    await this.dependencies.circuit.record(circuitKey, permit, 'SUCCESS');
    const completedAt = this.dependencies.clock.now();
    const pollSchedule =
      created.state === 'ACCEPTED' || created.state === 'RUNNING'
        ? this.initialPollSchedule(active, created.providerTaskId, completedAt)
        : undefined;
    const completion: CompleteExecutionInput = {
      ...completionIdentity(active),
      status: created.state,
      providerTaskId: created.providerTaskId,
      nextAction: pollSchedule === undefined ? 'NONE' : 'POLL',
      completedAt,
      outbox: this.outbox(active, eventTypeForState(created.state), created.state, completedAt, {
        providerTaskId: created.providerTaskId,
      }),
      ...(pollSchedule === undefined ? {} : { pollSchedule }),
    };
    try {
      await this.dependencies.repository.complete(completion);
      return { ack: true, outcome: created.state };
    } catch {
      const ambiguity: CommitAmbiguityInput = {
        ...completionIdentity(active),
        providerTaskId: created.providerTaskId,
        errorCode: 'POST_ACCEPTANCE_PERSISTENCE_FAILED',
        completedAt,
        outbox: this.outbox(active, 'provider.execution-ambiguous.v1', 'AMBIGUOUS', completedAt, {
          providerTaskId: created.providerTaskId,
          errorCode: 'POST_ACCEPTANCE_PERSISTENCE_FAILED',
          repairRequired: true,
        }),
      };
      await this.dependencies.repository.recordCommitAmbiguity(ambiguity);
      return { ack: true, outcome: 'AMBIGUOUS' };
    }
  }

  private async acquireCircuit(key: CircuitKey): Promise<CircuitPermit | null> {
    const permit = await this.dependencies.circuit.acquire(key);
    return permit.kind === 'REJECT' ? null : permit;
  }

  private async recordCircuitFailure(
    key: CircuitKey,
    permit: CircuitPermit,
    failure: ProviderFailure,
  ): Promise<void> {
    const circuit = this.dependencies.circuit;
    if (failure.code === 'PROVIDER_AUTH_FAILED') {
      await circuit.tripImmediately(key, 'AUTH_FAILURE');
      return;
    }
    const qualifying =
      failure.ambiguous ||
      failure.code === 'PROVIDER_RATE_LIMITED' ||
      failure.code === 'PROVIDER_UNAVAILABLE' ||
      failure.code === 'PROVIDER_PROTOCOL_ERROR';
    await circuit.record(key, permit, qualifying ? 'QUALIFYING_FAILURE' : 'SUCCESS');
  }

  private async completeCircuitOpen(active: ActiveExecution): Promise<ProviderExecutionResult> {
    const completedAt = this.dependencies.clock.now();
    await this.dependencies.repository.complete({
      ...completionIdentity(active),
      status: 'FAILED',
      errorCode: 'PROVIDER_CIRCUIT_OPEN',
      nextAction: 'NONE',
      completedAt,
      outbox: this.outbox(active, 'provider.execution-failed.v1', 'FAILED', completedAt, {
        errorCode: 'PROVIDER_CIRCUIT_OPEN',
        nextAction: 'NONE',
      }),
    });
    return { ack: true, outcome: 'FAILED' };
  }

  private initialPollSchedule(
    active: ActiveExecution,
    providerTaskId: string,
    occurredAt: Date,
  ): NonNullable<CompleteExecutionInput['pollSchedule']> {
    const callbackExpected = (active.dispatch.callbackMode ?? 'EXPECTED') === 'EXPECTED';
    const delayMs = callbackExpected
      ? (active.dispatch.callbackDeadlineMs ?? 120_000)
      : (active.dispatch.pollIntervalMs ?? 30_000);
    if (!Number.isInteger(delayMs) || delayMs < 1)
      throw new ProviderRuntimeError('INVALID_POLL_CONFIGURATION');
    const nextPollAt = new Date(occurredAt.getTime() + delayMs);
    const callbackDeadlineAt = callbackExpected ? nextPollAt : undefined;
    return {
      callbackExpected,
      ...(callbackDeadlineAt === undefined ? {} : { callbackDeadlineAt }),
      nextPollAt,
      outbox: {
        id: this.dependencies.ids.next(),
        aggregateId: active.event.data.taskId,
        eventType: 'provider.execution-poll-due.v1',
        eventVersion: 1,
        deduplicationKey: `${active.executionId}:poll:${String(active.attemptNumber)}:1`,
        payload: {
          executionId: active.executionId,
          taskId: active.event.data.taskId,
          providerId: active.dispatch.providerId,
          modelCode: active.dispatch.modelCode,
          providerTaskId,
          attemptNumber: active.attemptNumber,
          pollNumber: 1,
          dueAt: nextPollAt.toISOString(),
        },
        headers: {
          traceId: active.event.traceId,
          correlationId: active.event.correlationId,
          causationId: active.event.id,
        },
        occurredAt,
        availableAt: nextPollAt,
      },
    };
  }

  private async createWithDeadline(active: ActiveExecution): Promise<
    | {
        readonly kind: 'RESULT';
        readonly result: Awaited<ReturnType<VideoProviderAdapter['createTask']>>;
      }
    | {
        readonly kind: 'TIMED_OUT';
        readonly operation: Promise<Awaited<ReturnType<VideoProviderAdapter['createTask']>>>;
      }
  > {
    const operation = Promise.resolve().then(() =>
      active.dispatch.adapter.createTask({
        taskId: active.event.data.taskId,
        modelCode: active.dispatch.modelCode,
        parameters: { ...active.dispatch.parameters },
        idempotencyKey: active.event.data.taskId,
      }),
    );
    let timer: unknown;
    const deadline = new Promise<{ readonly kind: 'TIMED_OUT' }>((resolve) => {
      timer = this.timers.set(() => {
        resolve({ kind: 'TIMED_OUT' });
      }, this.createTimeoutMs);
    });
    try {
      const raced = await Promise.race([
        operation.then((result) => ({ kind: 'RESULT' as const, result })),
        deadline,
      ]);
      return raced.kind === 'RESULT' ? raced : { ...raced, operation };
    } finally {
      this.timers.clear(timer);
    }
  }

  private observeLateResult(
    active: ActiveExecution,
    operation: Promise<Awaited<ReturnType<VideoProviderAdapter['createTask']>>>,
    ambiguityCommit: Promise<ProviderExecutionResult>,
  ): void {
    void operation
      .then(
        (result) =>
          ambiguityCommit.then(() =>
            isValidCreateResult(result)
              ? this.persistLateResult(active, {
                  providerTaskId: result.providerTaskId,
                  providerState: result.state,
                })
              : this.persistLateResult(active, {
                  diagnosticCode: 'LATE_PROVIDER_PROTOCOL_ERROR',
                }),
          ),
        (error: unknown) =>
          ambiguityCommit.then(() =>
            this.persistLateResult(active, {
              diagnosticCode: `LATE_${classifyProviderFailure(error).code}`,
            }),
          ),
      )
      .catch(() => undefined);
  }

  private persistLateResult(
    active: ActiveExecution,
    detail: Pick<RecordLateResultInput, 'providerTaskId' | 'providerState' | 'diagnosticCode'>,
  ): Promise<boolean> {
    const observedAt = this.dependencies.clock.now();
    return this.dependencies.repository.recordLateResult({
      executionId: active.executionId,
      attemptId: active.attemptId,
      attemptNumber: active.attemptNumber,
      leaseToken: active.leaseToken,
      ...detail,
      observedAt,
      outbox: this.outbox(active, 'provider.execution-late-result.v1', 'AMBIGUOUS', observedAt, {
        ...detail,
        reconciliationRequired: true,
      }),
    });
  }

  private async completeFailure(
    active: ActiveExecution,
    failure: ProviderFailure,
  ): Promise<ProviderExecutionResult> {
    const completedAt = this.dependencies.clock.now();
    const mayRetry =
      failure.retryable && !failure.ambiguous && active.attemptNumber < this.maxAttempts;
    const status = failure.ambiguous
      ? ('AMBIGUOUS' as const)
      : mayRetry
        ? ('RETRY_SCHEDULED' as const)
        : ('FAILED' as const);
    const nextAction = failure.ambiguous
      ? ('RECONCILE' as const)
      : mayRetry
        ? ('CREATE_RETRY' as const)
        : ('NONE' as const);
    const retryDelay = mayRetry
      ? backoffMs({
          attempt: active.attemptNumber,
          ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
          jitterKey: `${active.executionId}:${active.event.data.taskId}`,
        })
      : undefined;
    const nextAttemptAt =
      retryDelay === undefined ? undefined : new Date(completedAt.getTime() + retryDelay);
    const eventType = failure.ambiguous
      ? 'provider.execution-ambiguous.v1'
      : mayRetry
        ? 'provider.execution-retry-scheduled.v1'
        : 'provider.execution-failed.v1';
    const errorCode =
      failure.retryable && !failure.ambiguous && !mayRetry
        ? 'MAX_ATTEMPTS_EXHAUSTED'
        : failure.code;
    await this.dependencies.repository.complete({
      ...completionIdentity(active),
      status,
      errorCode,
      ...(failure.kind === 'HTTP' ? { httpStatus: failure.status } : {}),
      nextAction,
      ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
      completedAt,
      outbox: this.outbox(active, eventType, status, completedAt, {
        errorCode,
        nextAction,
        ...(nextAttemptAt === undefined ? {} : { nextAttemptAt: nextAttemptAt.toISOString() }),
      }),
    });
    return { ack: true, outcome: status };
  }

  private outbox(
    active: ActiveExecution,
    eventType: PendingOutboxEvent['eventType'],
    status: ExecutionCompletionStatus,
    occurredAt: Date,
    detail: Readonly<Record<string, unknown>>,
  ): PendingOutboxEvent {
    return this.outboxFor(
      active.event,
      active.dispatch,
      active.executionId,
      active.attemptNumber,
      eventType,
      status,
      occurredAt,
      detail,
    );
  }
  private outboxFor(
    event: ParsedEvent<QueuedTaskData | RetryData>,
    dispatch: ResolvedDispatch,
    executionId: string,
    attemptNumber: number,
    eventType: PendingOutboxEvent['eventType'],
    status: ExecutionCompletionStatus,
    occurredAt: Date,
    detail: Readonly<Record<string, unknown>>,
  ): PendingOutboxEvent {
    const nextAttemptAt = detail.nextAttemptAt;
    const retryPayload = {
      executionId,
      taskId: event.data.taskId,
      capabilityVersionId: event.data.capabilityVersionId,
      parametersSnapshotSha256: event.data.parametersSnapshotSha256,
      providerId: dispatch.providerId,
      modelCode: dispatch.modelCode,
      priorAttemptNumber: attemptNumber,
      dueAt: nextAttemptAt,
    };
    return {
      id: this.dependencies.ids.next(),
      aggregateId: event.data.taskId,
      eventType,
      eventVersion: 1,
      deduplicationKey: `${event.id}:${eventType}:${String(attemptNumber)}`,
      payload:
        eventType === 'provider.execution-retry-scheduled.v1'
          ? retryPayload
          : {
              executionId,
              taskId: event.data.taskId,
              capabilityVersionId: event.data.capabilityVersionId,
              parametersSnapshotSha256: event.data.parametersSnapshotSha256,
              providerId: dispatch.providerId,
              modelCode: dispatch.modelCode,
              attemptNumber,
              status,
              ...detail,
            },
      headers: {
        traceId: event.traceId,
        correlationId: event.correlationId,
        causationId: event.id,
      },
      occurredAt,
      availableAt:
        eventType === 'provider.execution-retry-scheduled.v1' && typeof nextAttemptAt === 'string'
          ? new Date(nextAttemptAt)
          : occurredAt,
    };
  }
}

export interface ProviderRuntimeDelivery {
  readonly body: unknown;
  ack(): Promise<void>;
  retry(): Promise<void>;
}
export class ProviderRuntimeConsumer {
  constructor(private readonly handler: Pick<ProviderExecutionService, 'handle'>) {}
  async consume(delivery: ProviderRuntimeDelivery): Promise<void> {
    let result: ProviderExecutionResult;
    try {
      result = await this.handler.handle(delivery.body);
    } catch {
      await delivery.retry();
      return;
    }
    if (result.ack) await delivery.ack();
    else await delivery.retry();
  }
}

function completionIdentity(active: ActiveExecution) {
  return {
    consumer: active.consumer,
    messageId: active.event.id,
    payloadSha256: active.payloadSha256,
    executionId: active.executionId,
    attemptId: active.attemptId,
    attemptNumber: active.attemptNumber,
    leaseToken: active.leaseToken,
  };
}
function parseQueuedEvent(rawEvent: unknown): ParsedEvent<QueuedTaskData> {
  const parsed = EventEnvelopeSchema.strict().safeParse(rawEvent);
  if (
    !parsed.success ||
    parsed.data.type !== 'generation.task-queued.v1' ||
    parsed.data.version !== 1 ||
    parsed.data.producer !== 'generation-service'
  )
    throw new ProviderRuntimeError('INVALID_QUEUED_EVENT');
  const data = QueuedTaskDataSchema.safeParse(parsed.data.data);
  if (
    !data.success ||
    parsed.data.correlationId !== data.data.taskId ||
    parsed.data.causationId !== data.data.quoteId
  )
    throw new ProviderRuntimeError('INVALID_QUEUED_EVENT');
  return {
    id: parsed.data.id,
    type: 'generation.task-queued.v1',
    traceId: parsed.data.traceId,
    correlationId: parsed.data.correlationId,
    causationId: parsed.data.causationId,
    data: data.data,
  };
}
function parseRetryEvent(rawEvent: unknown): ParsedEvent<RetryData> {
  const parsed = EventEnvelopeSchema.strict().safeParse(rawEvent);
  if (
    !parsed.success ||
    parsed.data.type !== 'provider.execution-retry-scheduled.v1' ||
    parsed.data.version !== 1 ||
    parsed.data.producer !== 'provider-runtime'
  )
    throw new ProviderRuntimeError('INVALID_RETRY_EVENT');
  const data = RetryDataSchema.safeParse(parsed.data.data);
  if (!data.success || parsed.data.correlationId !== data.data.taskId)
    throw new ProviderRuntimeError('INVALID_RETRY_EVENT');
  return {
    id: parsed.data.id,
    type: 'provider.execution-retry-scheduled.v1',
    traceId: parsed.data.traceId,
    correlationId: parsed.data.correlationId,
    causationId: parsed.data.causationId,
    data: data.data,
  };
}
function validateDispatch(
  event: Pick<QueuedTaskData, 'taskId' | 'capabilityVersionId' | 'parametersSnapshotSha256'>,
  dispatch: ResolvedDispatch,
): void {
  let parametersSha256: string;
  try {
    parametersSha256 = sha256(dispatch.parameters);
  } catch (error) {
    if (error instanceof StrictJsonError)
      throw new ProviderRuntimeError('DISPATCH_SNAPSHOT_MISMATCH');
    throw error;
  }
  if (
    dispatch.taskId !== event.taskId ||
    dispatch.capabilityVersionId !== event.capabilityVersionId ||
    dispatch.parametersSnapshotSha256 !== event.parametersSnapshotSha256 ||
    parametersSha256 !== event.parametersSnapshotSha256 ||
    !UuidSchema.safeParse(dispatch.providerId).success ||
    dispatch.modelCode.length === 0 ||
    dispatch.modelCode.length > 160
  )
    throw new ProviderRuntimeError('DISPATCH_SNAPSHOT_MISMATCH');
}
function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function fencingToken(messageId: string, attemptId: string): string {
  return createHash('sha256').update(`${messageId}:${attemptId}`).digest('hex');
}
function duplicateComplete(): ProviderExecutionResult {
  return { ack: true, outcome: 'DUPLICATE_COMPLETE' };
}
function duplicatePending(): ProviderExecutionResult {
  return { ack: false, outcome: 'DUPLICATE_PENDING' };
}
function isValidCreateResult(value: unknown): value is {
  providerTaskId: string;
  state: 'ACCEPTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
} {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.providerTaskId === 'string' &&
    record.providerTaskId.length > 0 &&
    record.providerTaskId.length <= 512 &&
    ['ACCEPTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED'].includes(record.state as string)
  );
}
function eventTypeForState(
  state: 'ACCEPTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED',
): PendingOutboxEvent['eventType'] {
  return (
    {
      ACCEPTED: 'provider.execution-accepted.v1',
      RUNNING: 'provider.execution-running.v1',
      SUCCEEDED: 'provider.execution-succeeded.v1',
      FAILED: 'provider.execution-failed.v1',
      CANCELED: 'provider.execution-canceled.v1',
    } as const
  )[state];
}
