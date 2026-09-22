/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import { createHash } from 'node:crypto';
import type { VideoProviderAdapter } from '@repo/provider-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  PrismaCircuitRepository,
  ProviderExecutionService,
  type BeginExecutionInput,
  type BeginExecutionResult,
  type ClaimRetryResult,
  type CompleteExecutionInput,
  type ExecutionRepository,
  type ProviderCircuitGate,
} from '../src/index.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

const TASK_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2';
const CAPABILITY_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a5';
const PROVIDER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a7';
const NOW = new Date('2026-08-31T12:00:00.000Z');
const HASH = createHash('sha256').update('{"prompt":"hello"}').digest('hex');

function queuedEvent() {
  return {
    id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a6',
    type: 'generation.task-queued.v1',
    version: 1,
    occurredAt: NOW.toISOString(),
    traceId: '0123456789abcdef0123456789abcdef',
    correlationId: TASK_ID,
    causationId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4',
    producer: 'generation-service',
    data: {
      taskId: TASK_ID,
      userId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a3',
      quoteId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4',
      capabilityVersionId: CAPABILITY_ID,
      status: 'QUEUED',
      taskVersion: 1,
      quotedPoints: '10',
      parametersSnapshotSha256: HASH,
    },
  };
}

class Repo implements ExecutionRepository {
  completion?: CompleteExecutionInput;
  async preflightQueued(): Promise<'CONTINUE'> {
    return 'CONTINUE';
  }
  async begin(input: BeginExecutionInput): Promise<BeginExecutionResult> {
    return {
      kind: 'STARTED',
      executionId: input.executionId,
      attemptId: input.attemptId,
      attemptNumber: 1,
      leaseToken: input.leaseToken,
    };
  }
  async claimRetry(): Promise<ClaimRetryResult> {
    return { kind: 'DUPLICATE_COMPLETE' };
  }
  async complete(input: CompleteExecutionInput): Promise<void> {
    this.completion = input;
  }
  async recordCommitAmbiguity(): Promise<void> {}
  async recordLateResult(): Promise<boolean> {
    return false;
  }
}

function harness(
  createResult: unknown,
  acquire: 'ALLOW' | 'REJECT' = 'ALLOW',
  circuitOverride?: ProviderCircuitGate,
) {
  const repository = new Repo();
  const provider: VideoProviderAdapter = {
    code: 'mock',
    validateConfiguration: vi.fn(),
    getHealth: vi.fn(),
    createTask: vi
      .fn()
      .mockImplementation(() =>
        createResult instanceof Error ||
        (typeof createResult === 'object' && createResult !== null && 'status' in createResult)
          ? Promise.reject(
              createResult instanceof Error
                ? createResult
                : Object.assign(new Error('provider failure'), createResult),
            )
          : Promise.resolve(createResult),
      ),
    queryTask: vi.fn(),
    verifyCallback: vi.fn(),
    normalizeCallback: vi.fn(),
  };
  const defaultCircuit: ProviderCircuitGate = {
    acquire: vi
      .fn()
      .mockResolvedValue(
        acquire === 'ALLOW'
          ? { kind: 'ALLOW', token: 'permit-1' }
          : { kind: 'REJECT', reason: 'OPEN' },
      ),
    record: vi.fn().mockResolvedValue(undefined),
    tripImmediately: vi.fn().mockResolvedValue(undefined),
  };
  const circuit = circuitOverride ?? defaultCircuit;
  let index = 0;
  const ids = [
    '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
    '0198f4d4-21c2-7b7d-8a03-08a0da2a51b1',
    '0198f4d4-21c2-7b7d-8a03-08a0da2a51b2',
    '0198f4d4-21c2-7b7d-8a03-08a0da2a51b3',
    '0198f4d4-21c2-7b7d-8a03-08a0da2a51b4',
  ];
  const service = new ProviderExecutionService({
    repository,
    resolver: {
      resolve: vi.fn().mockResolvedValue({
        taskId: TASK_ID,
        capabilityVersionId: CAPABILITY_ID,
        parametersSnapshotSha256: HASH,
        providerId: PROVIDER_ID,
        modelCode: 'internal-model-v1',
        parameters: { prompt: 'hello' },
        adapter: provider,
      }),
    },
    circuit,
    clock: { now: () => NOW },
    ids: { next: () => ids[index++] ?? '0198f4d4-21c2-7b7d-8a03-08a0da2a51b4' },
  });
  return { circuit, provider, repository, service };
}

