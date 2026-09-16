/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from 'vitest';
import {
  ProviderEventsConsumer,
  type ProviderEventRepository,
  type SagaTask,
  type SagaWrite,
} from '../src/application/provider-events.consumer.js';
import {
  isSafeFailoverAuthorized,
  TaskRepairJob,
  type ProviderRuntimeInspection,
  type ProviderRuntimeStatusPort,
} from '../src/application/task-repair.job.js';
import type { LedgerCommand } from '../src/application/ports.js';
import { GenerationMetrics } from '../src/runtime/operations.js';
import type { GenerationDomainObserver } from '../src/application/observability.js';

const TASK_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0';
const USER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2';
const PROVIDER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a5';
const SUBSTITUTE_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a6';
const CAPABILITY_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4';
const EXECUTION_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b6';
const NOW = new Date('2026-09-01T09:00:00.000Z');

function staleTask(overrides: Partial<SagaTask> = {}): SagaTask {
  return {
    taskId: TASK_ID,
    userId: USER_ID,
    quoteId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a3',
    status: 'SUBMITTING',
    version: 3,
    sagaVersion: 0,
    quotedPoints: '1200',
    settlementPoints: '1200',
    capabilityVersionId: CAPABILITY_ID,
    parametersSnapshotSha256: 'f'.repeat(64),
    providerAccepted: false,
    providerStateRank: 0,
    providerId: PROVIDER_ID,
    providerTaskId: 'provider-task-1',
    modelCode: 'mock-video-v1',
    executionId: EXECUTION_ID,
    routeEpoch: 0,
    assetImportRequested: false,
    assetImportDispatched: false,
    assetId: null,
    routingFailoverAuthorized: true,
    cancellationChargePoints: null,
    cancelRequested: false,
    financialDisposition: null,
    financialSettlementKey: null,
    financialReleaseKey: null,
    substitute: {
      providerId: SUBSTITUTE_ID,
      modelCode: 'mock-video-v2',
      capabilityVersionId: CAPABILITY_ID,
      pricePoints: '900',
    },
    updatedAt: new Date('2026-09-01T08:00:00.000Z'),
    ...overrides,
  };
}

function boundInspection(
  task: SagaTask,
  facts: Omit<
    ProviderRuntimeInspection,
    'taskId' | 'providerId' | 'executionId' | 'providerTaskId' | 'routeEpoch'
  >,
): ProviderRuntimeInspection {
  return {
    taskId: task.taskId,
    providerId: String(task.providerId),
    executionId: String(task.executionId),
    providerTaskId: String(task.providerTaskId),
    routeEpoch: task.routeEpoch,
    ...facts,
  };
}

function noopWallet() {
  return {
    settle: vi.fn(async (command: LedgerCommand) => {
      void command;
    }),
    release: vi.fn(async (command: LedgerCommand) => {
      void command;
    }),
  };
}

class RepairRepository implements ProviderEventRepository {
  current: SagaTask;
  readonly messages = new Map<string, 'PENDING' | 'COMPLETE'>();
  readonly writes: SagaWrite[] = [];
  readonly renewResults: Array<'RENEWED' | 'FENCED'> = [];
  readonly renewals: Array<{ messageId: string; leaseToken: string }> = [];

  constructor(initial: SagaTask) {
    this.current = initial;
  }

  async claim(input: Parameters<ProviderEventRepository['claim']>[0]) {
    const prior = this.messages.get(input.messageId);
    if (prior === 'COMPLETE') return { kind: 'DUPLICATE_COMPLETE' as const };
    if (prior === 'PENDING') return { kind: 'CLAIMED' as const, task: this.current };
    this.messages.set(input.messageId, 'PENDING');
    return { kind: 'CLAIMED' as const, task: this.current };
  }

  async write(input: SagaWrite) {
    if (input.expectedVersion !== this.current.version) return { kind: 'STALE' as const };
    this.writes.push(input);
    this.current = {
      ...this.current,
      ...input.patch,
      version: input.transitions.at(-1)?.taskVersion ?? this.current.version,
      sagaVersion: this.current.sagaVersion + 1,
      updatedAt: input.committedAt,
    };
    if (input.completeMessage) this.messages.set(input.messageId, 'COMPLETE');
    return { kind: 'APPLIED' as const, task: this.current };
  }

  async getTask() {
    return this.current;
  }

  async renewLease(input: { messageId: string; leaseToken: string }) {
    this.renewals.push(input);
    const kind = this.renewResults.shift() ?? 'RENEWED';
    return { kind };
  }

  async findStale(query: Parameters<ProviderEventRepository['findStale']>[0]) {
    void query;
    return [this.current];
  }
}

function harness(
  initial: SagaTask,
  inspection: Omit<
    ProviderRuntimeInspection,
    'taskId' | 'providerId' | 'executionId' | 'providerTaskId' | 'routeEpoch'
  > &
    Partial<
      Pick<
        ProviderRuntimeInspection,
        'taskId' | 'providerId' | 'executionId' | 'providerTaskId' | 'routeEpoch'
      >
    >,
  options: {
    readonly clock?: { now(): Date };
    readonly observer?: GenerationDomainObserver;
  } = {},
) {
  const repository = new RepairRepository(initial);
  const boundInspection = {
    taskId: initial.taskId,
    providerId: initial.providerId,
    executionId: initial.executionId,
    providerTaskId: initial.providerTaskId,
    routeEpoch: initial.routeEpoch,
    ...inspection,
  } as ProviderRuntimeInspection;
  const provider: ProviderRuntimeStatusPort = { inspect: vi.fn(async () => boundInspection) };
  const asset = { requestImport: vi.fn(async () => undefined) };
  const wallet = noopWallet();
  let sequence = 0xe0;
  const ids = { next: () => `0198f4d4-21c2-7b7d-8a03-08a0da2a51${(sequence++).toString(16)}` };
  const clock = options.clock ?? { now: () => NOW };
  const consumer = new ProviderEventsConsumer({
    repository,
    asset,
    wallet,
    cancellation: null,
    clock,
    ids,
    ...(options.observer === undefined ? {} : { observer: options.observer }),
  });
  const job = new TaskRepairJob({
    repository,
    provider,
    providerEvents: consumer,
    wallet,
    clock,
    ids,
    ...(options.observer === undefined ? {} : { observer: options.observer }),
  });
  return { repository, provider, asset, wallet, consumer, job };
}

