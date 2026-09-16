/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import { createHash } from 'node:crypto';
import type { VideoProviderAdapter } from '@repo/provider-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  ProviderExecutionService,
  ProviderRuntimeConsumer,
  type BeginExecutionResult,
  type ClaimRetryInput,
  type ClaimRetryResult,
  type CompleteExecutionInput,
  type ExecutionRepository,
} from '../src/index.js';
import { backoffMs } from '../src/domain/retry-policy.js';

const TASK_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2';
const CAPABILITY_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a5';
const PROVIDER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a7';
const EXECUTION_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0';
const PARAMETERS = { prompt: 'hello' };
const PARAMETERS_HASH = createHash('sha256').update('{"prompt":"hello"}').digest('hex');
const DUE = new Date('2026-08-31T12:00:10.000Z');

function retryEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c0',
    type: 'provider.execution-retry-scheduled.v1',
    version: 1,
    occurredAt: '2026-08-31T12:00:00.000Z',
    traceId: '0123456789abcdef0123456789abcdef',
    correlationId: TASK_ID,
    causationId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a6',
    producer: 'provider-runtime',
    data: {
      executionId: EXECUTION_ID,
      taskId: TASK_ID,
      capabilityVersionId: CAPABILITY_ID,
      parametersSnapshotSha256: PARAMETERS_HASH,
      providerId: PROVIDER_ID,
      modelCode: 'internal-model-v1',
      priorAttemptNumber: 1,
      dueAt: DUE.toISOString(),
    },
    ...overrides,
  };
}

function adapter(): VideoProviderAdapter {
  return {
    code: 'resolved-mock',
    validateConfiguration: vi.fn().mockResolvedValue({ valid: true, issues: [] }),
    getHealth: vi.fn().mockResolvedValue({ status: 'UP', latencyMs: 1 }),
    createTask: vi.fn().mockResolvedValue({ providerTaskId: 'remote-2', state: 'ACCEPTED' }),
    queryTask: vi.fn(),
    verifyCallback: vi.fn(),
    normalizeCallback: vi.fn(),
  };
}

class RetryRepository implements ExecutionRepository {
  readonly claims: ClaimRetryInput[] = [];
  readonly completions: CompleteExecutionInput[] = [];
  claimFailure?: Error;
  claimResult: ClaimRetryResult = {
    kind: 'CLAIMED',
    executionId: EXECUTION_ID,
    attemptId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c1',
    attemptNumber: 2,
    leaseToken: 'a'.repeat(64),
  };

  async preflightQueued(): Promise<'CONTINUE'> {
    return 'CONTINUE';
  }

  async begin(): Promise<BeginExecutionResult> {
    return { kind: 'DUPLICATE_COMPLETE' };
  }

  async claimRetry(input: ClaimRetryInput): Promise<ClaimRetryResult> {
    this.claims.push(input);
    if (this.claimFailure) throw this.claimFailure;
    return this.claimResult;
  }

  async complete(input: CompleteExecutionInput): Promise<void> {
    this.completions.push(input);
  }

  async recordCommitAmbiguity(): Promise<void> {}

  async recordLateResult(): Promise<boolean> {
    return false;
  }
}

function harness(repository = new RetryRepository(), now = DUE, maxAttempts = 5) {
  const provider = adapter();
  let index = 0;
  const ids = [
    '0198f4d4-21c2-7b7d-8a03-08a0da2a51c1',
    '0198f4d4-21c2-7b7d-8a03-08a0da2a51c2',
    '0198f4d4-21c2-7b7d-8a03-08a0da2a51c3',
  ];
  const service = new ProviderExecutionService({
    repository,
    circuit: {
      acquire: vi.fn().mockResolvedValue({ kind: 'ALLOW', token: 'permit-1' }),
      record: vi.fn().mockResolvedValue(undefined),
      tripImmediately: vi.fn().mockResolvedValue(undefined),
    },
    resolver: {
      resolve: vi.fn().mockResolvedValue({
        taskId: TASK_ID,
        capabilityVersionId: CAPABILITY_ID,
        parametersSnapshotSha256: PARAMETERS_HASH,
        providerId: PROVIDER_ID,
        modelCode: 'internal-model-v1',
        parameters: PARAMETERS,
        adapter: provider,
      }),
    },
    clock: { now: () => now },
    ids: { next: () => ids[index++] ?? '0198f4d4-21c2-7b7d-8a03-08a0da2a51c3' },
    maxAttempts,
    leaseDurationMs: 60_000,
  });
  return { provider, repository, service };
}