describe('execution circuit integration', () => {
  it('does not call the provider when the provider/model circuit is open', async () => {
    const { provider, repository, service } = harness(
      { providerTaskId: 'remote-1', state: 'ACCEPTED' },
      'REJECT',
    );
    await expect(service.handle(queuedEvent())).resolves.toEqual({ ack: true, outcome: 'FAILED' });
    expect(vi.mocked(provider.createTask)).not.toHaveBeenCalled();
    expect(repository.completion).toMatchObject({
      status: 'FAILED',
      errorCode: 'PROVIDER_CIRCUIT_OPEN',
      nextAction: 'NONE',
    });
  });

  it('records success and qualifying failures against the acquired permit', async () => {
    const success = harness({ providerTaskId: 'remote-1', state: 'ACCEPTED' });
    await success.service.handle(queuedEvent());
    expect(vi.mocked(success.circuit.record)).toHaveBeenCalledWith(
      { providerId: PROVIDER_ID, modelCode: 'internal-model-v1' },
      { kind: 'ALLOW', token: 'permit-1' },
      'SUCCESS',
    );

    const failure = harness({ status: 503 });
    await failure.service.handle(queuedEvent());
    expect(vi.mocked(failure.circuit.record)).toHaveBeenCalledWith(
      { providerId: PROVIDER_ID, modelCode: 'internal-model-v1' },
      { kind: 'ALLOW', token: 'permit-1' },
      'QUALIFYING_FAILURE',
    );
  });

  it('immediately trips the circuit on provider authentication failure', async () => {
    const { circuit, service } = harness({ status: 401 });
    await service.handle(queuedEvent());
    expect(vi.mocked(circuit.tripImmediately)).toHaveBeenCalledWith(
      { providerId: PROVIDER_ID, modelCode: 'internal-model-v1' },
      'AUTH_FAILURE',
    );
  });

  it('keeps an accepted create successful while durable circuit accounting waits for the row lock', async () => {
    let releaseLock!: () => void;
    const lock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const circuitState = {
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c0',
      providerId: PROVIDER_ID,
      modelCode: 'internal-model-v1',
      status: 'CLOSED',
      version: 0,
      openUntil: null,
      halfOpenProbeInFlight: false,
      halfOpenProbeToken: null,
      halfOpenProbeExpiresAt: null,
    } as const;
    const transaction = {
      $queryRaw: vi.fn().mockImplementation(() => lock),
      circuitState: {
        upsert: vi.fn().mockResolvedValue(circuitState),
        findUnique: vi.fn().mockResolvedValue(circuitState),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn(),
      },
      circuitObservation: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    } as unknown as PrismaClient;
    let circuitId = 0;
    const circuit = new CircuitBreaker({
      repository: new PrismaCircuitRepository(prisma, {
        next: () => `0198f4d4-21c2-7b7d-8a03-${String(++circuitId).padStart(12, '0')}`,
      }),
      clock: { now: () => NOW },
      ids: { next: () => `permit-${String(++circuitId)}` },
    });
    const { provider, repository, service } = harness(
      { providerTaskId: 'remote-1', state: 'ACCEPTED' },
      'ALLOW',
      circuit,
    );
    const handling = service.handle(queuedEvent());
    await vi.waitFor(() => {
      expect(provider.createTask).toHaveBeenCalledOnce();
      expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    });
    expect(repository.completion).toBeUndefined();
    releaseLock();
    await expect(handling).resolves.toEqual({ ack: true, outcome: 'ACCEPTED' });
    expect(repository.completion).toMatchObject({ status: 'ACCEPTED' });
    expect(transaction.circuitState.update).toHaveBeenCalledOnce();
  });
});
