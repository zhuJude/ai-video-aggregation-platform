import { EventEnvelopeSchema, UuidSchema } from '@repo/contracts/common';
import { z } from 'zod';
import type { ProviderCircuitGate } from './execution.service.js';
import type { CircuitKey, CircuitPermit } from '../domain/circuit-breaker.js';
import { classifyProviderFailure } from '../domain/retry-policy.js';
import {
  callProviderWithDeadline,
  defaultProviderCallTimers,
  ProviderCallTimeoutError,
  type ProviderCallDeadlineResult,
  type ProviderCallTimers,
} from './provider-call-deadline.js';

export interface ProviderBalanceAdapter {
  readonly getBalance?: () => Promise<{ readonly unit: string; readonly available: string }>;
}

export type ProviderBalanceObservation =
  | { readonly kind: 'UNSUPPORTED' }
  | { readonly kind: 'CIRCUIT_OPEN' }
  | { readonly kind: 'ZERO_BALANCE'; readonly unit: string }
  | { readonly kind: 'AVAILABLE'; readonly unit: string; readonly available: string };

export class ProviderBalanceMonitor {
  private readonly timeoutMs: number;
  private readonly timers: ProviderCallTimers;

  constructor(
    private readonly circuit: ProviderCircuitGate,
    options: { readonly timeoutMs?: number; readonly timers?: ProviderCallTimers } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.timers = options.timers ?? defaultProviderCallTimers();
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1)
      throw new Error('INVALID_BALANCE_TIMEOUT');
  }

  async observe(
    key: CircuitKey,
    adapter: ProviderBalanceAdapter,
  ): Promise<ProviderBalanceObservation> {
    const getBalance = adapter.getBalance;
    if (getBalance === undefined) return { kind: 'UNSUPPORTED' };
    const permit = await this.circuit.acquire(key);
    if (permit.kind === 'REJECT') return { kind: 'CIRCUIT_OPEN' };
    let raced: ProviderCallDeadlineResult<{
      readonly unit: string;
      readonly available: string;
    }>;
    try {
      raced = await callProviderWithDeadline({
        operation: () => getBalance(),
        timeoutMs: this.timeoutMs,
        timers: this.timers,
      });
    } catch (error) {
      await this.recordFailure(key, permit, error);
      throw error;
    }
    if (raced.kind === 'TIMED_OUT') {
      const timeout = new ProviderCallTimeoutError();
      await this.recordFailure(key, permit, timeout);
      throw timeout;
    }
    const balance = raced.result;
    if (
      balance.unit.length < 1 ||
      balance.unit.length > 120 ||
      !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(balance.available)
    ) {
      await this.circuit.record(key, permit, 'QUALIFYING_FAILURE');
      throw new Error('INVALID_PROVIDER_BALANCE');
    }
    if (/^0(?:\.0+)?$/.test(balance.available)) {
      await this.circuit.tripImmediately(key, 'ZERO_BALANCE');
      return { kind: 'ZERO_BALANCE', unit: balance.unit };
    }
    await this.circuit.record(key, permit, 'SUCCESS');
    return { kind: 'AVAILABLE', unit: balance.unit, available: balance.available };
  }

  private async recordFailure(
    key: CircuitKey,
    permit: CircuitPermit,
    error: unknown,
  ): Promise<void> {
    const failure = classifyProviderFailure(error);
    if (failure.code === 'PROVIDER_AUTH_FAILED') {
      await this.circuit.tripImmediately(key, 'AUTH_FAILURE');
      return;
    }
    const qualifying =
      failure.code === 'PROVIDER_RATE_LIMITED' ||
      failure.code === 'PROVIDER_UNAVAILABLE' ||
      failure.code === 'PROVIDER_TIMEOUT' ||
      failure.code === 'PROVIDER_NETWORK_ERROR' ||
      failure.code === 'PROVIDER_PROTOCOL_ERROR';
    await this.circuit.record(key, permit, qualifying ? 'QUALIFYING_FAILURE' : 'SUCCESS');
  }
}

const BalanceCheckDataSchema = z.strictObject({
  providerId: UuidSchema,
  modelCode: z.string().min(1).max(160),
});

export interface ProviderBalanceAdapterRegistry {
  resolve(key: CircuitKey): Promise<ProviderBalanceAdapter | null>;
}

export class ProviderBalanceCheckService {
  constructor(
    private readonly dependencies: {
      readonly monitor: ProviderBalanceMonitor;
      readonly adapters: ProviderBalanceAdapterRegistry;
    },
  ) {}

  async handle(rawEvent: unknown): Promise<ProviderBalanceObservation> {
    const envelope = EventEnvelopeSchema.strict().safeParse(rawEvent);
    if (
      !envelope.success ||
      envelope.data.type !== 'provider.balance-check-due.v1' ||
      envelope.data.version !== 1 ||
      envelope.data.producer !== 'provider-runtime'
    )
      throw new Error('INVALID_PROVIDER_BALANCE_CHECK_EVENT');
    const data = BalanceCheckDataSchema.safeParse(envelope.data.data);
    if (!data.success || envelope.data.correlationId !== data.data.providerId)
      throw new Error('INVALID_PROVIDER_BALANCE_CHECK_EVENT');
    const adapter = await this.dependencies.adapters.resolve(data.data);
    if (adapter === null) throw new Error('BALANCE_ADAPTER_NOT_FOUND');
    return this.dependencies.monitor.observe(data.data, adapter);
  }
}

export class ProviderHealthConsumer {
  constructor(private readonly handler: { handle(body: unknown): Promise<unknown> }) {}

  async consume(input: {
    readonly body: unknown;
    readonly ack: () => Promise<void>;
    readonly retry: () => Promise<void>;
  }): Promise<void> {
    try {
      await this.handler.handle(input.body);
      await input.ack();
    } catch {
      await input.retry();
    }
  }
}
