export interface CircuitKey {
  readonly providerId: string;
  readonly modelCode: string;
}

export type CircuitPermit =
  | { readonly kind: 'ALLOW'; readonly token: string }
  | { readonly kind: 'HALF_OPEN_PROBE'; readonly token: string };
export type CircuitAcquireResult =
  CircuitPermit | { readonly kind: 'REJECT'; readonly reason: 'OPEN' };
export type CircuitOutcome = 'SUCCESS' | 'QUALIFYING_FAILURE';
export type ImmediateCircuitReason = 'AUTH_FAILURE' | 'ZERO_BALANCE';

export interface CircuitHealthOutbox {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: 'provider.health.auth-failed.v1' | 'provider.health.zero-balance.v1';
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
}

export interface CircuitRepository {
  status?(key: CircuitKey): Promise<'CLOSED' | 'OPEN' | 'HALF_OPEN'>;
  acquire(input: {
    readonly key: CircuitKey;
    readonly now: Date;
    readonly probeToken: string;
    readonly openDurationMs: number;
    readonly probeLeaseMs: number;
  }): Promise<CircuitAcquireResult>;
  record(input: {
    readonly key: CircuitKey;
    readonly permit: CircuitPermit;
    readonly outcome: CircuitOutcome;
    readonly now: Date;
    readonly windowMs: number;
    readonly minimumFailures: number;
    readonly failureThreshold: number;
    readonly openDurationMs: number;
  }): Promise<void>;
  tripImmediately(input: {
    readonly key: CircuitKey;
    readonly reason: ImmediateCircuitReason;
    readonly now: Date;
    readonly openUntil: Date;
    readonly outbox: CircuitHealthOutbox;
  }): Promise<void>;
}

interface CircuitBreakerDependencies {
  readonly repository: CircuitRepository;
  readonly clock: { now(): Date };
  readonly ids: { next(): string };
  readonly windowMs?: number;
  readonly minimumFailures?: number;
  readonly failureThreshold?: number;
  readonly openDurationMs?: number;
  readonly probeLeaseMs?: number;
  readonly observer?: {
    observeCircuitState(channelKey: string, state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'): void;
  };
}

export class CircuitBreaker {
  private readonly windowMs: number;
  private readonly minimumFailures: number;
  private readonly failureThreshold: number;
  private readonly openDurationMs: number;
  private readonly probeLeaseMs: number;

  constructor(private readonly dependencies: CircuitBreakerDependencies) {
    this.windowMs = dependencies.windowMs ?? 60_000;
    this.minimumFailures = dependencies.minimumFailures ?? 10;
    this.failureThreshold = dependencies.failureThreshold ?? 0.5;
    this.openDurationMs = dependencies.openDurationMs ?? 60_000;
    this.probeLeaseMs = dependencies.probeLeaseMs ?? 60_000;
    if (
      this.windowMs < 1 ||
      this.openDurationMs < 1 ||
      this.probeLeaseMs < 1 ||
      this.minimumFailures < 1
    )
      throw new Error('INVALID_CIRCUIT_CONFIGURATION');
    if (this.failureThreshold <= 0 || this.failureThreshold > 1)
      throw new Error('INVALID_CIRCUIT_CONFIGURATION');
  }

  async acquire(key: CircuitKey): Promise<CircuitAcquireResult> {
    const result = await this.dependencies.repository.acquire({
      key,
      now: this.dependencies.clock.now(),
      probeToken: this.dependencies.ids.next(),
      openDurationMs: this.openDurationMs,
      probeLeaseMs: this.probeLeaseMs,
    });
    const durableState = await this.dependencies.repository.status?.(key);
    this.dependencies.observer?.observeCircuitState(
      circuitMetricKey(key),
      durableState ??
        (result.kind === 'REJECT'
          ? 'OPEN'
          : result.kind === 'HALF_OPEN_PROBE'
            ? 'HALF_OPEN'
            : 'CLOSED'),
    );
    return result;
  }

  async record(key: CircuitKey, permit: CircuitPermit, outcome: CircuitOutcome): Promise<void> {
    await this.dependencies.repository.record({
      key,
      permit,
      outcome,
      now: this.dependencies.clock.now(),
      windowMs: this.windowMs,
      minimumFailures: this.minimumFailures,
      failureThreshold: this.failureThreshold,
      openDurationMs: this.openDurationMs,
    });
    const durableState = await this.dependencies.repository.status?.(key);
    if (durableState !== undefined) {
      this.dependencies.observer?.observeCircuitState(circuitMetricKey(key), durableState);
    } else if (permit.kind === 'HALF_OPEN_PROBE') {
      this.dependencies.observer?.observeCircuitState(
        circuitMetricKey(key),
        outcome === 'SUCCESS' ? 'CLOSED' : 'OPEN',
      );
    }
  }