describe('retry execution consumer', () => {
  it('claims attempt 2 transactionally and reuses taskId as provider idempotency key', async () => {
    const { provider, repository, service } = harness();
    await expect(service.handle(retryEvent())).resolves.toEqual({ ack: true, outcome: 'ACCEPTED' });
    expect(repository.claims[0]).toMatchObject({ priorAttemptNumber: 1, maxAttempts: 5 });
    expect(provider.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK_ID, idempotencyKey: TASK_ID }),
    );
    expect(repository.completions[0]).toMatchObject({ attemptNumber: 2, status: 'ACCEPTED' });
  });

  it('does not ACK or call the adapter for an early delivery', async () => {
    const repository = new RetryRepository();
    repository.claimResult = { kind: 'NOT_DUE' };
    const { provider, service } = harness(repository, new Date(DUE.getTime() - 1));
    await expect(service.handle(retryEvent())).resolves.toEqual({ ack: false, outcome: 'NOT_DUE' });
    expect(provider.createTask).not.toHaveBeenCalled();
  });

  it('ACKs a concurrent duplicate retry claim without a second adapter call', async () => {
    const repository = new RetryRepository();
    repository.claimResult = { kind: 'DUPLICATE_COMPLETE' };
    const { provider, service } = harness(repository);
    await expect(service.handle(retryEvent())).resolves.toEqual({
      ack: true,
      outcome: 'DUPLICATE_COMPLETE',
    });
    expect(provider.createTask).not.toHaveBeenCalled();
  });

  it('ACKs an expired retry-claim takeover as ambiguous without another adapter call', async () => {
    const repository = new RetryRepository();
    repository.claimResult = { kind: 'RECOVERED_AMBIGUOUS' };
    const { provider, service } = harness(repository);
    await expect(service.handle(retryEvent())).resolves.toEqual({
      ack: true,
      outcome: 'AMBIGUOUS',
    });
    expect(provider.createTask).not.toHaveBeenCalled();
  });

  it('does not ACK or call the adapter if the retry claim cannot persist', async () => {
    const repository = new RetryRepository();
    repository.claimFailure = new Error('database down');
    const { provider, service } = harness(repository);
    await expect(service.handle(retryEvent())).rejects.toThrow('database down');
    expect(provider.createTask).not.toHaveBeenCalled();
  });

  it('durably fails at max attempts without invoking the adapter', async () => {
    const repository = new RetryRepository();
    repository.claimResult = { kind: 'MAX_ATTEMPTS' };
    const { provider, service } = harness(repository, DUE, 2);
    await expect(service.handle(retryEvent())).resolves.toEqual({ ack: true, outcome: 'FAILED' });
    expect(provider.createTask).not.toHaveBeenCalled();
  });

  it('fails the claimed final attempt without scheduling attempt N+1', async () => {
    const repository = new RetryRepository();
    const { provider, service } = harness(repository, DUE, 2);
    vi.mocked(provider.createTask).mockRejectedValue({ status: 503 });
    await expect(service.handle(retryEvent())).resolves.toEqual({ ack: true, outcome: 'FAILED' });
    expect(repository.completions[0]).toMatchObject({
      attemptNumber: 2,
      status: 'FAILED',
      errorCode: 'MAX_ATTEMPTS_EXHAUSTED',
      nextAction: 'NONE',
      outbox: { eventType: 'provider.execution-failed.v1' },
    });
  });

  it('uses retry-after again and exposes the next event exactly at nextAttemptAt', async () => {
    const { provider, repository, service } = harness();
    vi.mocked(provider.createTask).mockRejectedValue({ status: 429, retryAfterSeconds: 17 });
    await service.handle(retryEvent());
    const completion = repository.completions[0];
    expect(completion).toBeDefined();
    if (completion === undefined) throw new Error('completion missing');
    expect(completion.nextAttemptAt).toEqual(new Date(DUE.getTime() + 17_000));
    expect(completion.outbox.availableAt).toEqual(completion.nextAttemptAt);
    const followUp = retryEvent({
      id: completion.outbox.id,
      causationId: (retryEvent() as { id: string }).id,
      data: completion.outbox.payload,
    });
    const nextRepository = new RetryRepository();
    const next = harness(nextRepository, new Date(DUE.getTime() + 17_000));
    await expect(next.service.handle(followUp)).resolves.toMatchObject({ ack: true });
    expect(nextRepository.claims[0]).toMatchObject({ priorAttemptNumber: 2 });
  });

  it('retries repeated 5xx with the next deterministic attempt number', async () => {
    const { provider, repository, service } = harness();
    vi.mocked(provider.createTask).mockRejectedValue({ status: 503 });
    await service.handle(retryEvent());
    expect(repository.completions[0]).toMatchObject({
      attemptNumber: 2,
      status: 'RETRY_SCHEDULED',
      nextAttemptAt: new Date(
        DUE.getTime() + backoffMs({ attempt: 2, jitterKey: `${EXECUTION_ID}:${TASK_ID}` }),
      ),
    });
  });

  it('strictly rejects malformed retry data and resolver route drift before claim', async () => {
    const first = harness();
    await expect(
      first.service.handle(
        retryEvent({
          data: {
            ...(retryEvent() as { data: Record<string, unknown> }).data,
            unexpected: true,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RETRY_EVENT' });
    expect(first.repository.claims).toHaveLength(0);

    const second = harness();
    const drifted = retryEvent({
      data: {
        ...(retryEvent() as { data: Record<string, unknown> }).data,
        providerId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51ff',
      },
    });
    await expect(second.service.handle(drifted)).rejects.toMatchObject({
      code: 'DISPATCH_ROUTE_MISMATCH',
    });
    expect(second.repository.claims).toHaveLength(0);
    expect(second.provider.createTask).not.toHaveBeenCalled();
  });
});

describe('transport-neutral delivery wiring', () => {
  it('ACKs only after the durable handler resolves and retries rejected work', async () => {
    let release!: () => void;
    const handler = vi.fn(
      () =>
        new Promise<{ ack: boolean; outcome: 'ACCEPTED' }>((resolve) => {
          release = () => {
            resolve({ ack: true, outcome: 'ACCEPTED' });
          };
        }),
    );
    const ack = vi.fn().mockResolvedValue(undefined);
    const retry = vi.fn().mockResolvedValue(undefined);
    const consumer = new ProviderRuntimeConsumer({ handle: handler });
    const consuming = consumer.consume({ body: retryEvent(), ack, retry });
    await Promise.resolve();
    expect(ack).not.toHaveBeenCalled();
    release();
    await consuming;
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();

    handler.mockRejectedValueOnce(new Error('transient'));
    await consumer.consume({ body: retryEvent(), ack, retry });
    expect(retry).toHaveBeenCalledOnce();
  });
});
