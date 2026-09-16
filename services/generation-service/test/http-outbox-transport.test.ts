import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { GenerationHttpOutboxTransport } from '../src/runtime/http-outbox-transport.js';
import { GenerationMetrics } from '../src/runtime/operations.js';
import { createProductionGenerationComposition } from '../src/runtime/production-composition.js';

const NOW = new Date('2026-09-17T00:00:00.000Z');
const row = {
  id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c2',
  aggregateType: 'GenerationTask',
  aggregateId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
  eventType: 'generation.task-queued.v1',
  eventVersion: 1,
  deduplicationKey: 'task:queued:v1',
  payload: { taskId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0', status: 'QUEUED' },
  headers: {
    traceId: 'a'.repeat(32),
    correlationId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
    producer: 'generation-service',
  },
  occurredAt: NOW,
  attempts: 0,
};

function transportFixture(fetcher: typeof fetch, rows: readonly (typeof row)[] = [row]) {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const findMany = vi.fn().mockResolvedValue(rows);
  const transitionFindFirst = vi.fn().mockResolvedValue({
    id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c3',
    taskId: row.aggregateId,
    taskVersion: 2,
    toStatus: 'QUEUED',
    createdAt: NOW,
  });
  const prisma = {
    outboxEvent: { findMany, updateMany },
    taskTransition: { findFirst: transitionFindFirst },
  } as unknown as PrismaClient;
  return {
    findMany,
    transitionFindFirst,
    updateMany,
    transport: new GenerationHttpOutboxTransport(prisma, {
      publishUrl: new URL('http://transport/publish'),
      readyUrl: new URL('http://transport/ready'),
      bearerToken: 'internal-service-token-value-000001',
      fetcher,
      now: () => NOW,
    }),
  };
}

describe('GenerationHttpOutboxTransport', () => {
  it('is the bundled composition default and requires explicit full endpoint URLs', async () => {
    const overrides = {
      prisma: {} as PrismaClient,
      routing: { getQuote: vi.fn() },
      wallet: { reserve: vi.fn(), release: vi.fn(), settle: vi.fn() },
      asset: { requestImport: vi.fn() },
      cancellation: null,
      providerStatus: { inspect: vi.fn() },
    };
    expect(() =>
      createProductionGenerationComposition(
        {
          INTERNAL_SERVICE_AUTH_TOKEN: 'internal-service-token-value-000001',
          GATEWAY_IDENTITY_HMAC_SECRET: 'gateway-identity-secret-value-000001',
        },
        new GenerationMetrics(),
        overrides,
      ),
    ).toThrow('MESSAGE_TRANSPORT_PUBLISH_URL_REQUIRED');

    const composition = await createProductionGenerationComposition(
      {
        MESSAGE_TRANSPORT_PUBLISH_URL: 'http://transport/publish',
        MESSAGE_TRANSPORT_READY_URL: 'http://transport/ready',
        INTERNAL_SERVICE_AUTH_TOKEN: 'internal-service-token-value-000001',
        GATEWAY_IDENTITY_HMAC_SECRET: 'gateway-identity-secret-value-000001',
      },
      new GenerationMetrics(),
      overrides,
    );
    await composition.close();
  });

  it('coalesces concurrent publishers, sends the frozen envelope idempotently, and emits a wake', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const fixture = transportFixture(fetcher as unknown as typeof fetch);
    const notification = firstValueFrom(fixture.transport.transitionNotifications);

    const [first, concurrent] = await Promise.all([
      fixture.transport.publishPending(),
      fixture.transport.publishPending(),
    ]);

    expect(first).toEqual({ published: 1 });
    expect(concurrent).toEqual({ published: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [, request] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(request.headers).toMatchObject({
      authorization: 'Bearer internal-service-token-value-000001',
      'idempotency-key': row.deduplicationKey,
    });
    const findManyInput = fixture.findMany.mock.calls[0]?.[0] as unknown as {
      readonly where: { readonly attempts: { readonly lt: number }; readonly publishedAt: null };
    };
    expect(findManyInput.where).toMatchObject({ attempts: { lt: 10 }, publishedAt: null });
    if (typeof request.body !== 'string') throw new Error('EXPECTED_STRING_BODY');
    expect(JSON.parse(request.body)).toEqual({
      id: row.id,
      type: row.eventType,
      version: 1,
      occurredAt: NOW.toISOString(),
      traceId: 'a'.repeat(32),
      correlationId: row.aggregateId,
      producer: 'generation-service',
      data: row.payload,
    });
    await expect(notification).resolves.toMatchObject({
      taskId: row.aggregateId,
      taskVersion: 2,
      status: 'QUEUED',
    });
    expect(fixture.updateMany).toHaveBeenCalledWith({
      where: { id: row.id, publishedAt: null, attempts: 0 },
      data: { publishedAt: NOW, attempts: { increment: 1 }, lastError: null },
    });
  });

  it('records a bounded failure and leaves the row unpublished for retry', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const fixture = transportFixture(fetcher as unknown as typeof fetch);

    await expect(fixture.transport.publishPending()).resolves.toEqual({ published: 0 });
    expect(fixture.updateMany).toHaveBeenCalledWith({
      where: { id: row.id, publishedAt: null, attempts: 0 },
      data: { attempts: { increment: 1 }, lastError: 'TRANSPORT_HTTP_503' },
    });
    expect(fixture.transitionFindFirst).not.toHaveBeenCalled();
  });

  it('does not let a poison envelope starve a later publishable row', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const poison = {
      ...row,
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d1',
      attempts: 9,
      headers: { ...row.headers, producer: '' },
    };
    const later = { ...row, id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51d2' };
    const fixture = transportFixture(fetcher as unknown as typeof fetch, [poison, later]);

    await expect(fixture.transport.publishPending()).resolves.toEqual({ published: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fixture.updateMany).toHaveBeenCalledWith({
      where: { id: poison.id, publishedAt: null, attempts: 9 },
      data: { attempts: { increment: 1 }, lastError: 'INVALID_EVENT_ENVELOPE' },
    });
  });

  it('probes readiness fail-closed without exposing response content', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('secret', { status: 200 }))
      .mockRejectedValueOnce(new Error('credential-bearing failure'));
    const fixture = transportFixture(fetcher as unknown as typeof fetch);

    await expect(fixture.transport.ready()).resolves.toBe(true);
    await expect(fixture.transport.ready()).resolves.toBe(false);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: 'Bearer internal-service-token-value-000001' },
    });
  });
});
