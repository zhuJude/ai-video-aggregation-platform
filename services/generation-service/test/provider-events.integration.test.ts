/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from 'vitest';
import {
  ProviderEventsConsumer,
  ProviderEventsDeliveryConsumer,
  providerEventStateRank,
  taskTransitionPath,
  type AssetImportPort,
  type CancellationPort,
  type ProviderEventRepository,
  type SagaTask,
  type SagaWrite,
  type WalletEffectsPort,
} from '../src/application/provider-events.consumer.js';
import { GenerationMetrics } from '../src/runtime/operations.js';
import type { GenerationDomainObserver } from '../src/application/observability.js';

const TASK_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0';
const USER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2';
const PROVIDER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a5';
const EXECUTION_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b6';
const ASSET_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b7';
const CAPABILITY_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4';
const NOW = new Date('2026-09-01T08:00:00.000Z');

function task(overrides: Partial<SagaTask> = {}): SagaTask {
  return {
    taskId: TASK_ID,
    userId: USER_ID,
    quoteId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a3',
    status: 'RUNNING',
    version: 4,
    sagaVersion: 0,
    quotedPoints: '1200',
    settlementPoints: '1200',
    capabilityVersionId: CAPABILITY_ID,
    parametersSnapshotSha256: 'f'.repeat(64),
    providerAccepted: true,
    providerStateRank: 2,
    providerId: PROVIDER_ID,
    providerTaskId: 'provider-task-1',
    modelCode: 'mock-video-v1',
    executionId: EXECUTION_ID,
    routeEpoch: 0,
    assetImportRequested: false,
    assetImportDispatched: false,
    assetId: null,
    routingFailoverAuthorized: false,
    cancellationChargePoints: null,
    cancelRequested: false,
    financialDisposition: null,
    financialSettlementKey: null,
    financialReleaseKey: null,
    substitute: null,
    updatedAt: NOW,
    ...overrides,
  };
}

class MemoryRepository implements ProviderEventRepository {
  current: SagaTask;
  readonly messages = new Map<string, 'PENDING' | 'COMPLETE'>();
  readonly writes: SagaWrite[] = [];
  readonly cases: string[] = [];

  constructor(initial = task()) {
    this.current = initial;
  }

  async claim(input: Parameters<ProviderEventRepository['claim']>[0]) {
    const prior = this.messages.get(input.messageId);
    if (prior === 'COMPLETE') return { kind: 'DUPLICATE_COMPLETE' as const };
    if (prior === 'PENDING') return { kind: 'CLAIMED' as const, task: this.current };
    this.messages.set(input.messageId, 'PENDING');
    return { kind: 'CLAIMED' as const, task: this.current };
  }

  async renewLease() {
    return { kind: 'RENEWED' as const };
  }

  async write(input: SagaWrite) {
    if (input.expectedVersion !== this.current.version) return { kind: 'STALE' as const };
    this.writes.push(input);
    const nextVersion = input.transitions.at(-1)?.taskVersion ?? this.current.version;
    this.current = {
      ...this.current,
      ...input.patch,
      version: nextVersion,
      sagaVersion: this.current.sagaVersion + 1,
      updatedAt: input.committedAt,
    };
    if (input.operatorCase !== undefined) this.cases.push(input.operatorCase.kind);
    if (input.completeMessage) this.messages.set(input.messageId, 'COMPLETE');
    return { kind: 'APPLIED' as const, task: this.current };
  }

  async getTask() {
    return this.current;
  }

  async findStale() {
    return [];
  }
}

function providerEvent(
  type:
    | 'provider.execution-accepted.v1'
    | 'provider.execution-running.v1'
    | 'provider.execution-succeeded.v1'
    | 'provider.execution-failed.v1'
    | 'provider.execution-canceled.v1'
    | 'provider.execution-ambiguous.v1',
  id = '0198f4d4-21c2-7b7d-8a03-08a0da2a51c0',
) {
  const status = type.slice('provider.execution-'.length, -'.v1'.length).toUpperCase();
  return {
    id,
    type,
    version: 1,
    occurredAt: NOW.toISOString(),
    traceId: 'a'.repeat(32),
    correlationId: TASK_ID,
    producer: 'provider-runtime',
    data: {
      executionId: EXECUTION_ID,
      taskId: TASK_ID,
      providerId: PROVIDER_ID,
      modelCode: 'mock-video-v1',
      providerTaskId: 'provider-task-1',
      attemptNumber: 1,
      status,
      ...(type === 'provider.execution-succeeded.v1'
        ? { resultUrls: ['https://result.invalid/video.mp4'] }
        : {}),
      ...(type === 'provider.execution-failed.v1' ? { errorCode: 'PROVIDER_REJECTED' } : {}),
      ...(type === 'provider.execution-ambiguous.v1'
        ? { errorCode: 'PROVIDER_TIMEOUT', repairRequired: true }
        : {}),
    },
  };
}

function assetImportedEvent(id = '0198f4d4-21c2-7b7d-8a03-08a0da2a51c1') {
  return {
    id,
    type: 'asset.imported.v1',
    version: 1,
    occurredAt: new Date(NOW.getTime() + 1_000).toISOString(),
    traceId: 'b'.repeat(32),
    correlationId: TASK_ID,
    producer: 'asset-service',
    data: { taskId: TASK_ID, assetId: ASSET_ID, importBusinessKey: `task:${TASK_ID}:asset-import` },
  };
}