describe('TaskRepairJob', () => {
  it('refreshes gauges from the durable global snapshot rather than the bounded scan batch', async () => {
    const metrics = new GenerationMetrics();
    const { job, repository } = harness(
      staleTask(),
      { state: 'RUNNING', acceptance: 'ACCEPTED', billing: 'BILLED' },
      { observer: metrics },
    );
    Object.assign(repository, {
      repairMetricsSnapshot: vi.fn().mockResolvedValue({
        repairCases: {
          AMBIGUOUS_PROVIDER_RESULT: 7,
          FINANCIAL_EFFECT_PENDING: 5,
          STALE_STATUS: 11,
        },
        financialSagaLag: { ASSET_IMPORT: 13, SETTLEMENT: 17, RELEASE: 19 },
      }),
    });

    await job.run();

    const output = metrics.render();
    expect(output).toContain('generation_repair_cases{reason="AMBIGUOUS_PROVIDER_RESULT"} 7');
    expect(output).toContain('generation_repair_cases{reason="FINANCIAL_EFFECT_PENDING"} 5');
    expect(output).toContain('generation_repair_cases{reason="STALE_STATUS"} 11');
    expect(output).toContain('generation_financial_saga_lag_seconds{phase="RELEASE"} 19');
  });

  it('publishes repair and financial lag metrics from an actual repair scan', async () => {
    const metrics = new GenerationMetrics();
    const initial = staleTask({
      status: 'FAILED',
      providerTaskId: null,
      executionId: null,
      financialDisposition: 'PROVIDER_FAILED_FULL_RELEASE',
      financialReleaseKey: `task:${TASK_ID}:provider-failure-release`,
    });
    const { job, repository } = harness(
      initial,
      { state: 'FAILED', acceptance: 'UNKNOWN', billing: 'UNKNOWN' },
      { observer: metrics },
    );

    await job.run();

    const output = metrics.render();
    expect(output).toContain('generation_repair_cases{reason="FINANCIAL_EFFECT_PENDING"} 1');
    expect(output).toContain('generation_financial_saga_lag_seconds{phase="RELEASE"} 3600');

    repository.current = staleTask({
      status: 'RUNNING',
      financialDisposition: null,
      financialReleaseKey: null,
      assetImportRequested: false,
    });
    await job.run();
    const refreshed = metrics.render();
    expect(refreshed).toContain('generation_repair_cases{reason="FINANCIAL_EFFECT_PENDING"} 0');
    expect(refreshed).toContain('generation_financial_saga_lag_seconds{phase="RELEASE"} 0');
    expect(refreshed).toContain('generation_financial_saga_lag_seconds{phase="SETTLEMENT"} 0');
    expect(refreshed).toContain('generation_financial_saga_lag_seconds{phase="ASSET_IMPORT"} 0');
  });
  it('uses fresh trusted time for each task claim instead of the batch scan time', async () => {
    let instant = NOW.getTime();
    const clock = {
      now: vi.fn(() => {
        const value = new Date(instant);
        instant += 61_000;
        return value;
      }),
    };
    const first = staleTask({ providerTaskId: null, executionId: null });
    const second = staleTask({
      taskId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51aa',
      providerTaskId: null,
      executionId: null,
    });
    const tasks = new Map([
      [first.taskId, first],
      [second.taskId, second],
    ]);
    const taskFor = (taskId: string): SagaTask => {
      const found = tasks.get(taskId);
      if (found === undefined) throw new Error('TEST_TASK_NOT_FOUND');
      return found;
    };
    const find = vi.fn(async (query: Parameters<ProviderEventRepository['findStale']>[0]) => {
      void query;
      return [first, second];
    });
    const claim = vi.fn(async (input: Parameters<ProviderEventRepository['claim']>[0]) => ({
      kind: 'CLAIMED' as const,
      task: taskFor(input.taskId),
    }));
    const repository: ProviderEventRepository = {
      findStale: find,
      claim,
      renewLease: vi.fn(async () => ({ kind: 'RENEWED' as const })),
      write: vi.fn(async (input: Parameters<ProviderEventRepository['write']>[0]) => ({
        kind: 'APPLIED' as const,
        task: taskFor(input.taskId),
      })),
      getTask: vi.fn(async (taskId: string) => tasks.get(taskId) ?? null),
    };
    let id = 0xd0;
    const job = new TaskRepairJob({
      repository,
      provider: { inspect: vi.fn() },
      providerEvents: { consume: vi.fn() },
      wallet: noopWallet(),
      clock,
      ids: { next: () => `0198f4d4-21c2-7b7d-8a03-08a0da2a51${(id++).toString(16)}` },
    });

    await job.run();

    const scanNow = find.mock.calls[0]?.[0].now;
    const firstClaimNow = claim.mock.calls[0]?.[0].receivedAt;
    const secondClaimNow = claim.mock.calls[1]?.[0].receivedAt;
    expect(firstClaimNow?.getTime()).toBeGreaterThan(Number(scanNow?.getTime()));
    expect(secondClaimNow?.getTime()).toBeGreaterThan(Number(firstClaimNow?.getTime()));
  });

  it('does not call wallet after the repair lease is fenced by takeover', async () => {
    const initial = staleTask({
      status: 'FAILED',
      providerTaskId: null,
      executionId: null,
      financialDisposition: 'PROVIDER_FAILED_FULL_RELEASE',
      financialReleaseKey: `task:${TASK_ID}:provider-failure-release`,
    });
    const { job, repository, wallet } = harness(initial, {
      state: 'AMBIGUOUS',
      acceptance: 'UNKNOWN',
      billing: 'UNKNOWN',
    });
    repository.renewResults.push('FENCED');

    await expect(job.run()).resolves.toMatchObject({ unchanged: 1, repaired: 0 });
    expect(wallet.release).not.toHaveBeenCalled();
    expect(repository.writes).toHaveLength(0);
  });

  it('does not commit after inspection outlives the renewed 60-second lease', async () => {
    let instant = NOW.getTime();
    const initial = staleTask();
    const inspection = boundInspection(initial, {
      state: 'FAILED',
      acceptance: 'UNACCEPTED',
      billing: 'UNBILLED',
    });
    const { job, repository, provider } = harness(initial, inspection, {
      clock: { now: () => new Date(instant) },
    });
    vi.mocked(provider.inspect).mockImplementationOnce(async () => {
      instant += 61_000;
      return inspection;
    });
    repository.renewResults.push('RENEWED', 'FENCED');

    await expect(job.run()).resolves.toMatchObject({ unchanged: 1, failedOver: 0 });
    expect(provider.inspect).toHaveBeenCalledTimes(1);
    expect(repository.writes).toHaveLength(0);
  });

  it('renews around wallet effects and commits with fresh trusted time after 60 seconds', async () => {
    let instant = NOW.getTime();
    const initial = staleTask({
      status: 'SUCCEEDED',
      providerId: null,
      providerTaskId: null,
      executionId: null,
      assetId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51ad',
      financialDisposition: 'SUCCESS_SETTLEMENT',
      financialSettlementKey: `task:${TASK_ID}:success-settle`,
      financialReleaseKey: `task:${TASK_ID}:success-release`,
      settlementPoints: '900',
    });
    const { job, repository, wallet } = harness(
      initial,
      { state: 'AMBIGUOUS', acceptance: 'UNKNOWN', billing: 'UNKNOWN' },
      { clock: { now: () => new Date(instant) } },
    );
    wallet.settle.mockImplementationOnce(async () => {
      instant += 61_000;
    });

    await expect(job.run()).resolves.toMatchObject({ repaired: 1 });
    expect(repository.renewals).toHaveLength(3);
    expect(wallet.release).toHaveBeenCalledTimes(1);
    expect(repository.writes.at(-1)?.committedAt.getTime()).toBe(instant);
  });

  it.each([
    ['FAILED', 'ACCEPTED', 'UNBILLED'],
    ['CANCELED', 'ACCEPTED', 'UNBILLED'],
    ['FAILED', 'UNACCEPTED', 'UNBILLED'],
  ] as const)(
    'refunds EXPIRED only after definitive safe provider facts %s/%s/%s',
    async (state, acceptance, billing) => {
      const initial = staleTask({ status: 'EXPIRED', routingFailoverAuthorized: false });
      const { job, repository, wallet } = harness(initial, { state, acceptance, billing });
      wallet.release.mockImplementationOnce(async (command) => {
        expect(repository.current.financialDisposition).toBe('EXPIRED_FULL_RELEASE');
        expect(repository.current.financialReleaseKey).toBe(`task:${TASK_ID}:expired-release`);
        expect(command.businessKey).toBe(`task:${TASK_ID}:expired-release`);
      });

      await expect(job.run()).resolves.toMatchObject({ repaired: 1, operatorRequired: 0 });
      expect(repository.writes[0]).toMatchObject({
        completeMessage: false,
        patch: {
          financialDisposition: 'EXPIRED_FULL_RELEASE',
          financialSettlementKey: null,
          financialReleaseKey: `task:${TASK_ID}:expired-release`,
        },
      });
      expect(repository.current.status).toBe('REFUNDED');
      expect(wallet.release).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['AMBIGUOUS', 'UNACCEPTED', 'UNBILLED'],
    ['SUCCEEDED', 'ACCEPTED', 'UNBILLED'],
    ['ACCEPTED', 'ACCEPTED', 'UNBILLED'],
    ['RUNNING', 'ACCEPTED', 'UNBILLED'],
    ['FAILED', 'ACCEPTED', 'BILLED'],
    ['FAILED', 'UNACCEPTED', 'BILLED'],
    ['CANCELED', 'ACCEPTED', 'BILLED'],
    ['CANCELED', 'UNKNOWN', 'UNBILLED'],
    ['FAILED', 'ACCEPTED', 'UNKNOWN'],
    ['AMBIGUOUS', 'ACCEPTED', 'UNBILLED'],
  ] as const)(
    'opens an operator case for incompatible EXPIRED facts %s/%s/%s',
    async (state, acceptance, billing) => {
      const initial = staleTask({ status: 'EXPIRED', routingFailoverAuthorized: false });
      const { job, repository, wallet, asset } = harness(initial, {
        state,
        acceptance,
        billing,
        ...(state === 'SUCCEEDED'
          ? { resultUrls: ['https://result.invalid/expired-contradiction.mp4'] }
          : {}),
      });

      await expect(job.run()).resolves.toMatchObject({ operatorRequired: 1, repaired: 0 });
      expect(repository.writes.at(-1)?.operatorCase?.kind).toMatch(
        /EXPIRED|AMBIGUOUS|CONTRADICTION/,
      );
      expect(wallet.release).not.toHaveBeenCalled();
      expect(wallet.settle).not.toHaveBeenCalled();
      expect(asset.requestImport).not.toHaveBeenCalled();
      expect(repository.current.status).toBe('EXPIRED');
    },
  );

  it.each([
    [
      'durable provider acceptance',
      { providerAccepted: true },
      'EXPIRED_LOCAL_PROVIDER_FACT_CONTRADICTION',
    ],
    ['durable accepted/running rank', { providerStateRank: 1 }, 'PROVIDER_FACT_CONTRADICTION'],
    ['durable succeeded rank', { providerStateRank: 3 }, 'PROVIDER_FACT_CONTRADICTION'],
  ] as const)(
    'blocks EXPIRED refund when %s contradicts a terminal inspection',
    async (_label, localFacts, expectedCase) => {
      const initial = staleTask({
        status: 'EXPIRED',
        routingFailoverAuthorized: false,
        ...localFacts,
      });
      const { job, repository, wallet } = harness(initial, {
        state: 'FAILED',
        acceptance: 'ACCEPTED',
        billing: 'UNBILLED',
      });

      await expect(job.run()).resolves.toMatchObject({ operatorRequired: 1, repaired: 0 });
      expect(repository.writes.at(-1)?.operatorCase?.kind).toBe(expectedCase);
      expect(wallet.release).not.toHaveBeenCalled();
    },
  );

  it('requires a persisted canonical EXPIRED release plan when provider identity is missing', async () => {
    const missing = harness(
      staleTask({
        status: 'EXPIRED',
        providerTaskId: null,
        executionId: null,
        routingFailoverAuthorized: false,
      }),
      { state: 'AMBIGUOUS', acceptance: 'UNKNOWN', billing: 'UNKNOWN' },
    );
    await expect(missing.job.run()).resolves.toMatchObject({ operatorRequired: 1 });
    expect(missing.wallet.release).not.toHaveBeenCalled();

    const planned = harness(
      staleTask({
        status: 'EXPIRED',
        providerId: null,
        providerTaskId: null,
        modelCode: null,
        executionId: null,
        routingFailoverAuthorized: false,
        financialDisposition: 'EXPIRED_FULL_RELEASE' as SagaTask['financialDisposition'],
        financialReleaseKey: `task:${TASK_ID}:expired-release`,
      }),
      { state: 'AMBIGUOUS', acceptance: 'UNKNOWN', billing: 'UNKNOWN' },
    );
    await expect(planned.job.run()).resolves.toMatchObject({ repaired: 1 });
    expect(planned.wallet.release).toHaveBeenCalledWith(
      expect.objectContaining({ businessKey: `task:${TASK_ID}:expired-release` }),
    );
    expect(planned.repository.current.status).toBe('REFUNDED');

    for (const contradictoryFacts of [
      { providerAccepted: true },
      { providerStateRank: 1 },
      { providerStateRank: 3 },
    ] as const) {
      const unsafePlanned = harness(
        staleTask({
          status: 'EXPIRED',
          providerId: null,
          providerTaskId: null,
          modelCode: null,
          executionId: null,
          routingFailoverAuthorized: false,
          financialDisposition: 'EXPIRED_FULL_RELEASE',
          financialReleaseKey: `task:${TASK_ID}:expired-release`,
          ...contradictoryFacts,
        }),
        { state: 'AMBIGUOUS', acceptance: 'UNKNOWN', billing: 'UNKNOWN' },
      );
      await expect(unsafePlanned.job.run()).resolves.toMatchObject({ operatorRequired: 1 });
      expect(unsafePlanned.wallet.release).not.toHaveBeenCalled();
    }

    const malformed = harness(
      staleTask({
        status: 'EXPIRED',
        providerId: null,
        providerTaskId: null,
        modelCode: null,
        executionId: null,
        routingFailoverAuthorized: false,
        financialDisposition: 'EXPIRED_FULL_RELEASE' as SagaTask['financialDisposition'],
        financialReleaseKey: `task:${TASK_ID}:wrong-expired-release`,
      }),
      { state: 'AMBIGUOUS', acceptance: 'UNKNOWN', billing: 'UNKNOWN' },
    );
    await expect(malformed.job.run()).resolves.toMatchObject({ operatorRequired: 1 });
    expect(malformed.wallet.release).not.toHaveBeenCalled();

    const orphanKey = harness(
      staleTask({
        status: 'EXPIRED',
        providerId: null,
        providerTaskId: null,
        modelCode: null,
        executionId: null,
        routingFailoverAuthorized: false,
        financialReleaseKey: `task:${TASK_ID}:expired-release`,
      }),
      { state: 'AMBIGUOUS', acceptance: 'UNKNOWN', billing: 'UNKNOWN' },
    );
    await expect(orphanKey.job.run()).resolves.toMatchObject({ operatorRequired: 1 });
    expect(orphanKey.wallet.release).not.toHaveBeenCalled();

    const contradicted = harness(
      staleTask({
        status: 'EXPIRED',
        routingFailoverAuthorized: false,
        financialDisposition: 'EXPIRED_FULL_RELEASE',
        financialReleaseKey: `task:${TASK_ID}:expired-release`,
      }),
      {
        state: 'SUCCEEDED',
        acceptance: 'ACCEPTED',
        billing: 'UNBILLED',
        resultUrls: ['https://result.invalid/expired-late-success.mp4'],
      },
    );
    await expect(contradicted.job.run()).resolves.toMatchObject({ operatorRequired: 1 });
    expect(contradicted.wallet.release).not.toHaveBeenCalled();
  });

  it('replays the canonical EXPIRED release idempotently after a crash following intent persistence', async () => {
    const initial = staleTask({ status: 'EXPIRED', routingFailoverAuthorized: false });
    const first = harness(initial, {
      state: 'FAILED',
      acceptance: 'ACCEPTED',
      billing: 'UNBILLED',
    });
    first.wallet.release.mockRejectedValueOnce(new Error('WALLET_RESPONSE_LOST'));

    await expect(first.job.run()).resolves.toMatchObject({ operatorRequired: 1 });
    expect(first.repository.current).toMatchObject({
      status: 'EXPIRED',
      financialDisposition: 'EXPIRED_FULL_RELEASE',
      financialReleaseKey: `task:${TASK_ID}:expired-release`,
    });

    const second = harness(first.repository.current, {
      state: 'FAILED',
      acceptance: 'ACCEPTED',
      billing: 'UNBILLED',
    });
    await expect(second.job.run()).resolves.toMatchObject({ repaired: 1 });
    expect(first.wallet.release.mock.calls[0]?.[0].businessKey).toBe(
      second.wallet.release.mock.calls[0]?.[0].businessKey,
    );
    expect(second.repository.current.status).toBe('REFUNDED');
  });

  it('isolates one repair error and continues the remaining batch', async () => {
    const secondId = '0198f4d4-21c2-7b7d-8a03-08a0da2a51aa';
    const first = staleTask();
    const second = staleTask({ taskId: secondId });
    const tasks = new Map([
      [first.taskId, first],
      [second.taskId, second],
    ]);
    const taskFor = (taskId: string): SagaTask => {
      const found = tasks.get(taskId);
      if (found === undefined) throw new Error('TEST_TASK_NOT_FOUND');
      return found;
    };
    const repository: ProviderEventRepository = {
      findStale: vi.fn(async () => [first, second]),
      claim: vi.fn(async (input: Parameters<ProviderEventRepository['claim']>[0]) => ({
        kind: 'CLAIMED' as const,
        task: taskFor(input.taskId),
      })),
      renewLease: vi.fn(async () => ({ kind: 'RENEWED' as const })),
      write: vi.fn(async (input: Parameters<ProviderEventRepository['write']>[0]) => ({
        kind: 'APPLIED' as const,
        task: taskFor(input.taskId),
      })),
      getTask: vi.fn(async (taskId: string) => tasks.get(taskId) ?? null),
    };
    const provider: ProviderRuntimeStatusPort = {
      inspect: vi.fn(async (input: Parameters<ProviderRuntimeStatusPort['inspect']>[0]) => {
        if (input.taskId === first.taskId) throw new Error('PROVIDER_INSPECTION_DOWN');
        return boundInspection(second, {
          state: 'RUNNING',
          acceptance: 'ACCEPTED',
          billing: 'UNBILLED',
        });
      }),
    };
    const job = new TaskRepairJob({
      repository,
      provider,
      providerEvents: {
        consume: vi.fn(async () => ({ ack: true, outcome: 'PROGRESSED' as const })),
      },
      wallet: noopWallet(),
      clock: { now: () => NOW },
      ids: { next: () => '0198f4d4-21c2-7b7d-8a03-08a0da2a51fe' },
    });

    await expect(job.run()).resolves.toMatchObject({
      scanned: 2,
      operatorRequired: 1,
      repaired: 1,
    });
    expect(provider.inspect).toHaveBeenCalledTimes(2);
  });
  it('binds inspection to every immutable execution identity field', async () => {
    const initial = staleTask();
    const { job, provider } = harness(initial, {
      state: 'FAILED',
      acceptance: 'ACCEPTED',
      billing: 'BILLED',
    });

    await job.run();

    expect(provider.inspect).toHaveBeenCalledWith({
      taskId: TASK_ID,
      providerId: PROVIDER_ID,
      executionId: EXECUTION_ID,
      providerTaskId: 'provider-task-1',
      routeEpoch: 0,
    });
  });

  it.each([
    ['taskId', '0198f4d4-21c2-7b7d-8a03-08a0da2a51f1'],
    ['providerId', '0198f4d4-21c2-7b7d-8a03-08a0da2a51f2'],
    ['executionId', '0198f4d4-21c2-7b7d-8a03-08a0da2a51f3'],
    ['providerTaskId', 'wrong-provider-task'],
    ['routeEpoch', 7],
  ] as const)(
    'creates an operator case when inspection echoes a different %s',
    async (field, mismatched) => {
      const { job, repository, wallet } = harness(staleTask(), {
        [field]: mismatched,
        state: 'FAILED',
        acceptance: 'ACCEPTED',
        billing: 'BILLED',
      });

      await expect(job.run()).resolves.toMatchObject({ operatorRequired: 1, repaired: 0 });
      expect(repository.writes.at(-1)?.operatorCase?.kind).toBe(
        'PROVIDER_INSPECTION_IDENTITY_MISMATCH',
      );
      expect(wallet.release).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['PROVIDER_CANCELED_FULL_RELEASE', 'PROVIDER_CANCELED'],
    ['PRE_ACCEPTANCE_FULL_RELEASE', 'CANCELED_BEFORE_PROVIDER_ACCEPTANCE'],
  ] as const)(
    'replays canonical %s without provider identity',
    async (financialDisposition, reason) => {
      const initial = staleTask({
        status: 'CANCELED',
        version: 5,
        providerId: null,
        providerTaskId: null,
        executionId: null,
        financialDisposition,
        financialReleaseKey: `task:${TASK_ID}:cancel-release`,
      });
      const { job, wallet, repository, provider } = harness(initial, {
        state: 'AMBIGUOUS',
        acceptance: 'UNKNOWN',
        billing: 'UNKNOWN',
      });

      await expect(job.run()).resolves.toMatchObject({ repaired: 1 });
      expect(provider.inspect).not.toHaveBeenCalled();
      expect(wallet.release).toHaveBeenCalledWith(expect.objectContaining({ reason }));
      expect(repository.current.status).toBe('REFUNDED');
    },
  );

  it.each([
    ['0', 'REFUNDED', 0, 1],
    ['600', 'SETTLED', 1, 1],
    ['1200', 'SETTLED', 1, 0],
  ] as const)(
    'replays user-cancel charge %s with its exact settle/release disposition',
    async (charge, target, settles, releases) => {
      const initial = staleTask({
        status: 'CANCELED',
        version: 5,
        providerId: null,
        providerTaskId: null,
        executionId: null,
        financialDisposition: 'USER_CANCEL_RULE',
        cancellationChargePoints: charge,
        financialSettlementKey: `task:${TASK_ID}:settle`,
        financialReleaseKey: `task:${TASK_ID}:quote-difference-release`,
      });
      const { job, wallet, repository } = harness(initial, {
        state: 'AMBIGUOUS',
        acceptance: 'UNKNOWN',
        billing: 'UNKNOWN',
      });

      await expect(job.run()).resolves.toMatchObject({ repaired: 1 });
      expect(wallet.settle).toHaveBeenCalledTimes(settles);
      expect(wallet.release).toHaveBeenCalledTimes(releases);
      expect(repository.current.status).toBe(target);
      if (target === 'SETTLED') expect(repository.current.settlementPoints).toBe(charge);
    },
  );

  it('converges a durable successful asset settlement after its message is lost', async () => {
    const initial = staleTask({
      status: 'SUCCEEDED',
      version: 6,
      providerId: null,
      providerTaskId: null,
      executionId: null,
      quotedPoints: '1200',
      settlementPoints: '900',
      assetImportRequested: true,
      assetImportDispatched: true,
      assetId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c9',
      financialDisposition: 'SUCCESS_SETTLEMENT',
      financialSettlementKey: `task:${TASK_ID}:settle`,
      financialReleaseKey: `task:${TASK_ID}:quote-difference-release`,
    });
    const { job, wallet, repository, provider } = harness(initial, {
      state: 'AMBIGUOUS',
      acceptance: 'UNKNOWN',
      billing: 'UNKNOWN',
    });

    await expect(job.run()).resolves.toMatchObject({ repaired: 1, operatorRequired: 0 });
    expect(provider.inspect).not.toHaveBeenCalled();
    expect(wallet.settle).toHaveBeenCalledWith(
      expect.objectContaining({ businessKey: `task:${TASK_ID}:settle`, points: '900' }),
    );
    expect(wallet.release).toHaveBeenCalledWith(
      expect.objectContaining({
        businessKey: `task:${TASK_ID}:quote-difference-release`,
        points: '300',
      }),
    );
    expect(repository.current.status).toBe('SETTLED');
  });

  it.each([
    ['SUCCEEDED', 'FAILED'],
    ['SUCCEEDED', 'RUNNING'],
    ['FAILED', 'SUCCEEDED'],
    ['FAILED', 'CANCELED'],
    ['CANCELED', 'RUNNING'],
    ['CANCELED', 'FAILED'],
  ] as const)(
    'blocks incompatible local terminal %s versus inspected %s',
    async (localStatus, inspectedState) => {
      const initial = staleTask({
        status: localStatus,
        version: 6,
        financialDisposition: null,
      });
      const { job, repository, wallet, asset } = harness(initial, {
        state: inspectedState,
        acceptance: inspectedState === 'RUNNING' ? 'ACCEPTED' : 'ACCEPTED',
        billing: inspectedState === 'RUNNING' ? 'UNBILLED' : 'BILLED',
        ...(inspectedState === 'SUCCEEDED'
          ? { resultUrls: ['https://result.invalid/contradiction.mp4'] }
          : {}),
      });

      await expect(job.run()).resolves.toMatchObject({ operatorRequired: 1, repaired: 0 });
      expect(repository.writes.at(-1)?.operatorCase?.kind).toBe(
        'LOCAL_TERMINAL_PROVIDER_STATE_CONTRADICTION',
      );
      expect(wallet.release).not.toHaveBeenCalled();
      expect(wallet.settle).not.toHaveBeenCalled();
      expect(asset.requestImport).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'succeeded missing durable asset',
      {
        status: 'SUCCEEDED',
        financialDisposition: 'SUCCESS_SETTLEMENT',
        financialSettlementKey: `task:${TASK_ID}:settle`,
        financialReleaseKey: `task:${TASK_ID}:release`,
      },
    ],
    [
      'succeeded settlement exceeds quote',
      {
        status: 'SUCCEEDED',
        assetId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51ad',
        settlementPoints: '1201',
        financialDisposition: 'SUCCESS_SETTLEMENT',
        financialSettlementKey: `task:${TASK_ID}:settle`,
        financialReleaseKey: `task:${TASK_ID}:release`,
      },
    ],
    ['failed wrong disposition', { status: 'FAILED', financialDisposition: 'SUCCESS_SETTLEMENT' }],
    [
      'failed missing release key',
      { status: 'FAILED', financialDisposition: 'PROVIDER_FAILED_FULL_RELEASE' },
    ],
    [
      'canceled missing release key',
      { status: 'CANCELED', financialDisposition: 'PROVIDER_CANCELED_FULL_RELEASE' },
    ],
    [
      'canceled wrong disposition',
      { status: 'CANCELED', financialDisposition: 'SUCCESS_SETTLEMENT' },
    ],
    [
      'user cancel missing charge',
      {
        status: 'CANCELED',
        financialDisposition: 'USER_CANCEL_RULE',
        financialSettlementKey: `task:${TASK_ID}:settle`,
        financialReleaseKey: `task:${TASK_ID}:release`,
      },
    ],
    [
      'user cancel missing settlement key',
      {
        status: 'CANCELED',
        financialDisposition: 'USER_CANCEL_RULE',
        cancellationChargePoints: '600',
        financialReleaseKey: `task:${TASK_ID}:release`,
      },
    ],
    [
      'user cancel missing release key',
      {
        status: 'CANCELED',
        financialDisposition: 'USER_CANCEL_RULE',
        cancellationChargePoints: '600',
        financialSettlementKey: `task:${TASK_ID}:settle`,
      },
    ],
    [
      'user cancel exceeds quote',
      {
        status: 'CANCELED',
        financialDisposition: 'USER_CANCEL_RULE',
        cancellationChargePoints: '1201',
        financialSettlementKey: `task:${TASK_ID}:settle`,
        financialReleaseKey: `task:${TASK_ID}:release`,
      },
    ],
    [
      'user cancel has invalid points',
      {
        status: 'CANCELED',
        financialDisposition: 'USER_CANCEL_RULE',
        cancellationChargePoints: '01',
        financialSettlementKey: `task:${TASK_ID}:settle`,
        financialReleaseKey: `task:${TASK_ID}:release`,
      },
    ],
  ] as const)('opens an operator case for malformed %s', async (_label, overrides) => {
    const initial = staleTask({
      version: 5,
      providerId: null,
      providerTaskId: null,
      executionId: null,
      ...overrides,
    } as Partial<SagaTask>);
    const { job, wallet, repository } = harness(initial, {
      state: 'FAILED',
      acceptance: 'UNKNOWN',
      billing: 'UNKNOWN',
    });

    await expect(job.run()).resolves.toMatchObject({ operatorRequired: 1, repaired: 0 });
    expect(repository.writes.at(-1)?.operatorCase?.kind).toBe(
      'PENDING_FINANCIAL_DISPOSITION_INVALID',
    );
    expect(wallet.release).not.toHaveBeenCalled();
    expect(wallet.settle).not.toHaveBeenCalled();
  });

  it('makes safe failover reachable from a production ambiguous submission sequence', async () => {
    const initial = staleTask({
      status: 'QUEUED',
      version: 2,
      providerId: null,
      providerTaskId: null,
      modelCode: null,
      executionId: null,
    });
    const { consumer, job, repository } = harness(initial, {
      taskId: TASK_ID,
      providerId: PROVIDER_ID,
      executionId: EXECUTION_ID,
      providerTaskId: 'provider-task-1',
      routeEpoch: 0,
      state: 'FAILED',
      acceptance: 'UNACCEPTED',
      billing: 'UNBILLED',
    });
    const ambiguous = {
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c0',
      type: 'provider.execution-ambiguous.v1',
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
        routeEpoch: 0,
        status: 'AMBIGUOUS',
        errorCode: 'PROVIDER_TIMEOUT',
        repairRequired: true,
      },
    };

    await expect(consumer.consume(ambiguous)).resolves.toMatchObject({
      ack: true,
      outcome: 'OPERATOR_REQUIRED',
    });
    expect(repository.current).toMatchObject({ status: 'SUBMITTING', providerAccepted: false });

    await expect(job.run()).resolves.toMatchObject({ failedOver: 1 });
    expect(repository.current).toMatchObject({ status: 'QUEUED', routeEpoch: 1 });
    expect(repository.writes.at(-1)?.outbox).toMatchObject({
      eventType: 'generation.task-queued.v1',
      payload: {
        taskId: TASK_ID,
        routeEpoch: 1,
        failoverAuthorized: true,
        originalConfirmedUnaccepted: true,
        originalConfirmedUnbilled: true,
        priorExecutionId: EXECUTION_ID,
        authorizedProviderId: SUBSTITUTE_ID,
        authorizedModelCode: 'mock-video-v2',
      },
    });
  });

  it('replays a durable failed-task release without a provider task identifier', async () => {
    const initial = staleTask({
      status: 'FAILED',
      version: 5,
      providerTaskId: null,
      financialDisposition: 'PROVIDER_FAILED_FULL_RELEASE',
      financialReleaseKey: `task:${TASK_ID}:provider-failure-release`,
    });
    const { job, wallet, repository, provider } = harness(initial, {
      state: 'AMBIGUOUS',
      acceptance: 'UNKNOWN',
      billing: 'UNKNOWN',
    });

    await expect(job.run()).resolves.toMatchObject({ repaired: 1, operatorRequired: 0 });
    expect(provider.inspect).not.toHaveBeenCalled();
    expect(wallet.release).toHaveBeenCalledWith(
      expect.objectContaining({
        businessKey: `task:${TASK_ID}:provider-failure-release`,
        points: '1200',
      }),
    );
    expect(repository.current.status).toBe('REFUNDED');
  });

  it('does not replay a financial effect when its repair delivery is already complete', async () => {
    const initial = staleTask({
      status: 'FAILED',
      version: 5,
      providerTaskId: null,
      financialDisposition: 'PROVIDER_FAILED_FULL_RELEASE',
      financialReleaseKey: `task:${TASK_ID}:provider-failure-release`,
    });
    const { job, wallet, repository } = harness(initial, {
      state: 'AMBIGUOUS',
      acceptance: 'UNKNOWN',
      billing: 'UNKNOWN',
    });
    vi.spyOn(repository, 'claim').mockResolvedValueOnce({ kind: 'DUPLICATE_COMPLETE' });

    await expect(job.run()).resolves.toMatchObject({ unchanged: 1, repaired: 0 });
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it('does not let a pending repair owner replay a financial effect', async () => {
    const initial = staleTask({
      status: 'FAILED',
      version: 5,
      providerTaskId: null,
      financialDisposition: 'PROVIDER_FAILED_FULL_RELEASE',
      financialReleaseKey: `task:${TASK_ID}:provider-failure-release`,
    });
    const { job, wallet, repository } = harness(initial, {
      state: 'AMBIGUOUS',
      acceptance: 'UNKNOWN',
      billing: 'UNKNOWN',
    });
    vi.spyOn(repository as ProviderEventRepository, 'claim').mockResolvedValueOnce({
      kind: 'DUPLICATE_PENDING',
      task: initial,
    });

    await expect(job.run()).resolves.toMatchObject({ unchanged: 1, repaired: 0 });
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it('counts financial convergence fencing as unchanged after an idempotent effect', async () => {
    const initial = staleTask({
      status: 'FAILED',
      version: 5,
      providerTaskId: null,
      financialDisposition: 'PROVIDER_FAILED_FULL_RELEASE',
      financialReleaseKey: `task:${TASK_ID}:provider-failure-release`,
    });
    const { job, wallet, repository } = harness(initial, {
      state: 'AMBIGUOUS',
      acceptance: 'UNKNOWN',
      billing: 'UNKNOWN',
    });
    vi.spyOn(repository, 'write').mockResolvedValueOnce({ kind: 'STALE' });

    await expect(job.run()).resolves.toMatchObject({ unchanged: 1, repaired: 0 });
    expect(wallet.release).toHaveBeenCalledTimes(1);
  });

  it('blocks pending failure compensation when inspection reports provider success', async () => {
    const initial = staleTask({
      status: 'FAILED',
      version: 5,
      financialDisposition: 'PROVIDER_FAILED_FULL_RELEASE',
      financialReleaseKey: `task:${TASK_ID}:provider-failure-release`,
    });
    const { job, wallet, repository } = harness(initial, {
      state: 'SUCCEEDED',
      acceptance: 'ACCEPTED',
      billing: 'BILLED',
      resultUrls: ['https://result.invalid/contradiction.mp4'],
    });

    await expect(job.run()).resolves.toMatchObject({ operatorRequired: 1, repaired: 0 });
    expect(repository.writes.at(-1)?.operatorCase?.kind).toBe(
      'LOCAL_TERMINAL_PROVIDER_STATE_CONTRADICTION',
    );
    expect(wallet.release).not.toHaveBeenCalled();
  });
  it('requires local failover safety facts in addition to provider inspection', () => {
    expect(isSafeFailoverAuthorized(staleTask({ providerAccepted: true }))).toBe(false);
    expect(isSafeFailoverAuthorized(staleTask({ status: 'RUNNING' }))).toBe(false);
    expect(
      isSafeFailoverAuthorized(
        staleTask({
          substitute: {
            providerId: PROVIDER_ID,
            modelCode: 'same-provider-model-v2',
            capabilityVersionId: CAPABILITY_ID,
            pricePoints: '900',
          },
        }),
      ),
    ).toBe(false);
    expect(
      isSafeFailoverAuthorized({
        ...staleTask(),
        financialDisposition: 'PROVIDER_FAILED_FULL_RELEASE',
      } as SagaTask),
    ).toBe(false);
  });

  it('treats provider/local acceptance contradictions as an operator case', async () => {
    const { job, repository } = harness(staleTask({ providerAccepted: true }), {
      state: 'FAILED',
      acceptance: 'UNACCEPTED',
      billing: 'UNBILLED',
    });

    await expect(job.run()).resolves.toMatchObject({ operatorRequired: 1, failedOver: 0 });
    expect(repository.writes.at(-1)?.operatorCase?.kind).toBe('PROVIDER_FACT_CONTRADICTION');
  });

  it('treats billed-but-unaccepted provider facts as contradictory and never refunds', async () => {
    const { job, repository, wallet } = harness(staleTask(), {
      state: 'FAILED',
      acceptance: 'UNACCEPTED',
      billing: 'BILLED',
    });

    await expect(job.run()).resolves.toMatchObject({ operatorRequired: 1, repaired: 0 });
    expect(repository.writes.at(-1)?.operatorCase?.kind).toBe('PROVIDER_FACT_CONTRADICTION');
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it.each(['ACCEPTED', 'RUNNING', 'SUCCEEDED'] as const)(
    'treats provider state %s with UNACCEPTED evidence as contradictory',
    async (state) => {
      const { job, repository } = harness(staleTask(), {
        state,
        acceptance: 'UNACCEPTED',
        billing: 'UNBILLED',
        ...(state === 'SUCCEEDED' ? { resultUrls: ['https://result.invalid/video.mp4'] } : {}),
      });

      await expect(job.run()).resolves.toMatchObject({ operatorRequired: 1, failedOver: 0 });
      expect(repository.writes.at(-1)?.operatorCase?.kind).toBe('PROVIDER_FACT_CONTRADICTION');
    },
  );

  it('counts repair only when the shared provider-event Saga ACKs', async () => {
    const initial = staleTask();
    const repository = new RepairRepository(initial);
    const provider: ProviderRuntimeStatusPort = {
      inspect: vi.fn(async () =>
        boundInspection(initial, {
          state: 'FAILED' as const,
          acceptance: 'ACCEPTED' as const,
          billing: 'BILLED' as const,
        }),
      ),
    };
    const job = new TaskRepairJob({
      repository,
      provider,
      providerEvents: {
        consume: vi.fn(async () => ({ ack: false, outcome: 'RETRY' as const })),
      },
      wallet: noopWallet(),
      clock: { now: () => NOW },
      ids: { next: () => '0198f4d4-21c2-7b7d-8a03-08a0da2a51fa' },
    });

    await expect(job.run()).resolves.toMatchObject({ repaired: 0, unchanged: 1 });
  });

  it.each([
    [
      'SUCCEEDED',
      {
        state: 'SUCCEEDED' as const,
        acceptance: 'ACCEPTED' as const,
        billing: 'BILLED' as const,
        resultUrls: ['https://result.invalid/video.mp4'],
      },
    ],
    [
      'RUNNING',
      {
        state: 'RUNNING' as const,
        acceptance: 'ACCEPTED' as const,
        billing: 'UNBILLED' as const,
      },
    ],
  ])('counts a NACKed %s inspection as unchanged', async (_label, inspection) => {
    const initial = staleTask();
    const repository = new RepairRepository(initial);
    const job = new TaskRepairJob({
      repository,
      provider: { inspect: vi.fn(async () => boundInspection(initial, inspection)) },
      providerEvents: {
        consume: vi.fn(async () => ({ ack: false, outcome: 'RETRY' as const })),
      },
      wallet: noopWallet(),
      clock: { now: () => NOW },
      ids: { next: () => '0198f4d4-21c2-7b7d-8a03-08a0da2a51fb' },
    });

    await expect(job.run()).resolves.toMatchObject({ repaired: 0, unchanged: 1 });
  });

  it('fails closed when a nonterminal inspection cannot bind to an execution identity', async () => {
    const { job } = harness(staleTask({ executionId: null }), {
      state: 'RUNNING',
      acceptance: 'ACCEPTED',
      billing: 'UNBILLED',
    });

    await expect(job.run()).resolves.toMatchObject({ operatorRequired: 1 });
  });

  it.each(['ACCEPTED', 'RUNNING'] as const)(
    'repairs inspected %s into a durable task state transition',
    async (state) => {
      const { job, repository } = harness(staleTask(), {
        state,
        acceptance: 'ACCEPTED',
        billing: 'UNBILLED',
      });

      await expect(job.run()).resolves.toMatchObject({ repaired: 1 });
      expect(repository.current.status).toBe('RUNNING');
      expect(repository.current.version).toBeGreaterThan(3);
    },
  );

  it('requeues an authorized failover with a new route epoch and real task version', async () => {
    const initial = {
      ...staleTask(),
      routeEpoch: 0,
      executionId: EXECUTION_ID,
      assetImportDispatched: false,
      cancelRequested: false,
      financialDisposition: null,
      financialSettlementKey: null,
      financialReleaseKey: null,
    } as SagaTask;
    const { job, repository } = harness(initial, {
      state: 'FAILED',
      acceptance: 'UNACCEPTED',
      billing: 'UNBILLED',
    });

    await expect(job.run()).resolves.toMatchObject({ failedOver: 1 });
    expect(repository.current).toMatchObject({ status: 'QUEUED', version: 4, routeEpoch: 1 });
    expect(repository.writes.at(-1)?.outbox?.payload).toMatchObject({
      taskVersion: 4,
      routeEpoch: 1,
      failoverAuthorized: true,
      originalConfirmedUnaccepted: true,
      originalConfirmedUnbilled: true,
      priorExecutionId: EXECUTION_ID,
      authorizedProviderId: SUBSTITUTE_ID,
      authorizedModelCode: 'mock-video-v2',
    });
  });

  it('evaluates every stored safe-failover predicate and validates canonical prices', () => {
    expect(isSafeFailoverAuthorized(staleTask())).toBe(true);
    expect(isSafeFailoverAuthorized(staleTask({ routingFailoverAuthorized: false }))).toBe(false);
    expect(isSafeFailoverAuthorized(staleTask({ substitute: null }))).toBe(false);
    expect(
      isSafeFailoverAuthorized(
        staleTask({
          substitute: {
            providerId: SUBSTITUTE_ID,
            modelCode: 'mock-video-v2',
            capabilityVersionId: `${CAPABILITY_ID}-different`,
            pricePoints: '900',
          },
        }),
      ),
    ).toBe(false);
    expect(
      isSafeFailoverAuthorized(
        staleTask({
          substitute: {
            providerId: SUBSTITUTE_ID,
            modelCode: 'mock-video-v2',
            capabilityVersionId: CAPABILITY_ID,
            pricePoints: '1201',
          },
        }),
      ),
    ).toBe(false);
    expect(() =>
      isSafeFailoverAuthorized(
        staleTask({
          substitute: {
            providerId: SUBSTITUTE_ID,
            modelCode: 'mock-video-v2',
            capabilityVersionId: CAPABILITY_ID,
            pricePoints: '01',
          },
        }),
      ),
    ).toThrow('INVALID_POINTS');
  });

  it('validates batch and status-specific deadline configuration', () => {
    const base = harness(staleTask(), {
      state: 'RUNNING',
      acceptance: 'ACCEPTED',
      billing: 'UNBILLED',
    });
    expect(
      () =>
        new TaskRepairJob({
          repository: base.repository,
          provider: base.provider,
          providerEvents: { consume: vi.fn() },
          wallet: base.wallet,
          clock: { now: () => NOW },
          ids: { next: () => TASK_ID },
          batchSize: 0,
        }),
    ).toThrow('INVALID_REPAIR_BATCH_SIZE');
    expect(
      () =>
        new TaskRepairJob({
          repository: base.repository,
          provider: base.provider,
          providerEvents: { consume: vi.fn() },
          wallet: base.wallet,
          clock: { now: () => NOW },
          ids: { next: () => TASK_ID },
          deadlinesMs: { RUNNING: 0 },
        }),
    ).toThrow('INVALID_REPAIR_DEADLINE');
  });

  it('creates an operator case without querying when providerTaskId is missing', async () => {
    const { job, repository, provider } = harness(staleTask({ providerTaskId: null }), {
      state: 'AMBIGUOUS',
      acceptance: 'UNKNOWN',
      billing: 'UNKNOWN',
    });

    await expect(job.run()).resolves.toMatchObject({ scanned: 1, operatorRequired: 1 });

    expect(provider.inspect).not.toHaveBeenCalled();
    expect(repository.writes.at(-1)?.operatorCase?.kind).toBe('PROVIDER_TASK_ID_MISSING');
    expect(repository.writes.at(-1)?.outbox).toBeUndefined();
  });

  it('schedules failover only after unaccepted and unbilled are both confirmed', async () => {
    const { job, repository } = harness(staleTask(), {
      state: 'FAILED',
      acceptance: 'UNACCEPTED',
      billing: 'UNBILLED',
    });

    await expect(job.run()).resolves.toMatchObject({ scanned: 1, failedOver: 1 });

    expect(repository.writes.at(-1)).toMatchObject({
      patch: {
        providerAccepted: false,
        providerTaskId: null,
        providerId: SUBSTITUTE_ID,
        modelCode: 'mock-video-v2',
        settlementPoints: '900',
      },
      outbox: {
        eventType: 'generation.task-queued.v1',
        deduplicationKey: `task:${TASK_ID}:failover:v3`,
      },
    });
  });

  it('counts an already-completed safe-failover repair claim as unchanged', async () => {
    const { job, repository } = harness(staleTask(), {
      state: 'FAILED',
      acceptance: 'UNACCEPTED',
      billing: 'UNBILLED',
    });
    vi.spyOn(repository, 'claim').mockResolvedValueOnce({ kind: 'DUPLICATE_COMPLETE' });

    await expect(job.run()).resolves.toMatchObject({ failedOver: 0, unchanged: 1 });
    expect(repository.writes).toHaveLength(0);
  });

  it('counts safe-failover fencing as unchanged without aborting the batch', async () => {
    const { job, repository } = harness(staleTask(), {
      state: 'FAILED',
      acceptance: 'UNACCEPTED',
      billing: 'UNBILLED',
    });
    vi.spyOn(repository, 'write').mockResolvedValueOnce({ kind: 'STALE' });

    await expect(job.run()).resolves.toMatchObject({ failedOver: 0, unchanged: 1 });
  });

  it.each([
    ['routing authorization is false', { routingFailoverAuthorized: false }],
    [
      'capability version differs',
      {
        substitute: {
          providerId: SUBSTITUTE_ID,
          modelCode: 'mock-video-v2',
          capabilityVersionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51ff',
          pricePoints: '900',
        },
      },
    ],
    [
      'substitute exceeds quote',
      {
        substitute: {
          providerId: SUBSTITUTE_ID,
          modelCode: 'mock-video-v2',
          capabilityVersionId: CAPABILITY_ID,
          pricePoints: '1201',
        },
      },
    ],
  ])('does not switch when %s', async (_label, override) => {
    const { job, repository } = harness(staleTask(override), {
      state: 'FAILED',
      acceptance: 'UNACCEPTED',
      billing: 'UNBILLED',
    });

    await expect(job.run()).resolves.toMatchObject({ operatorRequired: 1, failedOver: 0 });

    expect(repository.writes.at(-1)?.operatorCase?.kind).toBe('FAILOVER_NOT_SAFE');
    expect(repository.writes.at(-1)?.outbox).toBeUndefined();
  });

  it.each([
    ['UNKNOWN', 'UNBILLED'],
    ['UNACCEPTED', 'UNKNOWN'],
    ['ACCEPTED', 'UNBILLED'],
    ['UNACCEPTED', 'BILLED'],
  ] as const)(
    'does not refund or switch when acceptance=%s and billing=%s',
    async (acceptance, billing) => {
      const { job, repository, wallet } = harness(staleTask(), {
        state: 'AMBIGUOUS',
        acceptance,
        billing,
      });

      await expect(job.run()).resolves.toMatchObject({ operatorRequired: 1, failedOver: 0 });

      expect(repository.writes.at(-1)?.operatorCase?.kind).toBe(
        'PROVIDER_ACCEPTANCE_OR_BILLING_AMBIGUOUS',
      );
      expect(repository.writes.at(-1)?.outbox).toBeUndefined();
      expect(wallet.release).not.toHaveBeenCalled();
    },
  );

  it('repairs a confirmed provider success through the same asset-import Saga', async () => {
    const { job, asset, wallet, repository } = harness(staleTask(), {
      state: 'SUCCEEDED',
      acceptance: 'ACCEPTED',
      billing: 'BILLED',
      resultUrls: ['https://result.invalid/repaired.mp4'],
    });

    await expect(job.run()).resolves.toMatchObject({ repaired: 1 });

    expect(asset.requestImport).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: TASK_ID,
        resultUrls: ['https://result.invalid/repaired.mp4'],
        businessKey: `task:${TASK_ID}:asset-import`,
      }),
    );
    expect(wallet.settle).not.toHaveBeenCalled();
    expect(repository.current.status).toBe('SUCCEEDED');
  });

  it('creates an operator case when provider success has no result URL', async () => {
    const { job, repository, asset } = harness(staleTask(), {
      state: 'SUCCEEDED',
      acceptance: 'ACCEPTED',
      billing: 'BILLED',
    });

    await expect(job.run()).resolves.toMatchObject({ operatorRequired: 1, repaired: 0 });

    expect(repository.writes.at(-1)?.operatorCase?.kind).toBe('PROVIDER_SUCCESS_RESULT_MISSING');
    expect(asset.requestImport).not.toHaveBeenCalled();
  });

  it.each(['FAILED', 'CANCELED'] as const)(
    'repairs a confirmed provider %s through the terminal refund Saga',
    async (state) => {
      const { job, wallet, repository } = harness(staleTask(), {
        state,
        acceptance: 'ACCEPTED',
        billing: 'BILLED',
        errorCode: `PROVIDER_${state}`,
      });

      await expect(job.run()).resolves.toMatchObject({ repaired: 1 });

      expect(wallet.release).toHaveBeenCalledWith(
        expect.objectContaining({ businessKey: `task:${TASK_ID}:provider-failure-release` }),
      );
      expect(repository.current.status).toBe('REFUNDED');
    },
  );

  it.each(['ACCEPTED', 'RUNNING'] as const)(
    'touches a still-%s task without financial effects',
    async (state) => {
      const { job, repository, wallet } = harness(staleTask(), {
        state,
        acceptance: 'ACCEPTED',
        billing: 'UNBILLED',
      });

      await expect(job.run()).resolves.toMatchObject({ repaired: 1 });

      expect(repository.current.providerAccepted).toBe(true);
      expect(repository.current.providerStateRank).toBe(state === 'RUNNING' ? 2 : 1);
      expect(wallet.release).not.toHaveBeenCalled();
    },
  );

  it('treats an already-completed observation repair claim as idempotent', async () => {
    const { job, repository } = harness(staleTask(), {
      state: 'RUNNING',
      acceptance: 'ACCEPTED',
      billing: 'UNBILLED',
    });
    vi.spyOn(repository, 'claim').mockResolvedValueOnce({ kind: 'DUPLICATE_COMPLETE' });

    await expect(job.run()).resolves.toMatchObject({ repaired: 0, unchanged: 1 });
    expect(repository.writes).toHaveLength(0);
  });

  it.each([
    ['DUPLICATE_COMPLETE', 'unchanged'],
    ['STALE_PROVIDER_EVENT', 'unchanged'],
    ['OPERATOR_REQUIRED', 'operatorRequired'],
  ] as const)('classifies ACK outcome %s as %s rather than repaired', async (outcome, counter) => {
    const initial = staleTask();
    const repository = new RepairRepository(initial);
    const job = new TaskRepairJob({
      repository,
      provider: {
        inspect: vi.fn(async () =>
          boundInspection(initial, {
            state: 'RUNNING' as const,
            acceptance: 'ACCEPTED' as const,
            billing: 'UNBILLED' as const,
          }),
        ),
      },
      providerEvents: { consume: vi.fn(async () => ({ ack: true, outcome })) },
      wallet: noopWallet(),
      clock: { now: () => NOW },
      ids: { next: () => '0198f4d4-21c2-7b7d-8a03-08a0da2a51fd' },
    });

    await expect(job.run()).resolves.toMatchObject({ repaired: 0, [counter]: 1 });
  });

  it('isolates an observation write failure as an operator outcome', async () => {
    const { job, repository } = harness(staleTask(), {
      state: 'ACCEPTED',
      acceptance: 'ACCEPTED',
      billing: 'UNBILLED',
    });
    vi.spyOn(repository, 'write').mockResolvedValueOnce({ kind: 'STALE' });

    await expect(job.run()).resolves.toMatchObject({ operatorRequired: 1 });
  });

  it('creates an operator case when a terminal provider identity is missing', async () => {
    const { job, repository, asset } = harness(staleTask({ providerId: null }), {
      state: 'SUCCEEDED',
      acceptance: 'ACCEPTED',
      billing: 'BILLED',
      resultUrls: ['https://result.invalid/video.mp4'],
    });

    await expect(job.run()).resolves.toMatchObject({ operatorRequired: 1 });

    expect(repository.writes.at(-1)?.operatorCase?.kind).toBe('PROVIDER_IDENTITY_MISSING');
    expect(asset.requestImport).not.toHaveBeenCalled();
  });

  it.each(['FAILED', 'CANCELED'] as const)(
    'creates an operator case when a %s repair is missing provider identity',
    async (state) => {
      const { job, repository, wallet } = harness(staleTask({ modelCode: null }), {
        state,
        acceptance: 'ACCEPTED',
        billing: 'BILLED',
      });

      await expect(job.run()).resolves.toMatchObject({ operatorRequired: 1 });
      expect(repository.writes.at(-1)?.operatorCase?.kind).toBe('PROVIDER_IDENTITY_MISSING');
      expect(wallet.release).not.toHaveBeenCalled();
    },
  );

  it('counts an already-completed repair claim as unchanged', async () => {
    const { job, repository } = harness(staleTask({ providerTaskId: null }), {
      state: 'AMBIGUOUS',
      acceptance: 'UNKNOWN',
      billing: 'UNKNOWN',
    });
    vi.spyOn(repository, 'claim').mockResolvedValueOnce({ kind: 'DUPLICATE_COMPLETE' });

    await expect(job.run()).resolves.toMatchObject({ operatorRequired: 0, unchanged: 1 });
    expect(repository.writes).toHaveLength(0);
  });

  it('isolates invalid claims and later optimistic fencing without aborting the batch', async () => {
    const claimLost = harness(staleTask({ providerTaskId: null }), {
      state: 'AMBIGUOUS',
      acceptance: 'UNKNOWN',
      billing: 'UNKNOWN',
    });
    vi.spyOn(claimLost.repository as ProviderEventRepository, 'claim').mockResolvedValueOnce({
      kind: 'PAYLOAD_CONFLICT',
    });
    await expect(claimLost.job.run()).resolves.toMatchObject({ unchanged: 1 });

    const missingTask = harness(staleTask({ providerTaskId: null }), {
      state: 'AMBIGUOUS',
      acceptance: 'UNKNOWN',
      billing: 'UNKNOWN',
    });
    vi.spyOn(missingTask.repository as ProviderEventRepository, 'claim').mockResolvedValueOnce({
      kind: 'TASK_NOT_FOUND',
    });
    await expect(missingTask.job.run()).resolves.toMatchObject({ unchanged: 1 });

    const fenced = harness(staleTask({ providerTaskId: null }), {
      state: 'AMBIGUOUS',
      acceptance: 'UNKNOWN',
      billing: 'UNKNOWN',
    });
    vi.spyOn(fenced.repository, 'write').mockResolvedValueOnce({ kind: 'STALE' });
    await expect(fenced.job.run()).resolves.toMatchObject({ unchanged: 1 });
  });
});