  async tripImmediately(key: CircuitKey, reason: ImmediateCircuitReason): Promise<void> {
    const now = this.dependencies.clock.now();
    const severity = reason === 'AUTH_FAILURE' ? 'P1' : 'P2';
    const eventType =
      reason === 'AUTH_FAILURE'
        ? ('provider.health.auth-failed.v1' as const)
        : ('provider.health.zero-balance.v1' as const);
    await this.dependencies.repository.tripImmediately({
      key,
      reason,
      now,
      openUntil: new Date(now.getTime() + this.openDurationMs),
      outbox: {
        id: this.dependencies.ids.next(),
        aggregateId: key.providerId,
        eventType,
        payload: { ...key, reasonCode: reason, severity },
        occurredAt: now,
      },
    });
    this.dependencies.observer?.observeCircuitState(circuitMetricKey(key), 'OPEN');
  }
}

function circuitMetricKey(key: CircuitKey): string {
  return `${key.providerId}\u0000${key.modelCode}`;
}

interface MemoryCircuitState {
  status: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  observations: Array<{ at: Date; failure: boolean }>;
  openUntil: Date | undefined;
  probeToken: string | undefined;
  probeExpiresAt: Date | undefined;
  reasonCode: string | undefined;
}

/** Useful for deterministic local execution; production uses the same repository contract. */
export class InMemoryCircuitRepository implements CircuitRepository {
  private readonly states = new Map<string, MemoryCircuitState>();
  private chain: Promise<void> = Promise.resolve();
  readonly outbox: CircuitHealthOutbox[] = [];

  status(key: CircuitKey): Promise<'CLOSED' | 'OPEN' | 'HALF_OPEN'> {
    return Promise.resolve(this.state(key).status);
  }

  acquire(input: Parameters<CircuitRepository['acquire']>[0]): Promise<CircuitAcquireResult> {
    return this.exclusive(() => {
      const state = this.state(input.key);
      if (state.status === 'CLOSED') return { kind: 'ALLOW', token: input.probeToken };
      if (
        state.status === 'OPEN' &&
        state.openUntil !== undefined &&
        state.openUntil.getTime() <= input.now.getTime()
      ) {
        state.status = 'HALF_OPEN';
        state.probeToken = input.probeToken;
        state.probeExpiresAt = new Date(input.now.getTime() + input.probeLeaseMs);
        return { kind: 'HALF_OPEN_PROBE', token: input.probeToken };
      }
      if (
        state.status === 'HALF_OPEN' &&
        state.probeExpiresAt !== undefined &&
        state.probeExpiresAt.getTime() <= input.now.getTime()
      ) {
        state.probeToken = input.probeToken;
        state.probeExpiresAt = new Date(input.now.getTime() + input.probeLeaseMs);
        return { kind: 'HALF_OPEN_PROBE', token: input.probeToken };
      }
      return { kind: 'REJECT', reason: 'OPEN' };
    });
  }

  record(input: Parameters<CircuitRepository['record']>[0]): Promise<void> {
    return this.exclusive(() => {
      const state = this.state(input.key);
      if (input.permit.kind === 'HALF_OPEN_PROBE') {
        if (
          state.status !== 'HALF_OPEN' ||
          state.probeToken !== input.permit.token ||
          state.probeExpiresAt === undefined ||
          state.probeExpiresAt.getTime() <= input.now.getTime()
        )
          throw new Error('STALE_HALF_OPEN_PROBE');
        if (input.outcome === 'SUCCESS') {
          state.status = 'CLOSED';
          state.observations = [];
          state.openUntil = undefined;
          state.probeToken = undefined;
          state.probeExpiresAt = undefined;
          state.reasonCode = undefined;
        } else {
          state.status = 'OPEN';
          state.openUntil = new Date(input.now.getTime() + input.openDurationMs);
          state.probeToken = undefined;
          state.probeExpiresAt = undefined;
          state.reasonCode = 'HALF_OPEN_PROBE_FAILED';
        }
        return;
      }
      const wasClosed = state.status === 'CLOSED';
      const cutoff = input.now.getTime() - input.windowMs;
      state.observations = state.observations.filter(({ at }) => at.getTime() > cutoff);
      state.observations.push({ at: input.now, failure: input.outcome === 'QUALIFYING_FAILURE' });
      if (!wasClosed) return;
      const failures = state.observations.filter(({ failure }) => failure).length;
      if (
        failures >= input.minimumFailures &&
        failures / state.observations.length >= input.failureThreshold
      ) {
        state.status = 'OPEN';
        state.openUntil = new Date(input.now.getTime() + input.openDurationMs);
        state.reasonCode = 'FAILURE_RATE';
      }
    });
  }

  tripImmediately(input: Parameters<CircuitRepository['tripImmediately']>[0]): Promise<void> {
    return this.exclusive(() => {
      const state = this.state(input.key);
      state.status = 'OPEN';
      state.openUntil = input.openUntil;
      state.probeToken = undefined;
      state.probeExpiresAt = undefined;
      state.reasonCode = input.reason;
      this.outbox.push(input.outbox);
    });
  }

  inspect(key: CircuitKey): {
    readonly status: MemoryCircuitState['status'];
    readonly sampleCount: number;
    readonly failures: number;
    readonly openUntil?: Date;
    readonly reasonCode?: string;
  } {
    const state = this.state(key);
    return {
      status: state.status,
      sampleCount: state.observations.length,
      failures: state.observations.filter(({ failure }) => failure).length,
      ...(state.openUntil === undefined ? {} : { openUntil: state.openUntil }),
      ...(state.reasonCode === undefined ? {} : { reasonCode: state.reasonCode }),
    };
  }

  private state(key: CircuitKey): MemoryCircuitState {
    const encoded = `${key.providerId}\u0000${key.modelCode}`;
    const existing = this.states.get(encoded);
    if (existing !== undefined) return existing;
    const created: MemoryCircuitState = {
      status: 'CLOSED',
      observations: [],
      openUntil: undefined,
      probeToken: undefined,
      probeExpiresAt: undefined,
      reasonCode: undefined,
    };
    this.states.set(encoded, created);
    return created;
  }

  private exclusive<T>(operation: () => T): Promise<T> {
    const result = this.chain.then(operation, operation);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