function harness(initial = task(), observer?: GenerationDomainObserver) {
  const repository = new MemoryRepository(initial);
  const asset: AssetImportPort = { requestImport: vi.fn(async () => undefined) };
  const wallet: WalletEffectsPort = {
    settle: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
  const cancellation: CancellationPort = {
    cancel: vi.fn(async () => ({ outcome: 'CONFIRMED' as const })),
  };
  const consumer = new ProviderEventsConsumer({
    repository,
    asset,
    wallet,
    cancellation,
    clock: { now: () => NOW },
    ids: {
      next: (() => {
        let sequence = 0xc8;
        return () => `0198f4d4-21c2-7b7d-8a03-08a0da2a51${(sequence++).toString(16)}`;
      })(),
    },
    ...(observer === undefined ? {} : { observer }),
  });
  return { repository, asset, wallet, cancellation, consumer };
}

describe('ProviderEventsConsumer', () => {
  it('emits transition and queue metrics from the durable consumer path', async () => {
    const metrics = new GenerationMetrics();
    const { consumer } = harness(
      task({
        status: 'QUEUED',
        version: 2,
        providerAccepted: false,
        providerStateRank: 0,
        providerId: null,
        providerTaskId: null,
        modelCode: null,
      }),
      metrics,
    );

    await consumer.consume(providerEvent('provider.execution-accepted.v1'));

    const output = metrics.render();
    expect(output).toContain('generation_tasks_total{status="SUBMITTING"} 1');
    expect(output).toContain('generation_tasks_total{status="RUNNING"} 1');
    expect(output).toContain('generation_queue_age_seconds_count 1');
  });
  it('durably records import intent before dispatch so an immediate asset event cannot be lost', async () => {
    const { consumer, asset, repository, wallet } = harness();
    vi.mocked(asset.requestImport).mockImplementationOnce(async () => {
      await consumer.consume(assetImportedEvent('0198f4d4-21c2-7b7d-8a03-08a0da2a51ef'));
    });

    await expect(
      consumer.consume(providerEvent('provider.execution-succeeded.v1')),
    ).resolves.toMatchObject({ ack: true, outcome: 'SETTLED' });

    expect(repository.cases).not.toContain('UNEXPECTED_ASSET_IMPORTED_EVENT');
    expect(wallet.settle).toHaveBeenCalledTimes(1);
    expect(repository.current.status).toBe('SETTLED');
  });

  it('uses the persisted user-cancel disposition when the provider cancellation callback wins the race', async () => {
    const initial = {
      ...task({ cancellationChargePoints: '600' }),
      cancelRequested: true,
      financialDisposition: 'USER_CANCEL_RULE',
      financialSettlementKey: `task:${TASK_ID}:settle`,
      financialReleaseKey: `task:${TASK_ID}:quote-difference-release`,
      routeEpoch: 0,
      executionId: EXECUTION_ID,
      assetImportDispatched: false,
    } as SagaTask;
    const { consumer, wallet, repository } = harness(initial);
    const event = providerEvent('provider.execution-canceled.v1');
    Object.assign(event.data, { routeEpoch: 0 });

    await expect(consumer.consume(event)).resolves.toMatchObject({ outcome: 'SETTLED' });
    expect(wallet.settle).toHaveBeenCalledWith(
      expect.objectContaining({ points: '600', businessKey: `task:${TASK_ID}:settle` }),
    );
    expect(wallet.release).toHaveBeenCalledWith(
      expect.objectContaining({
        points: '600',
        businessKey: `task:${TASK_ID}:quote-difference-release`,
      }),
    );
    expect(repository.current.status).toBe('SETTLED');
  });

  it('ACKs a late prior-route failure without refunding the current failover epoch', async () => {
    const initial = {
      ...task({ providerId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a6', modelCode: 'mock-video-v2' }),
      routeEpoch: 1,
      executionId: null,
      assetImportDispatched: false,
      cancelRequested: false,
      financialDisposition: null,
      financialSettlementKey: null,
      financialReleaseKey: null,
    } as SagaTask;
    const { consumer, wallet, repository } = harness(initial);
    const event = providerEvent('provider.execution-failed.v1');
    Object.assign(event.data, { routeEpoch: 0 });

    await expect(consumer.consume(event)).resolves.toMatchObject({
      ack: true,
      outcome: 'OPERATOR_REQUIRED',
    });
    expect(repository.cases).toContain('STALE_PROVIDER_EXECUTION_EVENT');
    expect(wallet.release).not.toHaveBeenCalled();
    expect(repository.current.status).toBe('RUNNING');
  });

  it('does not let a live duplicate Inbox delivery execute external effects', async () => {
    const { consumer, repository, asset } = harness();
    vi.spyOn(repository as ProviderEventRepository, 'claim').mockResolvedValueOnce({
      kind: 'DUPLICATE_PENDING',
      task: repository.current,
    });

    await expect(
      consumer.consume(providerEvent('provider.execution-succeeded.v1')),
    ).resolves.toEqual({ ack: false, outcome: 'DUPLICATE_PENDING' });
    expect(asset.requestImport).not.toHaveBeenCalled();
  });

  it('does not let a live duplicate cancellation delivery execute external effects', async () => {
    const { consumer, repository, cancellation, wallet } = harness(
      task({ cancellationChargePoints: '600' }),
    );
    vi.spyOn(repository as ProviderEventRepository, 'claim').mockResolvedValueOnce({
      kind: 'DUPLICATE_PENDING',
      task: repository.current,
    });

    await expect(
      consumer.cancel({
        messageId: TASK_ID,
        taskId: TASK_ID,
        traceId: '1'.repeat(32),
        userId: USER_ID,
        currentStatus: 'RUNNING',
        currentVersion: 4,
      }),
    ).resolves.toEqual({ ack: false, outcome: 'DUPLICATE_PENDING' });
    expect(cancellation.cancel).not.toHaveBeenCalled();
    expect(wallet.settle).not.toHaveBeenCalled();
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it('idempotently completes stale or wrong-owner cancel commands without remote cancellation', async () => {
    const { consumer, cancellation, wallet, repository } = harness(
      task({ cancellationChargePoints: '600' }),
    );
    const stale = {
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51f0',
      type: 'generation.task-cancel-requested.v1',
      version: 1,
      occurredAt: NOW.toISOString(),
      traceId: 'f'.repeat(32),
      correlationId: TASK_ID,
      producer: 'generation-service',
      data: {
        taskId: TASK_ID,
        userId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51ff',
        currentStatus: 'QUEUED',
        currentVersion: 2,
      },
    };

    await expect(consumer.consume(stale)).resolves.toMatchObject({
      ack: true,
      outcome: 'STALE_CANCEL_COMMAND',
    });
    expect(cancellation.cancel).not.toHaveBeenCalled();
    expect(wallet.release).not.toHaveBeenCalled();
    expect(repository.current.status).toBe('RUNNING');
  });

  it('persists ambiguous provider identity for later reconciliation', async () => {
    const metrics = new GenerationMetrics();
    const { consumer, repository } = harness(
      task({
        status: 'QUEUED',
        version: 2,
        providerId: null,
        providerTaskId: null,
        modelCode: null,
        providerAccepted: false,
        providerStateRank: 0,
      }),
      metrics,
    );
    const event = providerEvent('provider.execution-ambiguous.v1');
    Object.assign(event.data, { routeEpoch: 0 });

    await expect(consumer.consume(event)).resolves.toMatchObject({
      outcome: 'OPERATOR_REQUIRED',
    });
    expect(repository.current).toMatchObject({
      status: 'SUBMITTING',
      version: 3,
      providerAccepted: false,
      financialDisposition: null,
      providerId: PROVIDER_ID,
      providerTaskId: 'provider-task-1',
      modelCode: 'mock-video-v1',
      executionId: EXECUTION_ID,
    });
    expect(repository.writes.at(-1)?.transitions).toEqual([
      expect.objectContaining({
        fromStatus: 'QUEUED',
        toStatus: 'SUBMITTING',
        reasonCode: 'PROVIDER_SUBMISSION_AMBIGUOUS',
      }),
    ]);
    expect(repository.writes.at(-1)?.operatorCase?.evidence).toMatchObject({
      executionId: EXECUTION_ID,
      providerId: PROVIDER_ID,
      providerTaskId: 'provider-task-1',
      routeEpoch: 0,
    });

    const secondAmbiguous = providerEvent(
      'provider.execution-ambiguous.v1',
      '0198f4d4-21c2-7b7d-8a03-08a0da2a51cf',
    );
    Object.assign(secondAmbiguous.data, { sequence: 2 });
    await consumer.consume(secondAmbiguous);
    expect(metrics.render()).toContain(
      'generation_repair_cases{reason="AMBIGUOUS_PROVIDER_RESULT"} 2',
    );
  });

  it('does not roll an already-running task back when a later ambiguous observation arrives', async () => {
    const { consumer, repository, wallet } = harness();

    await expect(
      consumer.consume(providerEvent('provider.execution-ambiguous.v1')),
    ).resolves.toMatchObject({ outcome: 'OPERATOR_REQUIRED' });

    expect(repository.current.status).toBe('RUNNING');
    expect(repository.current.providerAccepted).toBe(true);
    expect(repository.writes.at(-1)?.transitions).toEqual([]);
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it('rejects unsupported versions and unknown envelope or provider-data fields before effects', async () => {
    const { consumer, repository, wallet, asset } = harness();
    const version = providerEvent('provider.execution-failed.v1');
    version.version = 2;
    const envelopeField = { ...providerEvent('provider.execution-failed.v1'), unexpected: true };
    const dataField = providerEvent('provider.execution-failed.v1');
    Object.assign(dataField.data, { unexpected: true });

    await expect(consumer.consume(version)).rejects.toThrow('INVALID_GENERATION_EVENT');
    await expect(consumer.consume(envelopeField)).rejects.toThrow('INVALID_GENERATION_EVENT');
    await expect(consumer.consume(dataField)).rejects.toThrow('INVALID_PROVIDER_EVENT');

    expect(repository.writes).toHaveLength(0);
    expect(wallet.release).not.toHaveBeenCalled();
    expect(wallet.settle).not.toHaveBeenCalled();
    expect(asset.requestImport).not.toHaveBeenCalled();
  });

  it('uses the trusted local clock for durable progress timestamps', async () => {
    const { consumer, repository } = harness();
    const event = providerEvent('provider.execution-running.v1');
    event.occurredAt = '2000-01-01T00:00:00.000Z';

    await consumer.consume(event);
    expect(repository.current.updatedAt).toEqual(NOW);
    expect(repository.writes.at(-1)?.occurredAt).toEqual(new Date(event.occurredAt));
    expect((repository.writes.at(-1) as SagaWrite & { committedAt?: Date }).committedAt).toEqual(
      NOW,
    );
  });

  it('routes a provider success without results to repair instead of rejecting it forever', async () => {
    const { consumer, repository, asset, wallet } = harness();
    const event = providerEvent('provider.execution-succeeded.v1');
    delete (event.data as { resultUrls?: string[] }).resultUrls;

    await expect(consumer.consume(event)).resolves.toMatchObject({
      ack: true,
      outcome: 'OPERATOR_REQUIRED',
    });
    expect(repository.cases).toContain('PROVIDER_SUCCESS_RESULT_MISSING');
    expect(asset.requestImport).not.toHaveBeenCalled();
    expect(wallet.settle).not.toHaveBeenCalled();
  });

  it('routes an empty provider success result list to repair instead of parse retry', async () => {
    const { consumer, repository, asset } = harness();
    const event = providerEvent('provider.execution-succeeded.v1');
    event.data.resultUrls = [];

    await expect(consumer.consume(event)).resolves.toMatchObject({
      ack: true,
      outcome: 'OPERATOR_REQUIRED',
    });
    expect(repository.cases).toContain('PROVIDER_SUCCESS_RESULT_MISSING');
    expect(asset.requestImport).not.toHaveBeenCalled();
  });

  it.each([
    ['ACCEPTED', 1],
    ['RUNNING', 2],
    ['SUCCEEDED', 3],
    ['FAILED', 3],
    ['CANCELED', 3],
    ['AMBIGUOUS', 0],
  ])('assigns provider state %s the deterministic ordering rank %i', (status, rank) => {
    expect(providerEventStateRank(status)).toBe(rank);
  });

  it.each([
    ['RUNNING', 'RUNNING', []],
    ['QUEUED', 'RUNNING', ['SUBMITTING', 'RUNNING']],
    ['SUBMITTING', 'RUNNING', ['RUNNING']],
    ['QUEUED', 'SUCCEEDED', ['SUBMITTING', 'RUNNING', 'SUCCEEDED']],
    ['SUBMITTING', 'SUCCEEDED', ['RUNNING', 'SUCCEEDED']],
    ['RUNNING', 'SUCCEEDED', ['SUCCEEDED']],
    ['QUEUED', 'FAILED', ['SUBMITTING', 'FAILED']],
    ['SUBMITTING', 'FAILED', ['FAILED']],
    ['RUNNING', 'FAILED', ['FAILED']],
    ['QUEUED', 'CANCELED', ['CANCELED']],
    ['RUNNING', 'CANCELED', ['CANCELED']],
    ['SUBMITTING', 'CANCELED', ['RUNNING', 'CANCELED']],
    ['SUCCEEDED', 'SETTLED', ['SETTLED']],
    ['CANCELED', 'SETTLED', ['SETTLED']],
    ['RESERVED', 'REFUNDED', ['REFUNDED']],
    ['FAILED', 'REFUNDED', ['REFUNDED']],
    ['CANCELED', 'REFUNDED', ['REFUNDED']],
    ['EXPIRED', 'REFUNDED', ['REFUNDED']],
  ] as const)('builds the legal %s to %s transition path', (from, to, expected) => {
    expect(taskTransitionPath(from, to)).toEqual(expected);
  });

  it('rejects a transition path outside the state machine', () => {
    expect(() => taskTransitionPath('SETTLED', 'RUNNING')).toThrow('ILLEGAL_TASK_TRANSITION');
  });

  it('rejects an invalid Inbox lease configuration', () => {
    const { repository, asset, wallet, cancellation } = harness();

    expect(
      () =>
        new ProviderEventsConsumer({
          repository,
          asset,
          wallet,
          cancellation,
          clock: { now: () => NOW },
          ids: { next: () => TASK_ID },
          leaseDurationMs: 0,
        }),
    ).toThrow('INVALID_INBOX_LEASE_DURATION');
  });

  it('advances an accepted provider task through submitting to running with provider identity', async () => {
    const { consumer, repository } = harness(
      task({
        status: 'QUEUED',
        version: 2,
        providerAccepted: false,
        providerStateRank: 0,
        providerId: null,
        providerTaskId: null,
        modelCode: null,
      }),
    );

    await expect(
      consumer.consume(providerEvent('provider.execution-accepted.v1')),
    ).resolves.toEqual({
      ack: true,
      outcome: 'PROGRESSED',
    });

    expect(repository.current).toMatchObject({
      status: 'RUNNING',
      version: 4,
      providerAccepted: true,
      providerTaskId: 'provider-task-1',
      providerStateRank: 1,
    });
  });

  it('requests durable asset import on success and waits for asset.imported.v1 before settlement', async () => {
    const { consumer, asset, wallet, repository } = harness();

    await expect(
      consumer.consume(providerEvent('provider.execution-succeeded.v1')),
    ).resolves.toEqual({
      ack: true,
      outcome: 'ASSET_IMPORT_PENDING',
    });

    expect(asset.requestImport).toHaveBeenCalledWith({
      taskId: TASK_ID,
      userId: USER_ID,
      resultUrls: ['https://result.invalid/video.mp4'],
      businessKey: `task:${TASK_ID}:asset-import`,
      traceId: 'a'.repeat(32),
    });
    expect(wallet.settle).not.toHaveBeenCalled();
    expect(repository.current.status).toBe('SUCCEEDED');
    expect(repository.current.assetImportRequested).toBe(true);
  });

  it('fails closed if the durable task disappears after asset import dispatch', async () => {
    const { consumer, asset, repository } = harness();
    vi.spyOn(repository as ProviderEventRepository, 'getTask').mockResolvedValueOnce(null);

    await expect(
      consumer.consume(providerEvent('provider.execution-succeeded.v1')),
    ).rejects.toThrow('TASK_SAGA_NOT_FOUND');
    expect(asset.requestImport).toHaveBeenCalledOnce();
  });

  it('rejects a callback that omits the model binding of the current route epoch', async () => {
    const { consumer, repository } = harness();
    const event = providerEvent('provider.execution-succeeded.v1');
    delete (event.data as { modelCode?: string }).modelCode;
    Object.assign(event.data, { providerEventId: 'callback-1', sequence: 3 });

    await expect(consumer.consume(event)).resolves.toMatchObject({
      ack: true,
      outcome: 'OPERATOR_REQUIRED',
    });
    expect(repository.cases).toContain('STALE_PROVIDER_EXECUTION_EVENT');
    expect(repository.current.modelCode).toBe('mock-video-v1');
  });

  it('settles after asset durability and releases only the quote difference using stable keys', async () => {
    const { consumer, wallet, repository } = harness(
      task({
        status: 'SUCCEEDED',
        version: 5,
        settlementPoints: '900',
        assetImportRequested: true,
      }),
    );

    await expect(consumer.consume(assetImportedEvent())).resolves.toEqual({
      ack: true,
      outcome: 'SETTLED',
    });

    expect(wallet.settle).toHaveBeenCalledWith({
      businessKey: `task:${TASK_ID}:settle`,
      userId: USER_ID,
      kind: 'SETTLE',
      points: '900',
      reason: 'GENERATION_SUCCEEDED',
    });
    expect(wallet.release).toHaveBeenCalledWith({
      businessKey: `task:${TASK_ID}:quote-difference-release`,
      userId: USER_ID,
      kind: 'RELEASE',
      points: '300',
      reason: 'QUOTE_DIFFERENCE',
    });
    expect(repository.current).toMatchObject({ status: 'SETTLED', assetId: ASSET_ID });
  });

  it('fences the second financial effect when Inbox ownership expires after settlement', async () => {
    const repository = new MemoryRepository(
      task({
        status: 'SUCCEEDED',
        version: 5,
        settlementPoints: '900',
        assetImportRequested: true,
      }),
    );
    const wallet: WalletEffectsPort = {
      settle: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const clockValues = [NOW, NOW, NOW, new Date(NOW.getTime() + 60_000)];
    const consumer = new ProviderEventsConsumer({
      repository,
      asset: { requestImport: vi.fn(async () => undefined) },
      wallet,
      cancellation: null,
      clock: { now: () => clockValues.shift() ?? new Date(NOW.getTime() + 60_000) },
      ids: { next: () => '0198f4d4-21c2-7b7d-8a03-08a0da2a51fc' },
    });

    await expect(consumer.consume(assetImportedEvent())).rejects.toThrow('INBOX_LEASE_EXPIRED');
    expect(wallet.settle).toHaveBeenCalledOnce();
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it('does not issue a zero-point release when settlement consumes the full quote', async () => {
    const { consumer, wallet } = harness(
      task({ status: 'SUCCEEDED', version: 5, assetImportRequested: true }),
    );

    await expect(consumer.consume(assetImportedEvent())).resolves.toMatchObject({
      outcome: 'SETTLED',
    });

    expect(wallet.settle).toHaveBeenCalledWith(expect.objectContaining({ points: '1200' }));
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it('routes an unexpected early asset event to an operator case without financial effects', async () => {
    const { consumer, repository, wallet } = harness(task({ status: 'RUNNING' }));

    await expect(consumer.consume(assetImportedEvent())).resolves.toMatchObject({
      outcome: 'OPERATOR_REQUIRED',
    });

    expect(repository.cases).toContain('UNEXPECTED_ASSET_IMPORTED_EVENT');
    expect(wallet.settle).not.toHaveBeenCalled();
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it('fully releases quoted points after provider failure before marking REFUNDED', async () => {
    const { consumer, wallet, repository } = harness();

    await expect(consumer.consume(providerEvent('provider.execution-failed.v1'))).resolves.toEqual({
      ack: true,
      outcome: 'REFUNDED',
    });

    expect(wallet.release).toHaveBeenCalledWith({
      businessKey: `task:${TASK_ID}:provider-failure-release`,
      userId: USER_ID,
      kind: 'RELEASE',
      points: '1200',
      reason: 'PROVIDER_FAILED',
    });
    expect(repository.current.status).toBe('REFUNDED');
  });

  it('fully releases a provider-confirmed cancellation event', async () => {
    const { consumer, wallet, repository } = harness();

    await expect(
      consumer.consume(providerEvent('provider.execution-canceled.v1')),
    ).resolves.toEqual({
      ack: true,
      outcome: 'REFUNDED',
    });

    expect(wallet.release).toHaveBeenCalledWith(
      expect.objectContaining({ points: '1200', reason: 'PROVIDER_CANCELED' }),
    );
    expect(repository.current.status).toBe('REFUNDED');
  });

  it('deduplicates an already completed delivery without repeating effects', async () => {
    const { consumer, asset } = harness();
    const event = providerEvent('provider.execution-succeeded.v1');

    await consumer.consume(event);
    await expect(consumer.consume(event)).resolves.toEqual({
      ack: true,
      outcome: 'DUPLICATE_COMPLETE',
    });

    expect(asset.requestImport).toHaveBeenCalledTimes(1);
  });

  it('deduplicates a completed cancellation request without repeating wallet effects', async () => {
    const { consumer, wallet } = harness(
      task({
        status: 'QUEUED',
        version: 2,
        providerAccepted: false,
        providerStateRank: 0,
        providerTaskId: null,
      }),
    );
    const input = {
      messageId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51dc',
      taskId: TASK_ID,
      traceId: '8'.repeat(32),
      userId: USER_ID,
      currentStatus: 'QUEUED' as const,
      currentVersion: 2,
    };

    await consumer.cancel(input);
    await expect(consumer.cancel(input)).resolves.toEqual({
      ack: true,
      outcome: 'DUPLICATE_COMPLETE',
    });
    expect(wallet.release).toHaveBeenCalledTimes(1);
  });

  it('resumes asset import with the same key after success state committed but the first effect failed', async () => {
    const { consumer, asset, repository } = harness();
    vi.mocked(asset.requestImport)
      .mockRejectedValueOnce(new Error('asset unavailable'))
      .mockResolvedValueOnce(undefined);
    const event = providerEvent('provider.execution-succeeded.v1');

    await expect(consumer.consume(event)).rejects.toThrow('asset unavailable');
    expect(repository.current.status).toBe('SUCCEEDED');
    expect(repository.messages.get(event.id)).toBe('PENDING');
    await expect(consumer.consume(event)).resolves.toMatchObject({
      ack: true,
      outcome: 'ASSET_IMPORT_PENDING',
    });

    expect(asset.requestImport).toHaveBeenCalledTimes(2);
    expect(asset.requestImport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ businessKey: `task:${TASK_ID}:asset-import` }),
    );
  });

  it('resumes full release after FAILED committed but the first wallet call failed', async () => {
    const { consumer, wallet, repository } = harness();
    vi.mocked(wallet.release)
      .mockRejectedValueOnce(new Error('wallet unavailable'))
      .mockResolvedValueOnce(undefined);
    const event = providerEvent('provider.execution-failed.v1');

    await expect(consumer.consume(event)).rejects.toThrow('wallet unavailable');
    expect(repository.current.status).toBe('FAILED');
    await expect(consumer.consume(event)).resolves.toMatchObject({
      ack: true,
      outcome: 'REFUNDED',
    });

    expect(wallet.release).toHaveBeenCalledTimes(2);
    expect(repository.current.status).toBe('REFUNDED');
  });

  it('ignores a lower-rank out-of-order provider event after success', async () => {
    const { consumer, repository } = harness(
      task({ status: 'SUCCEEDED', version: 5, providerStateRank: 3, assetImportRequested: true }),
    );

    await expect(consumer.consume(providerEvent('provider.execution-running.v1'))).resolves.toEqual(
      {
        ack: true,
        outcome: 'STALE_PROVIDER_EVENT',
      },
    );

    expect(repository.current.status).toBe('SUCCEEDED');
  });

  it('does not regress a successful task when a conflicting terminal failure arrives later', async () => {
    const { consumer, repository, wallet } = harness(
      task({ status: 'SUCCEEDED', version: 5, providerStateRank: 3, assetImportRequested: true }),
    );

    await expect(consumer.consume(providerEvent('provider.execution-failed.v1'))).resolves.toEqual({
      ack: true,
      outcome: 'STALE_PROVIDER_EVENT',
    });

    expect(repository.current.status).toBe('SUCCEEDED');
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it('does not import an asset when success arrives after a durable provider failure', async () => {
    const { consumer, repository, asset } = harness(
      task({ status: 'FAILED', version: 5, providerStateRank: 3 }),
    );

    await expect(
      consumer.consume(providerEvent('provider.execution-succeeded.v1')),
    ).resolves.toEqual({
      ack: true,
      outcome: 'STALE_PROVIDER_EVENT',
    });

    expect(repository.current.status).toBe('FAILED');
    expect(asset.requestImport).not.toHaveBeenCalled();
  });

  it('completes terminal duplicates for settled/refunded tasks without repeating effects', async () => {
    const settled = harness(task({ status: 'SETTLED', version: 6, providerStateRank: 3 }));
    await expect(
      settled.consumer.consume(providerEvent('provider.execution-succeeded.v1')),
    ).resolves.toMatchObject({ outcome: 'STALE_PROVIDER_EVENT' });
    await expect(settled.consumer.consume(assetImportedEvent())).resolves.toMatchObject({
      outcome: 'STALE_PROVIDER_EVENT',
    });
    expect(settled.asset.requestImport).not.toHaveBeenCalled();
    expect(settled.wallet.settle).not.toHaveBeenCalled();

    const refunded = harness(task({ status: 'REFUNDED', version: 6, providerStateRank: 3 }));
    await expect(
      refunded.consumer.consume(providerEvent('provider.execution-failed.v1')),
    ).resolves.toMatchObject({ outcome: 'STALE_PROVIDER_EVENT' });
    expect(refunded.wallet.release).not.toHaveBeenCalled();
  });

  it('creates an operator case for ambiguous acceptance without refunding or importing', async () => {
    const { consumer, repository, wallet, asset } = harness(
      task({ providerTaskId: null, providerAccepted: false, providerStateRank: 0 }),
    );

    await expect(
      consumer.consume(providerEvent('provider.execution-ambiguous.v1')),
    ).resolves.toEqual({
      ack: true,
      outcome: 'OPERATOR_REQUIRED',
    });

    expect(repository.cases).toContain('PROVIDER_ACCEPTANCE_AMBIGUOUS');
    expect(wallet.release).not.toHaveBeenCalled();
    expect(wallet.settle).not.toHaveBeenCalled();
    expect(asset.requestImport).not.toHaveBeenCalled();
  });

  it('releases fully when cancellation is requested before provider acceptance', async () => {
    const { consumer, wallet, cancellation, repository } = harness(
      task({
        status: 'QUEUED',
        version: 2,
        providerAccepted: false,
        providerStateRank: 0,
        providerTaskId: null,
      }),
    );

    await expect(
      consumer.cancel({
        messageId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d0',
        taskId: TASK_ID,
        traceId: 'c'.repeat(32),
        userId: USER_ID,
        currentStatus: 'QUEUED',
        currentVersion: 2,
      }),
    ).resolves.toEqual({ ack: true, outcome: 'REFUNDED' });

    expect(cancellation.cancel).not.toHaveBeenCalled();
    expect(wallet.release).toHaveBeenCalledWith(
      expect.objectContaining({
        businessKey: `task:${TASK_ID}:pre-acceptance-cancel-release`,
        points: '1200',
      }),
    );
    expect(repository.current.status).toBe('REFUNDED');
  });

  it('resumes a pre-acceptance cancellation with the same release key after a wallet failure', async () => {
    const { consumer, wallet, repository } = harness(
      task({
        status: 'QUEUED',
        version: 2,
        providerAccepted: false,
        providerStateRank: 0,
        providerTaskId: null,
      }),
    );
    vi.mocked(wallet.release)
      .mockRejectedValueOnce(new Error('wallet unavailable'))
      .mockResolvedValueOnce(undefined);
    const input = {
      messageId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51dd',
      taskId: TASK_ID,
      traceId: '9'.repeat(32),
      userId: USER_ID,
      currentStatus: 'QUEUED' as const,
      currentVersion: 2,
    };

    await expect(consumer.cancel(input)).rejects.toThrow('wallet unavailable');
    expect(repository.current.status).toBe('CANCELED');
    await expect(consumer.cancel(input)).resolves.toEqual({ ack: true, outcome: 'REFUNDED' });

    expect(wallet.release).toHaveBeenCalledTimes(2);
    expect(wallet.release).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        businessKey: `task:${TASK_ID}:pre-acceptance-cancel-release`,
      }),
    );
    expect(repository.current.status).toBe('REFUNDED');
  });

  it('consumes the durable generation.task-cancel-requested.v1 outbox event', async () => {
    const { consumer, repository } = harness(
      task({
        status: 'QUEUED',
        version: 2,
        providerAccepted: false,
        providerStateRank: 0,
        providerTaskId: null,
      }),
    );
    const messageId = '0198f4d4-21c2-7b7d-8a03-08a0da2a51d4';

    await expect(
      consumer.consume({
        id: messageId,
        type: 'generation.task-cancel-requested.v1',
        version: 1,
        occurredAt: NOW.toISOString(),
        traceId: 'f'.repeat(32),
        correlationId: TASK_ID,
        causationId: TASK_ID,
        producer: 'generation-service',
        data: {
          taskId: TASK_ID,
          userId: USER_ID,
          currentStatus: 'QUEUED',
          currentVersion: 2,
        },
      }),
    ).resolves.toEqual({ ack: true, outcome: 'REFUNDED' });

    expect(repository.current.status).toBe('REFUNDED');
    expect(repository.messages.get(messageId)).toBe('COMPLETE');
  });

  it('never fakes remote cancellation after acceptance when cancellation is unsupported', async () => {
    const { repository, asset, wallet } = harness(task({ cancellationChargePoints: '600' }));
    const consumer = new ProviderEventsConsumer({
      repository,
      asset,
      wallet,
      cancellation: null,
      clock: { now: () => NOW },
      ids: { next: () => '0198f4d4-21c2-7b7d-8a03-08a0da2a51d1' },
    });

    await expect(
      consumer.cancel({
        messageId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d2',
        taskId: TASK_ID,
        traceId: 'd'.repeat(32),
        userId: USER_ID,
        currentStatus: 'RUNNING',
        currentVersion: 4,
      }),
    ).resolves.toEqual({ ack: true, outcome: 'OPERATOR_REQUIRED' });

    expect(repository.current.status).toBe('RUNNING');
    expect(repository.cases).toContain('REMOTE_CANCELLATION_UNSUPPORTED');
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it('requires operator disposition for unverifiable acceptance and a missing stored rule', async () => {
    const unverifiable = harness(
      task({ providerAccepted: false, providerTaskId: 'possibly-created', status: 'RUNNING' }),
    );
    await expect(
      unverifiable.consumer.cancel({
        messageId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d7',
        taskId: TASK_ID,
        traceId: '2'.repeat(32),
        userId: USER_ID,
        currentStatus: 'RUNNING',
        currentVersion: 4,
      }),
    ).resolves.toMatchObject({ outcome: 'OPERATOR_REQUIRED' });
    expect(unverifiable.repository.cases).toContain('CANCELLATION_ACCEPTANCE_UNVERIFIABLE');

    const missingRule = harness(task({ cancellationChargePoints: null }));
    await expect(
      missingRule.consumer.cancel({
        messageId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d8',
        taskId: TASK_ID,
        traceId: '3'.repeat(32),
        userId: USER_ID,
        currentStatus: 'RUNNING',
        currentVersion: 4,
      }),
    ).resolves.toMatchObject({ outcome: 'OPERATOR_REQUIRED' });
    expect(missingRule.repository.cases).toContain('CANCELLATION_RULE_MISSING');
  });

  it('applies the stored post-acceptance cancellation charge only after remote confirmation', async () => {
    const { consumer, cancellation, wallet, repository } = harness(
      task({ cancellationChargePoints: '600' }),
    );

    await expect(
      consumer.cancel({
        messageId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d3',
        taskId: TASK_ID,
        traceId: 'e'.repeat(32),
        userId: USER_ID,
        currentStatus: 'RUNNING',
        currentVersion: 4,
      }),
    ).resolves.toEqual({ ack: true, outcome: 'SETTLED' });

    expect(cancellation.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        providerTaskId: 'provider-task-1',
        businessKey: `task:${TASK_ID}:provider-cancel`,
      }),
    );
    expect(wallet.settle).toHaveBeenCalledWith(
      expect.objectContaining({ points: '600', businessKey: `task:${TASK_ID}:settle` }),
    );
    expect(wallet.release).toHaveBeenCalledWith(
      expect.objectContaining({
        points: '600',
        businessKey: `task:${TASK_ID}:quote-difference-release`,
      }),
    );
    expect(repository.current.status).toBe('SETTLED');
  });

  it('resumes confirmed post-acceptance cancellation finance with stable business keys', async () => {
    const { consumer, cancellation, wallet, repository } = harness(
      task({ cancellationChargePoints: '600' }),
    );
    vi.mocked(wallet.settle)
      .mockRejectedValueOnce(new Error('wallet unavailable'))
      .mockResolvedValueOnce(undefined);
    const input = {
      messageId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51de',
      taskId: TASK_ID,
      traceId: '0'.repeat(32),
      userId: USER_ID,
      currentStatus: 'RUNNING' as const,
      currentVersion: 4,
    };

    await expect(consumer.cancel(input)).rejects.toThrow('wallet unavailable');
    expect(repository.current.status).toBe('CANCELED');
    await expect(consumer.cancel(input)).resolves.toEqual({ ack: true, outcome: 'SETTLED' });

    expect(cancellation.cancel).toHaveBeenCalledTimes(2);
    expect(cancellation.cancel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ businessKey: `task:${TASK_ID}:provider-cancel` }),
    );
    expect(wallet.settle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ businessKey: `task:${TASK_ID}:settle` }),
    );
    expect(repository.current.status).toBe('SETTLED');
  });

  it('requires an operator when remote cancellation or its billing disposition is unconfirmed', async () => {
    const { repository, asset, wallet, cancellation } = harness(
      task({ cancellationChargePoints: '600' }),
    );
    vi.mocked(cancellation.cancel).mockResolvedValueOnce({ outcome: 'AMBIGUOUS' });
    const consumer = new ProviderEventsConsumer({
      repository,
      asset,
      wallet,
      cancellation,
      clock: { now: () => NOW },
      ids: { next: () => '0198f4d4-21c2-7b7d-8a03-08a0da2a51d5' },
    });

    await expect(
      consumer.cancel({
        messageId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d6',
        taskId: TASK_ID,
        traceId: '1'.repeat(32),
        userId: USER_ID,
        currentStatus: 'RUNNING',
        currentVersion: 4,
      }),
    ).resolves.toMatchObject({ outcome: 'OPERATOR_REQUIRED' });

    expect(repository.cases).toContain('REMOTE_CANCELLATION_UNCONFIRMED');
    expect(repository.current.status).toBe('RUNNING');
    expect(wallet.settle).not.toHaveBeenCalled();
  });

  it('supports a confirmed zero-charge cancellation and blocks charges above the quote', async () => {
    const free = harness(task({ cancellationChargePoints: '0' }));
    await expect(
      free.consumer.cancel({
        messageId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d9',
        taskId: TASK_ID,
        traceId: '4'.repeat(32),
        userId: USER_ID,
        currentStatus: 'RUNNING',
        currentVersion: 4,
      }),
    ).resolves.toMatchObject({ outcome: 'REFUNDED' });
    expect(free.wallet.release).toHaveBeenCalledWith(
      expect.objectContaining({ businessKey: `task:${TASK_ID}:quote-difference-release` }),
    );

    const excessive = harness(task({ cancellationChargePoints: '1201' }));
    await expect(
      excessive.consumer.cancel({
        messageId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51da',
        taskId: TASK_ID,
        traceId: '5'.repeat(32),
        userId: USER_ID,
        currentStatus: 'RUNNING',
        currentVersion: 4,
      }),
    ).resolves.toMatchObject({ outcome: 'OPERATOR_REQUIRED' });
    expect(excessive.repository.cases).toContain('CANCELLATION_RULE_EXCEEDS_QUOTE');
    expect(excessive.wallet.settle).not.toHaveBeenCalled();
  });

  it('does not settle when stored consumption exceeds the user quote', async () => {
    const { consumer, wallet } = harness(
      task({
        status: 'SUCCEEDED',
        version: 5,
        assetImportRequested: true,
        settlementPoints: '1201',
      }),
    );

    await expect(consumer.consume(assetImportedEvent())).rejects.toThrow(
      'SETTLEMENT_EXCEEDS_QUOTE',
    );
    expect(wallet.settle).not.toHaveBeenCalled();
  });

  it('rejects a non-canonical stored point amount before issuing a financial effect', async () => {
    const { consumer, wallet } = harness(
      task({
        status: 'SUCCEEDED',
        version: 5,
        assetImportRequested: true,
        settlementPoints: '01',
      }),
    );

    await expect(consumer.consume(assetImportedEvent())).rejects.toThrow('INVALID_POINTS');
    expect(wallet.settle).not.toHaveBeenCalled();
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it('returns retry for missing/conflicting Inbox ownership and fences stale writes', async () => {
    const missing = harness();
    vi.spyOn(missing.repository as ProviderEventRepository, 'claim').mockResolvedValueOnce({
      kind: 'TASK_NOT_FOUND',
    });
    await expect(
      missing.consumer.consume(providerEvent('provider.execution-running.v1')),
    ).resolves.toEqual({ ack: false, outcome: 'RETRY' });

    const conflicting = harness();
    vi.spyOn(conflicting.repository as ProviderEventRepository, 'claim').mockResolvedValueOnce({
      kind: 'PAYLOAD_CONFLICT',
    });
    await expect(
      conflicting.consumer.cancel({
        messageId: TASK_ID,
        taskId: TASK_ID,
        traceId: '6'.repeat(32),
        userId: USER_ID,
        currentStatus: 'RUNNING',
        currentVersion: 4,
      }),
    ).resolves.toEqual({ ack: false, outcome: 'RETRY' });

    const fenced = harness();
    vi.spyOn(fenced.repository, 'write').mockResolvedValueOnce({ kind: 'STALE' });
    await expect(
      fenced.consumer.consume(providerEvent('provider.execution-running.v1')),
    ).rejects.toThrow('TASK_SAGA_FENCED');
  });

  it('rejects malformed cancel and asset events after envelope validation', async () => {
    const { consumer } = harness();
    const cancelEvent = {
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51db',
      type: 'generation.task-cancel-requested.v1',
      version: 1,
      occurredAt: NOW.toISOString(),
      traceId: '7'.repeat(32),
      correlationId: TASK_ID,
      producer: 'wrong-service',
      data: { taskId: TASK_ID, userId: USER_ID, currentStatus: 'RUNNING', currentVersion: 4 },
    };
    await expect(consumer.consume(cancelEvent)).rejects.toThrow('INVALID_CANCEL_REQUESTED_EVENT');
    const assetEvent = assetImportedEvent();
    assetEvent.data.importBusinessKey = 'wrong-key';
    await expect(consumer.consume(assetEvent)).rejects.toThrow('INVALID_ASSET_IMPORTED_EVENT');
    await expect(consumer.consume({ nope: true })).rejects.toThrow('INVALID_GENERATION_EVENT');
  });

  it('rejects a mismatched event before claiming Inbox state', async () => {
    const { consumer, repository } = harness();
    const event = providerEvent('provider.execution-running.v1');
    event.correlationId = '0198f4d4-21c2-7b7d-8a03-08a0da2a51ff';

    await expect(consumer.consume(event)).rejects.toThrow('INVALID_PROVIDER_EVENT');
    expect(repository.messages.size).toBe(0);
  });

  it('ACKs transport only after the durable handler completes and retries failures', async () => {
    const consume = vi.fn<ProviderEventsConsumer['consume']>(async () => ({
      ack: true,
      outcome: 'PROGRESSED',
    }));
    const handler = { consume };
    const transport = new ProviderEventsDeliveryConsumer(handler);
    const ack = vi.fn(async () => undefined);
    const retry = vi.fn(async () => undefined);

    await transport.consume({ body: providerEvent('provider.execution-running.v1'), ack, retry });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    consume.mockRejectedValueOnce(new Error('commit failed'));
    await transport.consume({ body: {}, ack, retry });
    expect(retry).toHaveBeenCalledTimes(1);

    consume.mockResolvedValueOnce({ ack: false, outcome: 'RETRY' });
    await transport.consume({ body: {}, ack, retry });
    expect(retry).toHaveBeenCalledTimes(2);
  });
});
