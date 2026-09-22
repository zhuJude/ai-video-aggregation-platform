import { describe, expect, it } from 'vitest';
import {
  InMemoryProviderHealthStore,
  ProviderHealthConsumer,
} from '../src/application/provider-health.consumer.js';
import {
  AuthenticatedCatalogModelControl,
  MarginGuardJob,
  type CatalogModelControl,
  type MarginRiskPublisher,
  type MarginRuleSource,
} from '../src/application/margin-guard.job.js';

describe('provider health snapshots', () => {
  it('deduplicates messages and stores only the latest monotonic snapshot', async () => {
    const store = new InMemoryProviderHealthStore();
    const consumer = new ProviderHealthConsumer(store);
    const base = {
      eventType: 'provider.health-updated.v1' as const,
      providerId: 'provider-1',
      health: 'HEALTHY' as const,
      balanceLow: false,
      quotaExhausted: false,
      circuitOpen: false,
      occurredAt: '2026-08-31T00:00:00.000Z',
    };

    expect(await consumer.consume({ ...base, messageId: 'message-2', sequence: 2 })).toBe(
      'APPLIED',
    );
    expect(await consumer.consume({ ...base, messageId: 'message-2', sequence: 2 })).toBe(
      'DUPLICATE',
    );
    expect(await consumer.consume({ ...base, messageId: 'message-1', sequence: 1 })).toBe('STALE');
    expect(store.get('provider-1')?.sequence).toBe(2);
  });

  it('replaces a snapshot only with a newer sequence', async () => {
    const store = new InMemoryProviderHealthStore();
    const consumer = new ProviderHealthConsumer(store);

    await consumer.consume({
      eventType: 'provider.health-updated.v1',
      messageId: 'message-1',
      providerId: 'provider-1',
      sequence: 1,
      health: 'HEALTHY',
      balanceLow: false,
      quotaExhausted: false,
      circuitOpen: false,
      occurredAt: '2026-08-31T00:00:00.000Z',
    });
    await consumer.consume({
      eventType: 'provider.health-updated.v1',
      messageId: 'message-2',
      providerId: 'provider-1',
      sequence: 2,
      health: 'UNHEALTHY',
      balanceLow: true,
      quotaExhausted: true,
      circuitOpen: true,
      occurredAt: '2026-08-31T00:01:00.000Z',
    });

    expect(store.get('provider-1')).toMatchObject({
      sequence: 2,
      health: 'UNHEALTHY',
      balanceLow: true,
    });
  });
});

describe('margin guard', () => {
  it('disables a model when published provider cost makes every sale rule unprofitable', async () => {
    const disabled: Array<{ modelId: string; reason: string }> = [];
    const events: Array<{ eventType: string; modelId: string }> = [];
    const source: MarginRuleSource = {
      listActiveModels: () =>
        Promise.resolve([
          {
            modelId: 'model-1',
            costPoints: 80n,
            salePoints: [80n, 90n],
            minimumMarginBasisPoints: 2000,
            costRuleVersion: 4,
          },
        ]),
    };
    const catalog: CatalogModelControl = {
      disableModel: (modelId, reason) => {
        disabled.push({ modelId, reason });
        return Promise.resolve();
      },
    };
    const publisher: MarginRiskPublisher = {
      publish: (event) => {
        events.push({ eventType: event.eventType, modelId: event.modelId });
        return Promise.resolve();
      },
    };

    await new MarginGuardJob(source, catalog, publisher).run();

    expect(disabled).toEqual([{ modelId: 'model-1', reason: 'MARGIN_BELOW_MINIMUM' }]);
    expect(events).toEqual([{ eventType: 'routing.margin-risk-detected.v1', modelId: 'model-1' }]);
  });

  it('keeps a model active when at least one published sale rule is profitable', async () => {
    let disableCount = 0;
    const source: MarginRuleSource = {
      listActiveModels: () =>
        Promise.resolve([
          {
            modelId: 'model-1',
            costPoints: 50n,
            salePoints: [60n, 100n],
            minimumMarginBasisPoints: 2000,
            costRuleVersion: 4,
          },
        ]),
    };
    const catalog: CatalogModelControl = {
      disableModel: () => {
        disableCount += 1;
        return Promise.resolve();
      },
    };
    const publisher: MarginRiskPublisher = { publish: () => Promise.resolve() };

    await new MarginGuardJob(source, catalog, publisher).run();

    expect(disableCount).toBe(0);
  });

  it('authenticates the internal catalog disable request', async () => {
    const requests: Array<{ url: string; authorization: string | null; body: string }> = [];
    const catalog = new AuthenticatedCatalogModelControl(
      'http://catalog.internal',
      { getToken: () => Promise.resolve('service-token') },
      (input, init) => {
        const headers = new Headers(init?.headers);
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (typeof init?.body !== 'string') throw new Error('expected string request body');
        requests.push({
          url,
          authorization: headers.get('authorization'),
          body: init.body,
        });
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    );

    await catalog.disableModel('model-1', 'MARGIN_BELOW_MINIMUM');

    expect(requests).toEqual([
      {
        url: 'http://catalog.internal/internal/models/model-1/disable',
        authorization: 'Bearer service-token',
        body: JSON.stringify({ reason: 'MARGIN_BELOW_MINIMUM' }),
      },
    ]);
  });
});
