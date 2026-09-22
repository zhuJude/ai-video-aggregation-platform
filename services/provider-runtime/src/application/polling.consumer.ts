import { createHash } from 'node:crypto';
import { EventEnvelopeSchema, UuidSchema } from '@repo/contracts/common';
import { z } from 'zod';
import { canonicalJson, StrictJsonError } from '../domain/canonical-json.js';
import {
  isTerminalProviderStatus,
  type ObservableProviderStatus,
} from '../domain/provider-state.js';
import { classifyProviderFailure } from '../domain/retry-policy.js';
import type { CircuitKey, CircuitPermit } from '../domain/circuit-breaker.js';
import type { ProviderCircuitGate } from './execution.service.js';
import type { ProviderRuntimeObserver } from './observability.js';
import {
  callProviderWithDeadline,
  defaultProviderCallTimers,
  type ProviderCallTimers,
} from './provider-call-deadline.js';

export const PollConsumerName = 'provider-runtime:execution-poll-due:v1' as const;

const PollDataSchema = z.strictObject({
  executionId: UuidSchema,
  taskId: UuidSchema,
  providerId: UuidSchema,
  modelCode: z.string().min(1).max(160),
  providerTaskId: z.string().min(1).max(512),
  attemptNumber: z.int().positive(),
  pollNumber: z.int().positive(),
  routeEpoch: z.int().nonnegative().default(0),
  dueAt: z.iso.datetime({ offset: true }),
});
const ProviderQueryResultSchema = z.strictObject({
  state: z.enum(['ACCEPTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED']),
  resultUrls: z.array(z.url()).max(32).optional(),
  errorCode: z.string().min(1).max(120).optional(),
  errorMessage: z.string().max(2_000).optional(),
});

export interface PollOutboxEvent {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType:
    | 'provider.execution-poll-due.v1'
    | 'provider.execution-accepted.v1'
    | 'provider.execution-running.v1'
    | 'provider.execution-succeeded.v1'
    | 'provider.execution-failed.v1'
    | 'provider.execution-canceled.v1'
    | 'provider.execution-ambiguous.v1'
    | 'provider.health.auth-failed.v1'
    | 'provider.health.zero-balance.v1';
  readonly eventVersion: 1;
  readonly deduplicationKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly availableAt: Date;
}

export interface ClaimPollInput {
  readonly consumer: typeof PollConsumerName;
  readonly messageId: string;
  readonly eventType: 'provider.execution-poll-due.v1';
  readonly payloadSha256: string;
  readonly executionId: string;
  readonly taskId: string;
  readonly providerId: string;
  readonly modelCode: string;
  readonly providerTaskId: string;
  readonly attemptNumber: number;
  readonly pollNumber: number;
  readonly routeEpoch: number;
  readonly dueAt: Date;
  readonly receivedAt: Date;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
}

export type ClaimPollResult =
  | {
      readonly kind: 'CLAIMED';
      readonly executionId: string;
      readonly taskId: string;
      readonly attemptNumber: number;
      readonly pollNumber: number;
      readonly providerTaskId: string;
      readonly leaseToken: string;
    }
  | { readonly kind: 'NOT_DUE' }
  | { readonly kind: 'TERMINAL' }
  | { readonly kind: 'MANUAL_RECONCILE' }
  | { readonly kind: 'DUPLICATE_COMPLETE' }
  | { readonly kind: 'DUPLICATE_PENDING' };

export interface CompletePollInput {
  readonly consumer: typeof PollConsumerName;
  readonly messageId: string;
  readonly payloadSha256: string;
  readonly executionId: string;
  readonly taskId: string;
  readonly providerId: string;
  readonly modelCode: string;
  readonly providerTaskId: string;
  readonly attemptNumber: number;
  readonly pollNumber: number;
  readonly routeEpoch: number;
  readonly leaseToken: string;
  readonly state: ObservableProviderStatus | 'AMBIGUOUS';
  readonly resultUrls?: readonly string[];
  readonly errorCode?: string;
  readonly completedAt: Date;
  readonly stateOutbox: PollOutboxEvent;
  readonly nextPollAt?: Date;
  readonly nextPollOutbox?: PollOutboxEvent;
}

