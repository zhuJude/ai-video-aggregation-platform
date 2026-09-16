/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from 'vitest';
import {
  PollingConsumer,
  ProviderPollingService,
  type ClaimPollInput,
  type CompletePollInput,
  type DeferPollInput,
  type PollRepository,
  type ProviderCircuitGate,
} from '../src/index.js';

const TASK_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2';
const EXECUTION_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0';
const PROVIDER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a7';
const DUE = new Date('2026-08-31T12:02:00.000Z');

function pollEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c0',
    type: 'provider.execution-poll-due.v1',
    version: 1,
    occurredAt: '2026-08-31T12:00:00.000Z',
    traceId: '0123456789abcdef0123456789abcdef',
    correlationId: TASK_ID,
    producer: 'provider-runtime',
    data: {
      executionId: EXECUTION_ID,
      taskId: TASK_ID,
      providerId: PROVIDER_ID,
      modelCode: 'internal-model-v1',
      providerTaskId: 'remote-1',
      attemptNumber: 2,
      pollNumber: 1,
      dueAt: DUE.toISOString(),
    },
    ...overrides,
  };
}

class PollRepo implements PollRepository {
  readonly claims: ClaimPollInput[] = [];
  readonly completions: CompletePollInput[] = [];
  readonly deferrals: DeferPollInput[] = [];
  claimResult: Awaited<ReturnType<PollRepository['claim']>> = {
    kind: 'CLAIMED',
    executionId: EXECUTION_ID,
    taskId: TASK_ID,
    attemptNumber: 2,
    pollNumber: 1,
    providerTaskId: 'remote-1',
    leaseToken: 'a'.repeat(64),
  };

  async claim(input: ClaimPollInput) {
    this.claims.push(input);
    return this.claimResult;
  }

  async complete(input: CompletePollInput) {
    this.completions.push(input);
  }

  async defer(input: DeferPollInput) {
    this.deferrals.push(input);
  }
}

function harness(
  now = DUE,
  runtime: {
    readonly queryTimeoutMs?: number;
    readonly timers?: {
      set(callback: () => void, delayMs: number): unknown;
      clear(handle: unknown): void;
    };
  } = {},
) {
  const repository = new PollRepo();
  const adapter = { queryTask: vi.fn().mockResolvedValue({ state: 'RUNNING' }) };
  const circuit: ProviderCircuitGate = {
    acquire: vi.fn().mockResolvedValue({ kind: 'ALLOW', token: 'permit-1' }),
    record: vi.fn().mockResolvedValue(undefined),
    tripImmediately: vi.fn().mockResolvedValue(undefined),
  };
  let id = 0;
  const service = new ProviderPollingService({
    repository,
    adapters: {
      resolve: vi.fn().mockResolvedValue(adapter),
    },
    clock: { now: () => now },
    ids: { next: () => `0198f4d4-21c2-7b7d-8a03-08a0da2a5${String(++id).padStart(3, '0')}` },
    circuit,
    intervalMs: 30_000,
    ...runtime,
  });
  return { adapter, circuit, repository, service };
}

