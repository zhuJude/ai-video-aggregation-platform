/* eslint-disable @typescript-eslint/require-await -- focused in-memory Prisma seams deliberately resolve synchronously. */
import { describe, expect, it, vi } from 'vitest';
import {
  AssetOutboxJob,
  PrismaOutboxDispatcher,
} from '../src/adapters/prisma-outbox.dispatcher.js';

function makeHarness(status: 'PENDING' | 'FAILED' | 'PUBLISHED', leaseUntil: Date | null = null) {
  const row = {
    id: 'event-1',
    eventType: 'asset.imported.v1',
    payload: { assetId: 'asset-1' },
    status,
    claimToken: null as string | null,
    leaseUntil,
    attempts: 0,
    nextAttemptAt: new Date('2026-08-31T00:00:00.000Z'),
  };
  const client = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        outboxEvent: {
          findUnique: async () => row,
          findMany: async () => (row.status !== 'PUBLISHED' ? [{ id: row.id }] : []),
          updateMany: async ({
            where,
            data,
          }: {
            where: { claimToken?: string };
            data: Record<string, unknown>;
          }) => {
            if (where.claimToken !== undefined && row.claimToken !== where.claimToken)
              return { count: 0 };
            Object.assign(
              row,
              data,
              data.attempts === undefined ? {} : { attempts: row.attempts + 1 },
            );
            return { count: 1 };
          },
        },
      }),
  };
  return { row, client };
}

describe('PrismaOutboxDispatcher', () => {
  it('claims, publishes and marks one event exactly once across replay', async () => {
    const { row, client } = makeHarness('PENDING');
    const publish = vi.fn(async (event: unknown) => {
      void event;
    });
    const dispatcher = new PrismaOutboxDispatcher(
      client as never,
      { publish },
      () => 'claim',
      () => new Date('2026-08-31T00:00:00.000Z'),
    );
    await dispatcher.dispatch('event-1');
    await dispatcher.dispatch('event-1');
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith({
      id: 'event-1',
      type: 'asset.imported.v1',
      payload: { assetId: 'asset-1' },
    });
    const published = publish.mock.calls[0]?.[0];
    expect(published).toBeDefined();
    expect(Object.keys(published as object).sort()).toEqual(['id', 'payload', 'type']);
    expect(row).toMatchObject({ status: 'PUBLISHED', claimToken: null, leaseUntil: null });
  });

  it('records a publish failure for durable retry and rethrows to the best-effort caller', async () => {
    const { row, client } = makeHarness('PENDING');
    const dispatcher = new PrismaOutboxDispatcher(
      client as never,
      {
        publish: vi.fn(async () => {
          throw new Error('broker offline');
        }),
      },
      () => 'claim',
      () => new Date('2026-08-31T00:00:00.000Z'),
    );
    await expect(dispatcher.dispatch('event-1')).rejects.toThrow(/broker offline/);
    expect(row).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'EVENT_PUBLISH_FAILED',
      claimToken: null,
      leaseUntil: null,
    });
  });

  it('does not publish while another worker owns a live lease', async () => {
    const { client } = makeHarness('PENDING', new Date('2026-08-31T00:01:00.000Z'));
    const publish = vi.fn(async () => undefined);
    const dispatcher = new PrismaOutboxDispatcher(
      client as never,
      { publish },
      () => 'claim',
      () => new Date('2026-08-31T00:00:00.000Z'),
    );
    await dispatcher.dispatch('event-1');
    expect(publish).not.toHaveBeenCalled();
  });

  it('recovers the commit-after-crash window by scanning pending rows', async () => {
    const { row, client } = makeHarness('PENDING');
    const publish = vi.fn(async () => undefined);
    const dispatcher = new PrismaOutboxDispatcher(
      client as never,
      { publish },
      () => 'claim',
      () => new Date('2026-08-31T00:00:00.000Z'),
    );
    await expect(new AssetOutboxJob(dispatcher).run()).resolves.toBe(1);
    expect(publish).toHaveBeenCalledOnce();
    expect(row.status).toBe('PUBLISHED');
  });

  it('backs off a broker failure and replays only when due', async () => {
    const { row, client } = makeHarness('PENDING');
    let now = new Date('2026-08-31T00:00:00.000Z');
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const dispatcher = new PrismaOutboxDispatcher(
      client as never,
      { publish },
      () => 'claim',
      () => now,
    );
    await expect(dispatcher.dispatch('event-1')).rejects.toThrow('offline');
    expect(row.nextAttemptAt).toEqual(new Date('2026-08-31T00:00:01.000Z'));
    await dispatcher.dispatch('event-1');
    expect(publish).toHaveBeenCalledTimes(1);
    now = new Date('2026-08-31T00:00:01.000Z');
    await expect(dispatcher.dispatchDue()).resolves.toBe(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(row.status).toBe('PUBLISHED');
  });
});
