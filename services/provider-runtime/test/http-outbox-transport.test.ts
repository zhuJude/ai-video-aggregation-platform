import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { ProviderHttpOutboxTransport } from '../src/runtime/http-outbox-transport.js';
import { ProviderRuntimeMetrics } from '../src/runtime/operations.js';
import { createProductionProviderComposition } from '../src/runtime/production-composition.js';

const NOW = new Date('2026-09-17T00:00:00.000Z');
const row = {
  id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c2',
  eventType: 'provider.execution-running.v1',
  eventVersion: 1,
  deduplicationKey: null,
  payload: {
    executionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
    taskId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
  },
  headers: {
    traceId: 'b'.repeat(32),
    correlationId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
    producer: 'provider-runtime',
  },
  occurredAt: NOW,
  attempts: 2,
};

function fixture(fetcher: typeof fetch, rows: readonly (typeof row)[] = [row]) {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const findMany = vi.fn().mockResolvedValue(rows);
  const prisma = { outboxEvent: { findMany, updateMany } } as unknown as PrismaClient;
  return {
    findMany,
    updateMany,
    transport: new ProviderHttpOutboxTransport(prisma, {
      publishUrl: new URL('http://transport/publish'),
      readyUrl: new URL('http://transport/ready'),
      bearerToken: 'internal-service-token-value-000001',
      fetcher,
      now: () => NOW,
    }),
  };
}

describe('ProviderHttpOutboxTransport', () => {
  it('is the bundled composition default and requires explicit full endpoint URLs', async () => {
    const environment = {
      MOCK_PROVIDER_ID: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a7',
      MOCK_PROVIDER_MODEL_CODE: 'mock-video-v1',
      MOCK_PROVIDER_URL: 'http://mock-provider:3002',
      MOCK_PROVIDER_CALLBACK_SECRET: 'test-secret',
      INTERNAL_SERVICE_AUTH_TOKEN: 'internal-service-token-value-000001',
    };
    const overrides = {
      prisma: {} as PrismaClient,
      dispatch: { resolve: vi.fn() },
      controlAdapter: { cancelTask: vi.fn() },
    };
    expect(() =>
      createProductionProviderComposition(environment, new ProviderRuntimeMetrics(), overrides),
    ).toThrow('MESSAGE_TRANSPORT_PUBLISH_URL_REQUIRED');

    const composition = await createProductionProviderComposition(
      {
        ...environment,
        MESSAGE_TRANSPORT_PUBLISH_URL: 'http://transport/publish',
        MESSAGE_TRANSPORT_READY_URL: 'http://transport/ready',
      },
      new ProviderRuntimeMetrics(),
      overrides,
    );
    await composition.close();
  });

  it('coalesces concurrent publishers and uses the event id as the fallback idempotency key', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const subject = fixture(fetcher as unknown as typeof fetch);

    await expect(
      Promise.all([subject.transport.publishPending(), subject.transport.publishPending()]),
    ).resolves.toEqual([{ published: 1 }, { published: 1 }]);

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe('http://transport/publish');
    expect(request.headers).toMatchObject({
      authorization: 'Bearer internal-service-token-value-000001',
      'idempotency-key': row.id,
    });
    const findManyInput = subject.findMany.mock.calls[0]?.[0] as unknown as {
      readonly where: { readonly attempts: { readonly lt: number }; readonly publishedAt: null };
    };
    expect(findManyInput.where).toMatchObject({ attempts: { lt: 10 }, publishedAt: null });
    if (typeof request.body !== 'string') throw new Error('EXPECTED_STRING_BODY');
    expect(JSON.parse(request.body)).toMatchObject({
      id: row.id,
      type: row.eventType,
      version: 1,
      data: row.payload,
    });
    expect(subject.updateMany).toHaveBeenCalledWith({
      where: { id: row.id, publishedAt: null, attempts: 2 },
      data: { publishedAt: NOW, attempts: { increment: 1 }, lastError: null },
    });
  });

  it('persists transport failures without marking the event published', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('secret transport detail'));
    const subject = fixture(fetcher as unknown as typeof fetch);

    await expect(subject.transport.publishPending()).resolves.toEqual({ published: 0 });
    expect(subject.updateMany).toHaveBeenCalledWith({
      where: { id: row.id, publishedAt: null, attempts: 2 },
      data: { attempts: { increment: 1 }, lastError: 'TRANSPORT_REQUEST_FAILED' },
    });
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
    const subject = fixture(fetcher as unknown as typeof fetch, [poison, later]);

    await expect(subject.transport.publishPending()).resolves.toEqual({ published: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(subject.updateMany).toHaveBeenCalledWith({
      where: { id: poison.id, publishedAt: null, attempts: 9 },
      data: { attempts: { increment: 1 }, lastError: 'INVALID_EVENT_ENVELOPE' },
    });
  });

  it('probes readiness fail-closed', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const subject = fixture(fetcher as unknown as typeof fetch);

    await expect(subject.transport.ready()).resolves.toBe(true);
    await expect(subject.transport.ready()).resolves.toBe(false);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: 'Bearer internal-service-token-value-000001' },
    });
  });
});