describe('durable callback-loss polling', () => {
  it('uses a unique poll lease owner token for every delivery attempt', async () => {
    const { repository, service } = harness();

    await service.handle(pollEvent());
    await service.handle(pollEvent());

    expect(repository.claims).toHaveLength(2);
    expect(repository.claims[0]?.leaseToken).not.toBe(repository.claims[1]?.leaseToken);
  });

  it('turns success without canonical result URLs into durable ambiguous reconciliation', async () => {
    const { adapter, repository, service } = harness();
    adapter.queryTask.mockResolvedValue({ state: 'SUCCEEDED' });

    await expect(service.handle(pollEvent())).resolves.toEqual({
      ack: true,
      outcome: 'AMBIGUOUS',
    });
    expect(repository.completions[0]).toMatchObject({
      state: 'AMBIGUOUS',
      errorCode: 'PROVIDER_SUCCESS_RESULT_MISSING',
      stateOutbox: {
        eventType: 'provider.execution-ambiguous.v1',
      },
    });
    expect(repository.completions[0]?.stateOutbox.payload).toMatchObject({
      repairRequired: true,
    });
  });

  it('turns an empty success result list into durable ambiguous reconciliation', async () => {
    const { adapter, repository, service } = harness();
    adapter.queryTask.mockResolvedValue({ state: 'SUCCEEDED', resultUrls: [] });

    await expect(service.handle(pollEvent())).resolves.toEqual({
      ack: true,
      outcome: 'AMBIGUOUS',
    });
    expect(repository.completions[0]).toMatchObject({
      state: 'AMBIGUOUS',
      errorCode: 'PROVIDER_SUCCESS_RESULT_MISSING',
    });
  });

  it('claims a due poll with its create attempt number and schedules the next poll', async () => {
    const { adapter, circuit, repository, service } = harness();
    await expect(service.handle(pollEvent())).resolves.toEqual({ ack: true, outcome: 'RUNNING' });
    expect(repository.claims[0]).toMatchObject({ attemptNumber: 2, pollNumber: 1 });
    expect(adapter.queryTask).toHaveBeenCalledWith({ providerTaskId: 'remote-1' });
    expect(circuit.acquire).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      modelCode: 'internal-model-v1',
    });
    expect(circuit.record).toHaveBeenCalledWith(
      { providerId: PROVIDER_ID, modelCode: 'internal-model-v1' },
      { kind: 'ALLOW', token: 'permit-1' },
      'SUCCESS',
    );
    expect(repository.completions[0]).toMatchObject({
      state: 'RUNNING',
      attemptNumber: 2,
      pollNumber: 1,
      nextPollAt: new Date(DUE.getTime() + 30_000),
      nextPollOutbox: {
        eventType: 'provider.execution-poll-due.v1',
        availableAt: new Date(DUE.getTime() + 30_000),
      },
    });
  });

  it.each(['SUCCEEDED', 'FAILED', 'CANCELED'] as const)(
    'stops polling after terminal state %s',
    async (state) => {
      const { adapter, repository, service } = harness();
      adapter.queryTask.mockResolvedValue(
        state === 'SUCCEEDED'
          ? { state, resultUrls: ['https://mock.invalid/result.mp4'] }
          : { state },
      );
      await expect(service.handle(pollEvent())).resolves.toEqual({ ack: true, outcome: state });
      expect(repository.completions[0]?.nextPollAt).toBeUndefined();
      expect(repository.completions[0]?.nextPollOutbox).toBeUndefined();
    },
  );

  it('does not query when a terminal callback already won the race', async () => {
    const { adapter, repository, service } = harness();
    repository.claimResult = { kind: 'TERMINAL' };
    await expect(service.handle(pollEvent())).resolves.toEqual({ ack: true, outcome: 'TERMINAL' });
    expect(adapter.queryTask).not.toHaveBeenCalled();
  });

  it('rejects malformed provider query results before durable state changes', async () => {
    const { adapter, circuit, repository, service } = harness();
    adapter.queryTask.mockResolvedValue({ state: 'SUCCEEDED', resultUrls: [123] } as never);
    await expect(service.handle(pollEvent())).rejects.toThrow('INVALID_PROVIDER_POLL_RESULT');
    expect(circuit.record).toHaveBeenCalledWith(
      { providerId: PROVIDER_ID, modelCode: 'internal-model-v1' },
      { kind: 'ALLOW', token: 'permit-1' },
      'QUALIFYING_FAILURE',
    );
    expect(repository.completions).toHaveLength(0);
  });

  it.each([
    { version: 2 },
    { producer: 'other-runtime' },
    { correlationId: EXECUTION_ID },
    { unexpected: true },
    { data: { ...(pollEvent() as { data: Record<string, unknown> }).data, unexpected: true } },
  ])('strictly rejects an invalid poll envelope %#', async (override) => {
    const { adapter, repository, service } = harness();
    await expect(service.handle(pollEvent(override))).rejects.toThrow('INVALID_POLL_EVENT');
    expect(repository.claims).toHaveLength(0);
    expect(adapter.queryTask).not.toHaveBeenCalled();
  });

  it('blocks provider queries while the provider/model circuit is open and durably defers', async () => {
    const { adapter, circuit, repository, service } = harness();
    vi.mocked(circuit.acquire).mockResolvedValue({ kind: 'REJECT', reason: 'OPEN' });
    await expect(service.handle(pollEvent())).resolves.toEqual({ ack: true, outcome: 'DEFERRED' });
    expect(adapter.queryTask).not.toHaveBeenCalled();
    expect(repository.deferrals[0]).toMatchObject({
      attemptNumber: 2,
      pollNumber: 1,
      errorCode: 'PROVIDER_CIRCUIT_OPEN',
    });
  });

  it.each([
    [{ status: 429 }, 'QUALIFYING_FAILURE'],
    [{ status: 503 }, 'QUALIFYING_FAILURE'],
    [{ code: 'ETIMEDOUT' }, 'QUALIFYING_FAILURE'],
  ] as const)('counts query failures %# and durably defers', async (shape, expected) => {
    const { adapter, circuit, repository, service } = harness();
    adapter.queryTask.mockRejectedValue(Object.assign(new Error('query failed'), shape));
    await expect(service.handle(pollEvent())).resolves.toEqual({ ack: true, outcome: 'DEFERRED' });
    expect(circuit.record).toHaveBeenCalledWith(
      { providerId: PROVIDER_ID, modelCode: 'internal-model-v1' },
      { kind: 'ALLOW', token: 'permit-1' },
      expected,
    );
    expect(repository.deferrals).toHaveLength(1);
  });

  it('opens immediately with P1 semantics on query authentication failure', async () => {
    const { adapter, circuit, repository, service } = harness();
    adapter.queryTask.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));
    await expect(service.handle(pollEvent())).resolves.toEqual({ ack: true, outcome: 'DEFERRED' });
    expect(circuit.tripImmediately).toHaveBeenCalledWith(
      { providerId: PROVIDER_ID, modelCode: 'internal-model-v1' },
      'AUTH_FAILURE',
    );
    expect(repository.deferrals).toHaveLength(1);
  });

  it('times out a never-settling query, accounts the half-open failure, defers durably and ignores a late result', async () => {
    let fireDeadline!: () => void;
    const clear = vi.fn();
    const { adapter, circuit, repository, service } = harness(DUE, {
      queryTimeoutMs: 25,
      timers: {
        set: (callback, delayMs) => {
          expect(delayMs).toBe(25);
          fireDeadline = callback;
          return 'query-timer';
        },
        clear,
      },
    });
    vi.mocked(circuit.acquire).mockResolvedValue({
      kind: 'HALF_OPEN_PROBE',
      token: 'half-open-1',
    });
    let resolveLate!: (value: { state: 'SUCCEEDED' }) => void;
    adapter.queryTask.mockReturnValue(
      new Promise((resolve) => {
        resolveLate = resolve;
      }),
    );
    const handling = service.handle(pollEvent());
    await vi.waitFor(() => {
      expect(adapter.queryTask).toHaveBeenCalledOnce();
    });
    fireDeadline();
    await expect(handling).resolves.toEqual({ ack: true, outcome: 'DEFERRED' });
    expect(circuit.record).toHaveBeenCalledWith(
      { providerId: PROVIDER_ID, modelCode: 'internal-model-v1' },
      { kind: 'HALF_OPEN_PROBE', token: 'half-open-1' },
      'QUALIFYING_FAILURE',
    );
    expect(repository.deferrals[0]).toMatchObject({ errorCode: 'PROVIDER_TIMEOUT' });
    expect(clear).toHaveBeenCalledWith('query-timer');
    resolveLate({ state: 'SUCCEEDED' });
    await Promise.resolve();
    expect(repository.completions).toHaveLength(0);
    expect(circuit.record).toHaveBeenCalledTimes(1);
  });

  it('clears the query deadline timer after an on-time provider result', async () => {
    const clear = vi.fn();
    const { service } = harness(DUE, {
      queryTimeoutMs: 25,
      timers: { set: vi.fn().mockReturnValue('query-timer'), clear },
    });
    await service.handle(pollEvent());
    expect(clear).toHaveBeenCalledWith('query-timer');
  });

  it('does not ACK an early poll and never queries an ambiguous execution without providerTaskId', async () => {
    const early = harness(new Date(DUE.getTime() - 1));
    early.repository.claimResult = { kind: 'NOT_DUE' };
    await expect(early.service.handle(pollEvent())).resolves.toEqual({
      ack: false,
      outcome: 'NOT_DUE',
    });
    expect(early.adapter.queryTask).not.toHaveBeenCalled();

    const manual = harness();
    manual.repository.claimResult = { kind: 'MANUAL_RECONCILE' };
    await expect(manual.service.handle(pollEvent())).resolves.toEqual({
      ack: true,
      outcome: 'MANUAL_RECONCILE',
    });
    expect(manual.adapter.queryTask).not.toHaveBeenCalled();
  });

  it('ACKs transport messages only after the durable completion commits', async () => {
    let release!: () => void;
    const handler = vi.fn(
      () =>
        new Promise<{ ack: true; outcome: 'RUNNING' }>((resolve) => {
          release = () => {
            resolve({ ack: true, outcome: 'RUNNING' });
          };
        }),
    );
    const ack = vi.fn().mockResolvedValue(undefined);
    const retry = vi.fn().mockResolvedValue(undefined);
    const consumer = new PollingConsumer({ handle: handler });
    const consuming = consumer.consume({ body: pollEvent(), ack, retry });
    await Promise.resolve();
    expect(ack).not.toHaveBeenCalled();
    release();
    await consuming;
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});
