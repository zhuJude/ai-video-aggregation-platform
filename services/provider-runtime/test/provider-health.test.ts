/* eslint-disable @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from 'vitest';
import {
  ProviderBalanceCheckService,
  ProviderBalanceMonitor,
  ProviderHealthConsumer,
  type ProviderCircuitGate,
} from '../src/index.js';

const KEY = {
  providerId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a7',
  modelCode: 'internal-model-v1',
};

function circuit(): ProviderCircuitGate {
  return {
    acquire: vi.fn().mockResolvedValue({ kind: 'ALLOW', token: 'balance-permit' }),
    record: vi.fn().mockResolvedValue(undefined),
    tripImmediately: vi.fn().mockResolvedValue(undefined),
  };
}

describe('normalized provider balance health', () => {
  it.each(['0', '0.0', '0.000'])(
    'opens immediately with P2 semantics for zero balance %s',
    async (available) => {
      const gate = circuit();
      const monitor = new ProviderBalanceMonitor(gate);
      await expect(
        monitor.observe(KEY, {
          getBalance: vi.fn().mockResolvedValue({ unit: 'provider-credit', available }),
        }),
      ).resolves.toEqual({ kind: 'ZERO_BALANCE', unit: 'provider-credit' });
      expect(gate.tripImmediately).toHaveBeenCalledWith(KEY, 'ZERO_BALANCE');
      expect(gate.acquire).toHaveBeenCalledWith(KEY);
    },
  );

  it('does not trip for a positive balance and handles unsupported adapters explicitly', async () => {
    const gate = circuit();
    const monitor = new ProviderBalanceMonitor(gate);
    await expect(
      monitor.observe(KEY, {
        getBalance: vi.fn().mockResolvedValue({ unit: 'provider-credit', available: '0.01' }),
      }),
    ).resolves.toEqual({ kind: 'AVAILABLE', unit: 'provider-credit', available: '0.01' });
    await expect(monitor.observe(KEY, {})).resolves.toEqual({ kind: 'UNSUPPORTED' });
    expect(gate.record).toHaveBeenCalledWith(
      KEY,
      { kind: 'ALLOW', token: 'balance-permit' },
      'SUCCESS',
    );
    expect(gate.tripImmediately).not.toHaveBeenCalled();
  });

  it('does not call getBalance while the provider/model circuit is open', async () => {
    const gate = circuit();
    vi.mocked(gate.acquire).mockResolvedValue({ kind: 'REJECT', reason: 'OPEN' });
    const getBalance = vi.fn();
    await expect(new ProviderBalanceMonitor(gate).observe(KEY, { getBalance })).resolves.toEqual({
      kind: 'CIRCUIT_OPEN',
    });
    expect(getBalance).not.toHaveBeenCalled();
  });

  it('opens immediately with P1 semantics when a balance call reports authentication failure', async () => {
    const gate = circuit();
    await expect(
      new ProviderBalanceMonitor(gate).observe(KEY, {
        getBalance: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 })),
      }),
    ).rejects.toThrow('unauthorized');
    expect(gate.tripImmediately).toHaveBeenCalledWith(KEY, 'AUTH_FAILURE');
  });

  it('times out a never-settling balance call, accounts the half-open failure and ignores a late zero balance', async () => {
    let fireDeadline!: () => void;
    const clear = vi.fn();
    const gate = circuit();
    vi.mocked(gate.acquire).mockResolvedValue({
      kind: 'HALF_OPEN_PROBE',
      token: 'half-open-balance',
    });
    let resolveLate!: (value: { unit: string; available: string }) => void;
    const observing = new ProviderBalanceMonitor(gate, {
      timeoutMs: 40,
      timers: {
        set: (callback, delayMs) => {
          expect(delayMs).toBe(40);
          fireDeadline = callback;
          return 'balance-timer';
        },
        clear,
      },
    }).observe(KEY, {
      getBalance: () =>
        new Promise((resolve) => {
          resolveLate = resolve;
        }),
    });
    await vi.waitFor(() => {
      expect(fireDeadline).toBeTypeOf('function');
    });
    fireDeadline();
    await expect(observing).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(gate.record).toHaveBeenCalledWith(
      KEY,
      { kind: 'HALF_OPEN_PROBE', token: 'half-open-balance' },
      'QUALIFYING_FAILURE',
    );
    expect(clear).toHaveBeenCalledWith('balance-timer');
    resolveLate({ unit: 'provider-credit', available: '0' });
    await Promise.resolve();
    expect(gate.tripImmediately).not.toHaveBeenCalled();
    expect(gate.record).toHaveBeenCalledTimes(1);
  });

  it('clears the balance deadline timer after an on-time result', async () => {
    const clear = vi.fn();
    await new ProviderBalanceMonitor(circuit(), {
      timeoutMs: 40,
      timers: { set: vi.fn().mockReturnValue('balance-timer'), clear },
    }).observe(KEY, {
      getBalance: vi.fn().mockResolvedValue({ unit: 'provider-credit', available: '1' }),
    });
    expect(clear).toHaveBeenCalledWith('balance-timer');
  });

  it('runs balance checks from a strict transport-neutral scheduled event and ACKs afterward', async () => {
    const gate = circuit();
    const getBalance = vi.fn().mockResolvedValue({ unit: 'provider-credit', available: '0' });
    const service = new ProviderBalanceCheckService({
      monitor: new ProviderBalanceMonitor(gate),
      adapters: { resolve: vi.fn().mockResolvedValue({ getBalance }) },
    });
    const ack = vi.fn().mockResolvedValue(undefined);
    const retry = vi.fn().mockResolvedValue(undefined);
    const consumer = new ProviderHealthConsumer(service);
    await consumer.consume({
      body: {
        id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c9',
        type: 'provider.balance-check-due.v1',
        version: 1,
        occurredAt: '2026-08-31T12:00:00.000Z',
        traceId: '0123456789abcdef0123456789abcdef',
        correlationId: KEY.providerId,
        producer: 'provider-runtime',
        data: KEY,
      },
      ack,
      retry,
    });
    expect(getBalance).toHaveBeenCalledOnce();
    expect(gate.tripImmediately).toHaveBeenCalledWith(KEY, 'ZERO_BALANCE');
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('rejects malformed normalized balances instead of guessing vendor semantics', async () => {
    const monitor = new ProviderBalanceMonitor(circuit());
    await expect(
      monitor.observe(KEY, {
        getBalance: vi.fn().mockResolvedValue({ unit: 'provider-credit', available: '-1' }),
      }),
    ).rejects.toThrow('INVALID_PROVIDER_BALANCE');
  });
});
