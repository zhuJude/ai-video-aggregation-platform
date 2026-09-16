/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method, @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-unsafe-assignment */
import { createHash } from 'node:crypto';
import type { VideoProviderAdapter } from '@repo/provider-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  ProviderExecutionService,
  ProviderRuntimeError,
  type BeginExecutionInput,
  type BeginExecutionResult,
  type ClaimRetryResult,
  type CommitAmbiguityInput,
  type CompleteExecutionInput,
  type DispatchResolver,
  type ExecutionRepository,
  type RecordLateResultInput,
  type ResolvedDispatch,
} from '../src/application/execution.service.js';
import { backoffMs } from '../src/domain/retry-policy.js';

const TASK_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2';
const USER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a3';
const QUOTE_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4';
const CAPABILITY_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a5';
const EVENT_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a6';
const PROVIDER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a7';
const PARAMETERS = { prompt: 'hello' };
const PARAMETERS_HASH = createHash('sha256').update('{"prompt":"hello"}').digest('hex');
const NOW = new Date('2026-08-31T12:00:00.000Z');

function queuedEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: EVENT_ID,
    type: 'generation.task-queued.v1',
    version: 1,
    occurredAt: '2026-08-31T11:59:59.000Z',
    traceId: '0123456789abcdef0123456789abcdef',
    correlationId: TASK_ID,
    causationId: QUOTE_ID,
    producer: 'generation-service',
    data: {
      taskId: TASK_ID,
      userId: USER_ID,
      quoteId: QUOTE_ID,
      capabilityVersionId: CAPABILITY_ID,
      status: 'QUEUED',
      taskVersion: 2,
      quotedPoints: '42',
      parametersSnapshotSha256: PARAMETERS_HASH,
    },
    ...overrides,
  };
}

function createAdapter(): VideoProviderAdapter {
  return {
    code: 'resolved-mock',
    validateConfiguration: vi.fn().mockResolvedValue({ valid: true, issues: [] }),
    getHealth: vi.fn().mockResolvedValue({ status: 'UP', latencyMs: 1 }),
    createTask: vi.fn().mockResolvedValue({ providerTaskId: 'remote-1', state: 'ACCEPTED' }),
    queryTask: vi.fn(),
    verifyCallback: vi.fn(),
    normalizeCallback: vi.fn(),
  };
}

function resolvedDispatch(adapter: VideoProviderAdapter): ResolvedDispatch {
  return {
    taskId: TASK_ID,
    capabilityVersionId: CAPABILITY_ID,
    parametersSnapshotSha256: PARAMETERS_HASH,
    providerId: PROVIDER_ID,
    modelCode: 'internal-model-v1',
    parameters: PARAMETERS,
    adapter,
  };
}

class FakeRepository implements ExecutionRepository {
  readonly calls: string[] = [];
  readonly begins: BeginExecutionInput[] = [];
  readonly completions: CompleteExecutionInput[] = [];
  readonly ambiguities: CommitAmbiguityInput[] = [];
  readonly lateResults: RecordLateResultInput[] = [];
  readonly messages = new Map<string, { hash: string; state: 'PENDING' | 'COMPLETE' }>();
  beginFailure: Error | undefined;
  completeFailure: Error | undefined;
  ambiguityFailure: Error | undefined;
  completeGate: Promise<void> | undefined;
  recoverPending = false;
  nextBeginResult: BeginExecutionResult | undefined;
  preflightResult: 'CONTINUE' | 'REJECTED_BINDING' = 'CONTINUE';

  async preflightQueued(): Promise<'CONTINUE' | 'REJECTED_BINDING'> {
    return this.preflightResult;
  }

  async begin(input: BeginExecutionInput): Promise<BeginExecutionResult> {
    this.calls.push('begin');
    this.begins.push(input);
    if (this.beginFailure !== undefined) throw this.beginFailure;
    if (this.nextBeginResult !== undefined) return this.nextBeginResult;
    const existing = this.messages.get(input.messageId);
    if (existing !== undefined) {
      if (existing.hash !== input.payloadSha256) {
        throw new ProviderRuntimeError('MESSAGE_PAYLOAD_CONFLICT');
      }
      if (existing.state === 'COMPLETE') return { kind: 'DUPLICATE_COMPLETE' };
      if (this.recoverPending) {
        existing.state = 'COMPLETE';
        return { kind: 'RECOVERED_AMBIGUOUS' };
      }
      return { kind: 'DUPLICATE_PENDING' };
    }
    this.messages.set(input.messageId, { hash: input.payloadSha256, state: 'PENDING' });
    return {
      kind: 'STARTED',
      executionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
      attemptId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b1',
      attemptNumber: 1,
      leaseToken: input.leaseToken,
    };
  }