export interface DeferPollInput {
  readonly consumer: typeof PollConsumerName;
  readonly messageId: string;
  readonly payloadSha256: string;
  readonly executionId: string;
  readonly taskId: string;
  readonly providerId: string;
  readonly modelCode: string;
  readonly providerTaskId: string;
  readonly attemptNumber: number;
  readonly pollNumber: number;
  readonly routeEpoch: number;
  readonly leaseToken: string;
  readonly errorCode: string;
  readonly deferredAt: Date;
  readonly nextPollAt: Date;
  readonly nextPollOutbox: PollOutboxEvent;
}

export interface PollRepository {
  claim(input: ClaimPollInput): Promise<ClaimPollResult>;
  complete(input: CompletePollInput): Promise<void>;
  defer(input: DeferPollInput): Promise<void>;
}

export interface PollAdapter {
  queryTask(input: { readonly providerTaskId: string }): Promise<{
    readonly state: ObservableProviderStatus;
    readonly resultUrls?: string[];
    readonly errorCode?: string;
  }>;
}

export interface PollAdapterRegistry {
  resolve(input: {
    readonly providerId: string;
    readonly modelCode: string;
  }): Promise<PollAdapter | null>;
}

interface PollDependencies {
  readonly repository: PollRepository;
  readonly adapters: PollAdapterRegistry;
  readonly clock: { now(): Date };
  readonly ids: { next(): string };
  readonly circuit: ProviderCircuitGate;
  readonly intervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly queryTimeoutMs?: number;
  readonly timers?: ProviderCallTimers;
  readonly observer?: ProviderRuntimeObserver;
}

export interface PollResult {
  readonly ack: boolean;
  readonly outcome:
    | ObservableProviderStatus
    | 'AMBIGUOUS'
    | 'NOT_DUE'
    | 'TERMINAL'
    | 'MANUAL_RECONCILE'
    | 'DUPLICATE_COMPLETE'
    | 'DUPLICATE_PENDING'
    | 'DEFERRED';
}

export class ProviderPollingService {
  private readonly intervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly queryTimeoutMs: number;
  private readonly timers: ProviderCallTimers;

  constructor(private readonly dependencies: PollDependencies) {
    this.intervalMs = dependencies.intervalMs ?? 30_000;
    this.leaseDurationMs = dependencies.leaseDurationMs ?? 60_000;
    this.queryTimeoutMs = dependencies.queryTimeoutMs ?? 30_000;
    this.timers = dependencies.timers ?? defaultProviderCallTimers();
    if (
      !Number.isInteger(this.intervalMs) ||
      !Number.isInteger(this.leaseDurationMs) ||
      !Number.isInteger(this.queryTimeoutMs) ||
      this.intervalMs < 1 ||
      this.leaseDurationMs < 1 ||
      this.queryTimeoutMs < 1
    )
      throw new Error('INVALID_POLL_CONFIGURATION');
  }

