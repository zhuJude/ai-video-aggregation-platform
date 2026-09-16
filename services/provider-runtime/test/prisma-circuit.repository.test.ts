/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it, vi } from 'vitest';
import { PrismaCircuitRepository } from '../src/index.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

const KEY = {
  providerId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a7',
  modelCode: 'internal-model-v1',
};
const NOW = new Date('2026-08-31T12:00:00.000Z');

function repository(updateCounts: number[], countResults = [10, 5, 10, 5]) {
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    circuitState: {
      findUnique: vi.fn().mockResolvedValue({
        id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
        status: 'CLOSED',
        version: 0,
      }),
      updateMany: vi.fn().mockImplementation(() => ({ count: updateCounts.shift() ?? 1 })),
      update: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({
        id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
      }),
    },
    circuitObservation: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockImplementation(() => Promise.resolve(countResults.shift() ?? 0)),
    },
    outboxEvent: {
      create: vi.fn(),
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as PrismaClient;
  let id = 0;
  return {
    prisma,
    transaction,
    subject: new PrismaCircuitRepository(prisma, {
      next: () => `0198f4d4-21c2-7b7d-8a03-08a0da2a5${String(++id).padStart(3, '0')}`,
    }),
  };
}

describe('Prisma circuit concurrency', () => {
  it('serializes rolling observations with a provider/model row lock instead of bounded CAS', async () => {
    const { prisma, subject, transaction } = repository([0]);
    await subject.record({
      key: KEY,
      permit: { kind: 'ALLOW', token: 'permit-1' },
      outcome: 'QUALIFYING_FAILURE',
      now: NOW,
      windowMs: 60_000,
      minimumFailures: 10,
      failureThreshold: 0.5,
      openDurationMs: 60_000,
    });
    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledOnce();
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(transaction.circuitState.update).toHaveBeenCalledOnce();
  });

  it('atomically reclaims an expired persisted half-open probe lease', async () => {
    const { subject, transaction } = repository([1]);
    transaction.circuitState.upsert.mockResolvedValueOnce({
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
      status: 'HALF_OPEN',
      version: 7,
      halfOpenProbeInFlight: true,
      halfOpenProbeToken: 'crashed-probe',
      halfOpenProbeExpiresAt: new Date(NOW.getTime() - 1),
    });
    await expect(
      subject.acquire({
        key: KEY,
        now: NOW,
        probeToken: 'replacement-probe',
        openDurationMs: 60_000,
        probeLeaseMs: 30_000,
      }),
    ).resolves.toEqual({ kind: 'HALF_OPEN_PROBE', token: 'replacement-probe' });
    expect(transaction.circuitState.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: 'HALF_OPEN',
        version: 7,
        halfOpenProbeExpiresAt: { lte: NOW },
      }),
      data: expect.objectContaining({
        halfOpenProbeToken: 'replacement-probe',
        halfOpenProbeExpiresAt: new Date(NOW.getTime() + 30_000),
      }),
    });
  });

  it('upserts immediate health events so duplicate auth/balance signals remain idempotent', async () => {
    const { subject, transaction } = repository([1]);
    await subject.tripImmediately({
      key: KEY,
      reason: 'AUTH_FAILURE',
      now: NOW,
      openUntil: new Date(NOW.getTime() + 60_000),
      outbox: {
        id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c0',
        aggregateId: KEY.providerId,
        eventType: 'provider.health.auth-failed.v1',
        payload: { severity: 'P1' },
        occurredAt: NOW,
      },
    });
    expect(transaction.outboxEvent.upsert).toHaveBeenCalledOnce();
    expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('requires ten qualifying failures as well as a 50 percent rolling failure rate', async () => {
    const fiveOfTen = repository([1], [10, 5]);
    await fiveOfTen.subject.record({
      key: KEY,
      permit: { kind: 'ALLOW', token: 'permit-1' },
      outcome: 'QUALIFYING_FAILURE',
      now: NOW,
      windowMs: 60_000,
      minimumFailures: 10,
      failureThreshold: 0.5,
      openDurationMs: 60_000,
    });
    expect(fiveOfTen.transaction.circuitState.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ status: 'OPEN' }) }),
    );

    const tenOfTwenty = repository([1], [20, 10]);
    await tenOfTwenty.subject.record({
      key: KEY,
      permit: { kind: 'ALLOW', token: 'permit-2' },
      outcome: 'QUALIFYING_FAILURE',
      now: NOW,
      windowMs: 60_000,
      minimumFailures: 10,
      failureThreshold: 0.5,
      openDurationMs: 60_000,
    });
    expect(tenOfTwenty.transaction.circuitState.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'OPEN' }) }),
    );
  });

  it('durably records an in-flight closed permit even when an earlier outcome opened the circuit', async () => {
    const { subject, transaction } = repository([1]);
    transaction.circuitState.findUnique
      .mockResolvedValueOnce({ id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0' })
      .mockResolvedValueOnce({
        id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
        status: 'OPEN',
        version: 9,
      });
    await subject.record({
      key: KEY,
      permit: { kind: 'ALLOW', token: 'in-flight-permit' },
      outcome: 'SUCCESS',
      now: NOW,
      windowMs: 60_000,
      minimumFailures: 10,
      failureThreshold: 0.5,
      openDurationMs: 60_000,
    });
    expect(transaction.circuitObservation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ failed: false, observedAt: NOW }),
    });
    expect(transaction.circuitState.update).not.toHaveBeenCalled();
  });
});