  async claimRetry(): Promise<ClaimRetryResult> {
    return { kind: 'DUPLICATE_COMPLETE' };
  }

  async complete(input: CompleteExecutionInput): Promise<void> {
    this.calls.push('complete:start');
    this.completions.push(input);
    if (this.completeGate !== undefined) await this.completeGate;
    if (this.completeFailure !== undefined) throw this.completeFailure;
    this.messages.set(input.messageId, { hash: input.payloadSha256, state: 'COMPLETE' });
    this.calls.push('complete:committed');
  }

  recordCommitAmbiguity(input: CommitAmbiguityInput): Promise<void> {
    this.calls.push('ambiguity');
    this.ambiguities.push(input);
    if (this.ambiguityFailure !== undefined) return Promise.reject(this.ambiguityFailure);
    this.messages.set(input.messageId, { hash: input.payloadSha256, state: 'COMPLETE' });
    return Promise.resolve();
  }

  recordLateResult(input: RecordLateResultInput): Promise<boolean> {
    this.lateResults.push(input);
    return Promise.resolve(true);
  }
}

function harness(
  options: {
    adapter?: VideoProviderAdapter;
    repository?: FakeRepository;
    dispatch?: Partial<ResolvedDispatch> | null;
    createTimeoutMs?: number;
  } = {},
) {
  const adapter = options.adapter ?? createAdapter();
  const repository = options.repository ?? new FakeRepository();
  const resolved =
    options.dispatch === null ? null : { ...resolvedDispatch(adapter), ...options.dispatch };
  const resolver: DispatchResolver = {
    resolve: vi.fn().mockResolvedValue(resolved),
  };
  let idIndex = 0;
  const ids = [
    '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
    '0198f4d4-21c2-7b7d-8a03-08a0da2a51b1',
    '0198f4d4-21c2-7b7d-8a03-08a0da2a51b2',
    '0198f4d4-21c2-7b7d-8a03-08a0da2a51b3',
  ];
  const service = new ProviderExecutionService({
    repository,
    resolver,
    circuit: {
      acquire: vi.fn().mockResolvedValue({ kind: 'ALLOW', token: 'permit-1' }),
      record: vi.fn().mockResolvedValue(undefined),
      tripImmediately: vi.fn().mockResolvedValue(undefined),
    },
    clock: { now: () => NOW },
    ids: { next: () => ids[idIndex++] ?? '0198f4d4-21c2-7b7d-8a03-08a0da2a51bf' },
    ...(options.createTimeoutMs === undefined ? {} : { createTimeoutMs: options.createTimeoutMs }),
  });
  return { adapter, repository, resolver, service };
}