  async handle(rawEvent: unknown): Promise<PollResult> {
    const envelope = EventEnvelopeSchema.strict().safeParse(rawEvent);
    if (
      !envelope.success ||
      envelope.data.type !== 'provider.execution-poll-due.v1' ||
      envelope.data.version !== 1 ||
      envelope.data.producer !== 'provider-runtime'
    )
      throw new Error('INVALID_POLL_EVENT');
    const data = PollDataSchema.safeParse(envelope.data.data);
    if (!data.success || envelope.data.correlationId !== data.data.taskId)
      throw new Error('INVALID_POLL_EVENT');
    const payloadSha256 = sha256(rawEvent);
    const now = this.dependencies.clock.now();
    const ownerId = this.dependencies.ids.next();
    const leaseToken = createHash('sha256')
      .update(`${envelope.data.id}:${String(data.data.pollNumber)}:${ownerId}`)
      .digest('hex');
    const claim = await this.dependencies.repository.claim({
      consumer: PollConsumerName,
      messageId: envelope.data.id,
      eventType: 'provider.execution-poll-due.v1',
      payloadSha256,
      ...data.data,
      dueAt: new Date(data.data.dueAt),
      receivedAt: now,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs),
    });
    if (claim.kind === 'NOT_DUE') return { ack: false, outcome: claim.kind };
    if (claim.kind === 'DUPLICATE_PENDING') return { ack: false, outcome: claim.kind };
    if (claim.kind !== 'CLAIMED') return { ack: true, outcome: claim.kind };
    const adapter = await this.dependencies.adapters.resolve({
      providerId: data.data.providerId,
      modelCode: data.data.modelCode,
    });
    if (adapter === null) throw new Error('POLL_ADAPTER_NOT_FOUND');
    const circuitKey: CircuitKey = {
      providerId: data.data.providerId,
      modelCode: data.data.modelCode,
    };
    const permit = await this.dependencies.circuit.acquire(circuitKey);
    if (permit.kind === 'REJECT') {
      await this.defer(envelope.data, data.data, claim, payloadSha256, 'PROVIDER_CIRCUIT_OPEN');
      return { ack: true, outcome: 'DEFERRED' };
    }
    let rawProviderResult: unknown;
    const callStartedAt = this.dependencies.clock.now();
    try {
      const raced = await callProviderWithDeadline({
        operation: () => adapter.queryTask({ providerTaskId: claim.providerTaskId }),
        timeoutMs: this.queryTimeoutMs,
        timers: this.timers,
      });
      if (raced.kind === 'TIMED_OUT') {
        this.observeQuery(callStartedAt, 'FAILURE', 'TIMEOUT');
        await this.recordFailure(circuitKey, permit, 'PROVIDER_TIMEOUT');
        await this.defer(envelope.data, data.data, claim, payloadSha256, 'PROVIDER_TIMEOUT');
        return { ack: true, outcome: 'DEFERRED' };
      }
      rawProviderResult = raced.result;
    } catch (error) {
      const failure = classifyProviderFailure(error);
      this.observeQuery(callStartedAt, 'FAILURE', providerMetricError(failure.code));
      await this.recordFailure(circuitKey, permit, failure.code);
      await this.defer(envelope.data, data.data, claim, payloadSha256, failure.code);
      return { ack: true, outcome: 'DEFERRED' };
    }
    const parsedProviderResult = ProviderQueryResultSchema.safeParse(rawProviderResult);
    if (!parsedProviderResult.success) {
      this.observeQuery(callStartedAt, 'FAILURE', 'PROTOCOL');
      await this.dependencies.circuit.record(circuitKey, permit, 'QUALIFYING_FAILURE');
      throw new Error('INVALID_PROVIDER_POLL_RESULT');
    }
    this.observeQuery(callStartedAt, 'SUCCESS');
    await this.dependencies.circuit.record(circuitKey, permit, 'SUCCESS');
    const providerResult = parsedProviderResult.data;
    const completedAt = this.dependencies.clock.now();
    const missingSuccessResult =
      providerResult.state === 'SUCCEEDED' &&
      (providerResult.resultUrls === undefined || providerResult.resultUrls.length === 0);
    const durableState = missingSuccessResult ? ('AMBIGUOUS' as const) : providerResult.state;
    const terminal = missingSuccessResult || isTerminalProviderStatus(providerResult.state);
    const nextPollAt = terminal ? undefined : new Date(completedAt.getTime() + this.intervalMs);
    const headers = {
      traceId: envelope.data.traceId,
      correlationId: envelope.data.correlationId,
      causationId: envelope.data.id,
      producer: 'provider-runtime',
    };
    const basePayload = {
      executionId: claim.executionId,
      taskId: claim.taskId,
      providerId: data.data.providerId,
      modelCode: data.data.modelCode,
      providerTaskId: claim.providerTaskId,
      attemptNumber: claim.attemptNumber,
      pollNumber: claim.pollNumber,
      routeEpoch: data.data.routeEpoch,
    };
    await this.dependencies.repository.complete({
      consumer: PollConsumerName,
      messageId: envelope.data.id,
      payloadSha256,
      ...basePayload,
      leaseToken: claim.leaseToken,
      state: durableState,
      ...(providerResult.resultUrls === undefined ? {} : { resultUrls: providerResult.resultUrls }),
      ...(missingSuccessResult
        ? { errorCode: 'PROVIDER_SUCCESS_RESULT_MISSING' }
        : providerResult.errorCode === undefined
          ? {}
          : { errorCode: providerResult.errorCode }),
      completedAt,
      stateOutbox: {
        id: this.dependencies.ids.next(),
        aggregateId: claim.taskId,
        eventType: eventTypeForState(durableState),
        eventVersion: 1,
        deduplicationKey: `${envelope.data.id}:state:${providerResult.state}`,
        payload: {
          ...basePayload,
          status: durableState,
          ...(missingSuccessResult
            ? { errorCode: 'PROVIDER_SUCCESS_RESULT_MISSING', repairRequired: true }
            : {}),
          ...(providerResult.resultUrls === undefined
            ? {}
            : { resultUrls: providerResult.resultUrls }),
          ...(providerResult.errorCode === undefined
            ? {}
            : { errorCode: providerResult.errorCode }),
        },
        headers,
        occurredAt: completedAt,
        availableAt: completedAt,
      },
      ...(nextPollAt === undefined
        ? {}
        : {
            nextPollAt,
            nextPollOutbox: {
              id: this.dependencies.ids.next(),
              aggregateId: claim.taskId,
              eventType: 'provider.execution-poll-due.v1',
              eventVersion: 1,
              deduplicationKey: `${claim.executionId}:poll:${String(claim.attemptNumber)}:${String(claim.pollNumber + 1)}`,
              payload: {
                ...basePayload,
                pollNumber: claim.pollNumber + 1,
                dueAt: nextPollAt.toISOString(),
              },
              headers,
              occurredAt: completedAt,
              availableAt: nextPollAt,
            },
          }),
    });
    return { ack: true, outcome: durableState };
  }

  private observeQuery(
    startedAt: Date,
    outcome: 'SUCCESS' | 'FAILURE',
    errorClass?: 'RATE_LIMITED' | 'UNAVAILABLE' | 'TIMEOUT' | 'AUTH' | 'BALANCE' | 'PROTOCOL',
  ): void {
    const elapsed = Math.max(
      0,
      (this.dependencies.clock.now().getTime() - startedAt.getTime()) / 1_000,
    );
    this.dependencies.observer?.observeProviderCall('QUERY', outcome, elapsed);
    if (errorClass !== undefined) {
      this.dependencies.observer?.recordProviderError('QUERY', errorClass);
    }
  }

  private async recordFailure(key: CircuitKey, permit: CircuitPermit, code: string): Promise<void> {
    if (code === 'PROVIDER_AUTH_FAILED') {
      await this.dependencies.circuit.tripImmediately(key, 'AUTH_FAILURE');
      return;
    }
    const qualifying =
      code === 'PROVIDER_RATE_LIMITED' ||
      code === 'PROVIDER_UNAVAILABLE' ||
      code === 'PROVIDER_TIMEOUT' ||
      code === 'PROVIDER_NETWORK_ERROR';
    await this.dependencies.circuit.record(
      key,
      permit,
      qualifying ? 'QUALIFYING_FAILURE' : 'SUCCESS',
    );
  }

  private async defer(
    envelope: z.infer<typeof EventEnvelopeSchema>,
    data: z.infer<typeof PollDataSchema>,
    claim: Extract<ClaimPollResult, { kind: 'CLAIMED' }>,
    payloadSha256: string,
    errorCode: string,
  ): Promise<void> {
    const deferredAt = this.dependencies.clock.now();
    const nextPollAt = new Date(deferredAt.getTime() + this.intervalMs);
    const basePayload = {
      executionId: claim.executionId,
      taskId: claim.taskId,
      providerId: data.providerId,
      modelCode: data.modelCode,
      providerTaskId: claim.providerTaskId,
      attemptNumber: claim.attemptNumber,
      routeEpoch: data.routeEpoch,
      pollNumber: claim.pollNumber + 1,
      dueAt: nextPollAt.toISOString(),
    };
    await this.dependencies.repository.defer({
      consumer: PollConsumerName,
      messageId: envelope.id,
      payloadSha256,
      executionId: claim.executionId,
      taskId: claim.taskId,
      providerId: data.providerId,
      modelCode: data.modelCode,
      providerTaskId: claim.providerTaskId,
      attemptNumber: claim.attemptNumber,
      pollNumber: claim.pollNumber,
      routeEpoch: data.routeEpoch,
      leaseToken: claim.leaseToken,
      errorCode,
      deferredAt,
      nextPollAt,
      nextPollOutbox: {
        id: this.dependencies.ids.next(),
        aggregateId: claim.taskId,
        eventType: 'provider.execution-poll-due.v1',
        eventVersion: 1,
        deduplicationKey: `${claim.executionId}:poll:${String(claim.attemptNumber)}:${String(claim.pollNumber + 1)}`,
        payload: basePayload,
        headers: {
          traceId: envelope.traceId,
          correlationId: envelope.correlationId,
          causationId: envelope.id,
          producer: 'provider-runtime',
        },
        occurredAt: deferredAt,
        availableAt: nextPollAt,
      },
    });
  }
}

