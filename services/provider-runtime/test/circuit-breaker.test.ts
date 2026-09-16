import { describe, expect, it } from 'vitest';
import { CircuitBreaker, InMemoryCircuitRepository, type CircuitPermit } from '../src/index.js';

const KEY = {
  providerId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a7',
  modelCode: 'internal-model-v1',
};
const START = new Date('2026-08-31T12:00:00.000Z');

function breaker() {
  let now = START;
  let id = 0;
  const repository = new InMemoryCircuitRepository();
  const circuit = new CircuitBreaker({
    repository,
    clock: { now: () => now },
    ids: { next: () => `id-${String(++id)}` },
  });
  return { circuit, repository, setNow: (value: Date) => (now = value) };
}

async function observe(
  circuit: CircuitBreaker,
  outcome: 'SUCCESS' | 'QUALIFYING_FAILURE',
): Promise<void> {
  const permit = await circuit.acquire(KEY);
  expect(permit.kind).toBe('ALLOW');
  await circuit.record(KEY, permit as CircuitPermit, outcome);
}

describe('provider/model circuit breaker', () => {
  it('stays closed at five failures out of ten samples', async () => {
    const { circuit, repository } = breaker();
    for (let index = 0; index < 5; index += 1) await observe(circuit, 'SUCCESS');
    for (let index = 0; index < 5; index += 1) await observe(circuit, 'QUALIFYING_FAILURE');
    expect(repository.inspect(KEY)).toMatchObject({
      status: 'CLOSED',
      sampleCount: 10,
      failures: 5,
    });
  });

  it('opens at ten failures out of twenty samples', async () => {
    const { circuit, repository } = breaker();
    for (let index = 0; index < 10; index += 1) await observe(circuit, 'SUCCESS');
    for (let index = 0; index < 10; index += 1) await observe(circuit, 'QUALIFYING_FAILURE');
    expect(repository.inspect(KEY)).toMatchObject({
      status: 'OPEN',
      sampleCount: 20,
      failures: 10,
    });
    await expect(circuit.acquire(KEY)).resolves.toEqual({ kind: 'REJECT', reason: 'OPEN' });
  });

  it('retains an in-flight outcome acquired before another call opened the circuit', async () => {
    const { circuit, repository } = breaker();
    const permits = await Promise.all(
      Array.from({ length: 11 }, async () => {
        const permit = await circuit.acquire(KEY);
        if (permit.kind !== 'ALLOW') throw new Error('permit missing');
        return permit;
      }),
    );
    for (const permit of permits.slice(0, 10))
      await circuit.record(KEY, permit, 'QUALIFYING_FAILURE');
    const inFlight = permits[10];
    if (inFlight === undefined) throw new Error('in-flight permit missing');
    await circuit.record(KEY, inFlight, 'SUCCESS');
    expect(repository.inspect(KEY)).toMatchObject({
      status: 'OPEN',
      sampleCount: 11,
      failures: 10,
    });
  });

  it('uses only the previous 60 seconds and requires at least ten samples', async () => {
    const { circuit, repository, setNow } = breaker();
    for (let index = 0; index < 9; index += 1) await observe(circuit, 'QUALIFYING_FAILURE');
    expect(repository.inspect(KEY).status).toBe('CLOSED');
    setNow(new Date(START.getTime() + 60_001));
    await observe(circuit, 'SUCCESS');
    expect(repository.inspect(KEY)).toMatchObject({
      status: 'CLOSED',
      sampleCount: 1,
      failures: 0,
    });
  });

  it('admits exactly one half-open probe and closes after its success', async () => {
    const { circuit, repository, setNow } = breaker();
    for (let index = 0; index < 10; index += 1) await observe(circuit, 'QUALIFYING_FAILURE');
    setNow(new Date(START.getTime() + 60_000));
    const [first, second] = await Promise.all([circuit.acquire(KEY), circuit.acquire(KEY)]);
    const probe = [first, second].find((permit) => permit.kind === 'HALF_OPEN_PROBE');
    expect([first.kind, second.kind].sort()).toEqual(['HALF_OPEN_PROBE', 'REJECT']);
    if (probe?.kind !== 'HALF_OPEN_PROBE') throw new Error('probe missing');
    await circuit.record(KEY, probe, 'SUCCESS');
    expect(repository.inspect(KEY).status).toBe('CLOSED');
    await expect(circuit.acquire(KEY)).resolves.toMatchObject({ kind: 'ALLOW' });
  });

  it('atomically reclaims an expired persisted half-open probe lease', async () => {
    const { circuit, repository, setNow } = breaker();
    for (let index = 0; index < 10; index += 1) await observe(circuit, 'QUALIFYING_FAILURE');
    setNow(new Date(START.getTime() + 60_000));
    const crashedProbe = await circuit.acquire(KEY);
    expect(crashedProbe.kind).toBe('HALF_OPEN_PROBE');
    setNow(new Date(START.getTime() + 120_001));
    const [first, second] = await Promise.all([circuit.acquire(KEY), circuit.acquire(KEY)]);
    const replacement = [first, second].find((permit) => permit.kind === 'HALF_OPEN_PROBE');
    expect([first.kind, second.kind].sort()).toEqual(['HALF_OPEN_PROBE', 'REJECT']);
    expect(replacement).not.toEqual(crashedProbe);
    if (replacement?.kind !== 'HALF_OPEN_PROBE') throw new Error('replacement probe missing');
    await circuit.record(KEY, replacement, 'SUCCESS');
    expect(repository.inspect(KEY).status).toBe('CLOSED');
  });

  it('reopens for 60 seconds after a failed half-open probe', async () => {
    const { circuit, repository, setNow } = breaker();
    for (let index = 0; index < 10; index += 1) await observe(circuit, 'QUALIFYING_FAILURE');
    setNow(new Date(START.getTime() + 60_000));
    const probe = await circuit.acquire(KEY);
    if (probe.kind !== 'HALF_OPEN_PROBE') throw new Error('probe missing');
    await circuit.record(KEY, probe, 'QUALIFYING_FAILURE');
    expect(repository.inspect(KEY)).toMatchObject({
      status: 'OPEN',
      openUntil: new Date(START.getTime() + 120_000),
    });
  });

  it.each([
    ['AUTH_FAILURE', 'P1', 'provider.health.auth-failed.v1'],
    ['ZERO_BALANCE', 'P2', 'provider.health.zero-balance.v1'],
  ] as const)(
    'opens immediately for %s and emits the %s health event',
    async (reason, severity, type) => {
      const { circuit, repository } = breaker();
      await circuit.tripImmediately(KEY, reason);
      expect(repository.inspect(KEY)).toMatchObject({ status: 'OPEN', reasonCode: reason });
      expect(repository.outbox[0]?.eventType).toBe(type);
      expect(repository.outbox[0]?.payload).toMatchObject({ severity });
    },
  );
});
