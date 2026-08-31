import { describe, expect, it, vi } from 'vitest';
import { EventEnvelopeSchema } from '@repo/contracts/common';
import { createUuidV7Generator, isUuidV7 } from '../src/domain/uuid-v7.js';
import { InMemoryOutboxStore, OperationsOutboxDispatcher, PrismaOperationsOutboxStore } from '../src/adapters/operations-outbox.dispatcher.js';

const EVENT = {
  id: '01990f24-2ba2-7000-8000-000000000001',
  type: 'operations.package.published.v1', version: 1,
  occurredAt: '2026-08-31T12:00:00.000Z', traceId: '0123456789abcdef0123456789abcdef',
  correlationId: '01990f24-2ba2-7000-8000-000000000002', producer: 'operations-service', data: { packageId: 'p1' },
} as const;

describe('frozen supporting-service boundaries', () => {
  it('generates monotonic UUIDv7 identifiers', () => {
    const next = createUuidV7Generator(() => 1_788_171_200_000, () => new Uint8Array(10));
    const ids = [next(), next(), next()];
    expect(ids.every(isUuidV7)).toBe(true);
    expect(ids).toEqual([...ids].sort());
    expect(isUuidV7('01990f24-2ba2-7000-0000-000000000001')).toBe(false);
    expect(isUuidV7('01990f24-2ba2-7000-8000-000000000001')).toBe(true);
  });

  it('publishes the exact frozen EventEnvelope without reshaping it', async () => {
    expect(EventEnvelopeSchema.parse(EVENT)).toEqual(EVENT);
    const store = new InMemoryOutboxStore([EVENT]);
    const publisher = { publish: vi.fn(() => Promise.resolve()) };
    const dispatcher = new OperationsOutboxDispatcher(store, publisher, () => new Date(EVENT.occurredAt), () => EVENT.correlationId);
    await dispatcher.dispatch(EVENT.id);
    expect(publisher.publish).toHaveBeenCalledWith(EVENT);
  });

  it('normalizes a realistic Prisma null causationId out of the exact envelope', async () => {
    const raw = { ...EVENT, causationId: null, occurredAt: new Date(EVENT.occurredAt), status: 'PENDING', attempts: 0,
      nextAttemptAt: new Date(EVENT.occurredAt), claimToken: null, leaseUntil: null, lastError: null,
      createdAt: new Date(EVENT.occurredAt), publishedAt: null };
    const store = new PrismaOperationsOutboxStore({ $transaction: async (work) => work({
      outboxEvent: { findUnique: () => Promise.resolve(raw), updateMany: () => Promise.resolve({ count: 1 }) },
    }) });
    const publisher = { publish: vi.fn(() => Promise.resolve()) };
    const dispatcher = new OperationsOutboxDispatcher(store, publisher, () => new Date(EVENT.occurredAt), () => EVENT.correlationId);
    await dispatcher.dispatch(EVENT.id);
    const published = (publisher.publish.mock.calls as unknown[][])[0]?.[0];
    expect(EventEnvelopeSchema.parse(published)).toEqual(EVENT);
    expect(published).not.toHaveProperty('causationId');
  });
});