function providerMetricError(
  code: string,
): 'RATE_LIMITED' | 'UNAVAILABLE' | 'TIMEOUT' | 'AUTH' | 'BALANCE' | 'PROTOCOL' {
  if (code === 'PROVIDER_RATE_LIMITED') return 'RATE_LIMITED';
  if (code === 'PROVIDER_TIMEOUT') return 'TIMEOUT';
  if (code === 'PROVIDER_AUTH_FAILED') return 'AUTH';
  if (code === 'PROVIDER_BALANCE_EXHAUSTED') return 'BALANCE';
  if (code === 'INVALID_PROVIDER_POLL_RESULT') return 'PROTOCOL';
  return 'UNAVAILABLE';
}

export class PollingConsumer {
  constructor(private readonly handler: { handle(body: unknown): Promise<PollResult> }) {}

  async consume(input: {
    readonly body: unknown;
    readonly ack: () => Promise<void>;
    readonly retry: () => Promise<void>;
  }): Promise<void> {
    try {
      const result = await this.handler.handle(input.body);
      if (result.ack) await input.ack();
      else await input.retry();
    } catch {
      await input.retry();
    }
  }
}

function eventTypeForState(
  state: ObservableProviderStatus | 'AMBIGUOUS',
): PollOutboxEvent['eventType'] {
  return {
    ACCEPTED: 'provider.execution-accepted.v1',
    RUNNING: 'provider.execution-running.v1',
    SUCCEEDED: 'provider.execution-succeeded.v1',
    FAILED: 'provider.execution-failed.v1',
    CANCELED: 'provider.execution-canceled.v1',
    AMBIGUOUS: 'provider.execution-ambiguous.v1',
  }[state] as PollOutboxEvent['eventType'];
}

function sha256(value: unknown): string {
  try {
    return createHash('sha256').update(canonicalJson(value)).digest('hex');
  } catch (error) {
    if (error instanceof StrictJsonError) throw new Error('INVALID_POLL_EVENT', { cause: error });
    throw error;
  }
}