describe('ProviderExecutionService', () => {
  it('persists execution and attempt before invoking the adapter and ACKs after outbox commit', async () => {
    const { adapter, repository, service } = harness();
    vi.mocked(adapter.createTask).mockImplementation(async (input) => {
      repository.calls.push('adapter');
      expect(repository.begins).toHaveLength(1);
      expect(input.idempotencyKey).toBe(TASK_ID);
      expect(input.taskId).toBe(TASK_ID);
      return { providerTaskId: 'remote-1', state: 'ACCEPTED' };
    });

    const result = await service.handle(queuedEvent());

    expect(result).toEqual({ ack: true, outcome: 'ACCEPTED' });
    expect(repository.calls).toEqual(['begin', 'adapter', 'complete:start', 'complete:committed']);
    expect(repository.completions[0]).toMatchObject({
      status: 'ACCEPTED',
      providerTaskId: 'remote-1',
      outbox: { eventType: 'provider.execution-accepted.v1' },
    });
  });

  it.each([
    ['RUNNING', 'provider.execution-running.v1'],
    ['SUCCEEDED', 'provider.execution-succeeded.v1'],
    ['FAILED', 'provider.execution-failed.v1'],
    ['CANCELED', 'provider.execution-canceled.v1'],
  ] as const)(
    'emits the matching durable follow-up when create returns %s',
    async (state, eventType) => {
      const adapter = createAdapter();
      vi.mocked(adapter.createTask).mockResolvedValue({ providerTaskId: 'remote-1', state });
      const { repository, service } = harness({ adapter });
      await service.handle(queuedEvent());
      expect(repository.completions[0]).toMatchObject({ status: state, outbox: { eventType } });
    },
  );

  it('does not ACK until the durable completion and follow-up outbox transaction commits', async () => {
    let release!: () => void;
    const repository = new FakeRepository();
    repository.completeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service } = harness({ repository });
    let settled = false;
    const processing = service.handle(queuedEvent()).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(repository.calls).toContain('complete:start'));
    expect(settled).toBe(false);
    release();
    await expect(processing).resolves.toMatchObject({ ack: true });
  });

  it('ACKs a completed duplicate without a second adapter call', async () => {
    const { adapter, service } = harness();
    await service.handle(queuedEvent());
    await expect(service.handle(queuedEvent())).resolves.toEqual({
      ack: true,
      outcome: 'DUPLICATE_COMPLETE',
    });
    expect(adapter.createTask).toHaveBeenCalledTimes(1);
  });

  it('does not ACK an in-flight concurrent duplicate and invokes the adapter once', async () => {
    let release!: () => void;
    const adapter = createAdapter();
    vi.mocked(adapter.createTask).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ providerTaskId: 'remote-1', state: 'ACCEPTED' });
        }),
    );
    const { service } = harness({ adapter });
    const owner = service.handle(queuedEvent());
    await vi.waitFor(() => expect(adapter.createTask).toHaveBeenCalledTimes(1));
    await expect(service.handle(queuedEvent())).resolves.toEqual({
      ack: false,
      outcome: 'DUPLICATE_PENDING',
    });
    release();
    await expect(owner).resolves.toMatchObject({ ack: true });
    expect(adapter.createTask).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of a message ID with a different payload', async () => {
    const { adapter, service } = harness();
    await service.handle(queuedEvent());
    const changed = queuedEvent({
      data: { ...(queuedEvent() as { data: Record<string, unknown> }).data, quotedPoints: '43' },
    });
    await expect(service.handle(changed)).rejects.toMatchObject({
      code: 'MESSAGE_PAYLOAD_CONFLICT',
    });
    expect(adapter.createTask).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['taskId', '0198f4d4-21c2-7b7d-8a03-08a0da2a51ff'],
    ['capabilityVersionId', '0198f4d4-21c2-7b7d-8a03-08a0da2a51fe'],
    ['parametersSnapshotSha256', 'b'.repeat(64)],
    ['parameters', { prompt: 'different' }],
  ] as const)(
    'rejects resolver mismatch for %s before persistence or adapter I/O',
    async (key, value) => {
      const { adapter, repository, service } = harness({ dispatch: { [key]: value } });
      await expect(service.handle(queuedEvent())).rejects.toMatchObject({
        code: 'DISPATCH_SNAPSHOT_MISMATCH',
      });
      expect(repository.begins).toHaveLength(0);
      expect(adapter.createTask).not.toHaveBeenCalled();
    },
  );

  it('ACKs a durable immutable-binding security disposition without adapter I/O', async () => {
    const repository = new FakeRepository();
    repository.nextBeginResult = { kind: 'REJECTED_BINDING' };
    const { adapter, service } = harness({ repository });
    await expect(service.handle(queuedEvent())).resolves.toEqual({
      ack: true,
      outcome: 'REJECTED_BINDING',
    });
    expect(adapter.createTask).not.toHaveBeenCalled();
  });

  it('rejects an unresolved dispatch without invoking an adapter', async () => {
    const { repository, service } = harness({ dispatch: null });
    await expect(service.handle(queuedEvent())).rejects.toMatchObject({
      code: 'DISPATCH_NOT_FOUND',
    });
    expect(repository.begins).toHaveLength(0);
  });

  it('durably rejects an existing-task event binding mismatch before resolver lookup', async () => {
    const repository = new FakeRepository();
    repository.preflightResult = 'REJECTED_BINDING';
    const { adapter, service } = harness({ repository, dispatch: null });
    await expect(service.handle(queuedEvent())).resolves.toEqual({
      ack: true,
      outcome: 'REJECTED_BINDING',
    });
    expect(adapter.createTask).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong.type.v1', 'INVALID_QUEUED_EVENT'],
    ['generation.task-queued.v1', 'INVALID_QUEUED_EVENT'],
  ] as const)('strictly rejects an invalid envelope/payload', async (type, code) => {
    const { adapter, service } = harness();
    const event =
      type === 'wrong.type.v1'
        ? queuedEvent({ type })
        : queuedEvent({ data: { taskId: TASK_ID }, unexpected: true });
    await expect(service.handle(event)).rejects.toMatchObject({ code });
    expect(adapter.createTask).not.toHaveBeenCalled();
  });

  it('does not invoke the adapter or ACK when pre-call persistence fails', async () => {
    const repository = new FakeRepository();
    repository.beginFailure = new Error('database unavailable');
    const { adapter, service } = harness({ repository });
    await expect(service.handle(queuedEvent())).rejects.toThrow('database unavailable');
    expect(adapter.createTask).not.toHaveBeenCalled();
  });

  it('schedules 429 using retry-after and a deterministic create retry', async () => {
    const adapter = createAdapter();
    vi.mocked(adapter.createTask).mockRejectedValue({ status: 429, retryAfterSeconds: 17 });
    const { repository, service } = harness({ adapter });
    await expect(service.handle(queuedEvent())).resolves.toEqual({
      ack: true,
      outcome: 'RETRY_SCHEDULED',
    });
    expect(repository.completions[0]).toMatchObject({
      status: 'RETRY_SCHEDULED',
      errorCode: 'PROVIDER_RATE_LIMITED',
      nextAction: 'CREATE_RETRY',
      nextAttemptAt: new Date(NOW.getTime() + 17_000),
      outbox: { eventType: 'provider.execution-retry-scheduled.v1' },
    });
    expect(repository.completions[0]?.outbox.availableAt).toEqual(
      repository.completions[0]?.nextAttemptAt,
    );
  });

  it.each([500, 503])('schedules HTTP %i with capped deterministic backoff', async (status) => {
    const adapter = createAdapter();
    vi.mocked(adapter.createTask).mockRejectedValue({ status });
    const { repository, service } = harness({ adapter });
    await service.handle(queuedEvent());
    expect(repository.completions[0]).toMatchObject({
      status: 'RETRY_SCHEDULED',
      errorCode: 'PROVIDER_UNAVAILABLE',
      nextAction: 'CREATE_RETRY',
      nextAttemptAt: new Date(
        NOW.getTime() +
          backoffMs({
            attempt: 1,
            jitterKey: `0198f4d4-21c2-7b7d-8a03-08a0da2a51b0:${TASK_ID}`,
          }),
      ),
    });
  });

  it.each([
    [401, 'PROVIDER_AUTH_FAILED'],
    [403, 'PROVIDER_AUTH_FAILED'],
    [400, 'PROVIDER_REJECTED'],
    [422, 'PROVIDER_REJECTED'],
  ] as const)('fails HTTP %i without retry', async (status, errorCode) => {
    const adapter = createAdapter();
    vi.mocked(adapter.createTask).mockRejectedValue({ status });
    const { repository, service } = harness({ adapter });
    await expect(service.handle(queuedEvent())).resolves.toEqual({
      ack: true,
      outcome: 'FAILED',
    });
    expect(repository.completions[0]).toMatchObject({
      status: 'FAILED',
      errorCode,
      nextAction: 'NONE',
      outbox: { eventType: 'provider.execution-failed.v1' },
    });
  });

  it.each([
    [{ name: 'AbortError' }, 'PROVIDER_TIMEOUT'],
    [{ code: 'ECONNRESET' }, 'PROVIDER_NETWORK_ERROR'],
  ] as const)(
    'records %s as ambiguous reconciliation intent without blind create retry',
    async (error, code) => {
      const adapter = createAdapter();
      vi.mocked(adapter.createTask).mockRejectedValue(error);
      const { repository, service } = harness({ adapter });
      await expect(service.handle(queuedEvent())).resolves.toEqual({
        ack: true,
        outcome: 'AMBIGUOUS',
      });
      expect(repository.completions[0]).toMatchObject({
        status: 'AMBIGUOUS',
        errorCode: code,
        nextAction: 'RECONCILE',
        outbox: { eventType: 'provider.execution-ambiguous.v1' },
      });
      expect(repository.completions[0]?.nextAttemptAt).toBeUndefined();
    },
  );

  it('records a repair signal when the adapter accepted but final commit failed', async () => {
    const repository = new FakeRepository();
    repository.completeFailure = new Error('commit failed');
    const { service } = harness({ repository });
    await expect(service.handle(queuedEvent())).resolves.toEqual({
      ack: true,
      outcome: 'AMBIGUOUS',
    });
    expect(repository.ambiguities[0]).toMatchObject({
      providerTaskId: 'remote-1',
      errorCode: 'POST_ACCEPTANCE_PERSISTENCE_FAILED',
      outbox: { eventType: 'provider.execution-ambiguous.v1' },
    });
  });

  it('times out a never-settling adapter into a durable ambiguous outcome and clears its timer', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const adapter = createAdapter();
      vi.mocked(adapter.createTask).mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => {
              resolve({ providerTaskId: 'too-late', state: 'ACCEPTED' });
            };
          }),
      );
      const { repository, service } = harness({ adapter, createTimeoutMs: 50 });
      let settled = false;
      let outcome: unknown;
      const processing = service.handle(queuedEvent()).then((result) => {
        settled = true;
        outcome = result;
      });
      await vi.advanceTimersByTimeAsync(50);
      const timedOut = settled;
      release();
      await processing;
      await vi.waitFor(() => {
        expect(repository.lateResults).toHaveLength(1);
      });
      expect(timedOut).toBe(true);
      expect(outcome).toEqual({ ack: true, outcome: 'AMBIGUOUS' });
      expect(repository.completions[0]).toMatchObject({
        status: 'AMBIGUOUS',
        errorCode: 'PROVIDER_TIMEOUT',
        nextAction: 'RECONCILE',
      });
      expect(repository.lateResults[0]).toMatchObject({
        providerTaskId: 'too-late',
        providerState: 'ACCEPTED',
        outbox: {
          eventType: 'provider.execution-late-result.v1',
          payload: expect.objectContaining({
            providerTaskId: 'too-late',
            providerState: 'ACCEPTED',
            reconciliationRequired: true,
          }),
        },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('observes a provider rejection that arrives after the create deadline without an unhandled rejection', async () => {
    vi.useFakeTimers();
    try {
      let rejectLate!: (error: unknown) => void;
      const adapter = createAdapter();
      vi.mocked(adapter.createTask).mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectLate = reject;
          }),
      );
      const { repository, service } = harness({ adapter, createTimeoutMs: 50 });
      const processing = service.handle(queuedEvent());

      await vi.advanceTimersByTimeAsync(50);
      await expect(processing).resolves.toEqual({ ack: true, outcome: 'AMBIGUOUS' });
      rejectLate({ code: 'ECONNRESET' });
      await vi.waitFor(() => {
        expect(repository.lateResults).toHaveLength(1);
      });

      expect(repository.lateResults[0]).toMatchObject({
        diagnosticCode: 'LATE_PROVIDER_NETWORK_ERROR',
        outbox: {
          eventType: 'provider.execution-late-result.v1',
          payload: expect.objectContaining({
            diagnosticCode: 'LATE_PROVIDER_NETWORK_ERROR',
            reconciliationRequired: true,
          }),
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not ACK if neither the accepted outcome nor ambiguity signal can commit', async () => {
    const repository = new FakeRepository();
    repository.completeFailure = new Error('commit failed');
    repository.ambiguityFailure = new Error('repair commit failed');
    const { service } = harness({ repository });
    await expect(service.handle(queuedEvent())).rejects.toThrow('repair commit failed');
  });

  it('recovers an expired pending delivery as ambiguous without another adapter create', async () => {
    const repository = new FakeRepository();
    repository.completeFailure = new Error('commit failed');
    repository.ambiguityFailure = new Error('repair commit failed');
    const { adapter, service } = harness({ repository });
    await expect(service.handle(queuedEvent())).rejects.toThrow('repair commit failed');
    repository.recoverPending = true;
    await expect(service.handle(queuedEvent())).resolves.toEqual({
      ack: true,
      outcome: 'AMBIGUOUS',
    });
    expect(adapter.createTask).toHaveBeenCalledTimes(1);
  });
});
