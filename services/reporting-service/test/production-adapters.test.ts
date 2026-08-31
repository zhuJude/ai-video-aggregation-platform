import { describe, expect, it, vi } from 'vitest';
import {
  PostgresHealthProbe,
  PostgresReportingReader,
  type SqlClient,
} from '../src/infrastructure/postgres.js';
import {
  HttpAuditSink,
  HttpConsumerHealthProbe,
  HttpPrivateAssetStore,
} from '../src/infrastructure/service-adapters.js';

describe('PostgreSQL runtime adapters', () => {
  it('maps database bigint and timestamp values without precision loss', async () => {
    const client: SqlClient = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            date: '2026-08-28',
            rechargePoints: '9007199254740993',
            rechargeAmountMinor: '10000',
            consumedPoints: '1200',
            revenueMinor: '1200',
            providerCostMinor: '700',
            marginNumeratorMinor: '500',
            marginDenominatorMinor: '1200',
            successfulTasks: '1',
            failedTasks: '0',
            taskDurationMsTotal: '45000',
            taskDurationSamples: '1',
          },
        ],
      }),
    };
    const reader = new PostgresReportingReader(client);
    expect(await reader.allDailyMetrics()).toMatchObject([
      { rechargePoints: 9_007_199_254_740_993n, revenueMinor: 1_200n, successfulTasks: 1 },
    ]);
  });

  it('reports database health without exposing connection errors', async () => {
    const healthy = new PostgresHealthProbe({
      query: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }),
    });
    const unhealthy = new PostgresHealthProbe({
      query: vi.fn().mockRejectedValue(new Error('password=secret')),
    });
    await expect(healthy.check()).resolves.toBe(true);
    await expect(unhealthy.check()).resolves.toBe(false);
  });
});

describe('internal service adapters', () => {
  it('checks consumer health and writes private assets and audit events', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requests.push({
          url: input instanceof Request ? input.url : input.toString(),
          ...(init === undefined ? {} : { init }),
        });
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    );
    const consumer = new HttpConsumerHealthProbe(
      'http://rocketmq-health.local/consumer',
      fetchImplementation,
    );
    const assets = new HttpPrivateAssetStore(
      'http://asset-service.local',
      'service-token',
      fetchImplementation,
    );
    const audit = new HttpAuditSink(
      'http://iam-service.local',
      'service-token',
      fetchImplementation,
    );

    await expect(consumer.check()).resolves.toBe(true);
    await assets.putPrivate({
      objectKey: 'private/report.csv',
      body: 'a,b\r\n1,2',
      expiresAt: '2026-08-28T03:15:00.000Z',
    });
    await audit.record({ action: 'REPORT_EXPORT_CREATED', exportId: 'export-1' });

    expect(requests).toHaveLength(3);
    expect(requests[1]?.init).toMatchObject({ method: 'POST' });
    const assetBody = requests[1]?.init?.body;
    expect(typeof assetBody).toBe('string');
    if (typeof assetBody !== 'string') throw new Error('Expected JSON string body');
    expect(assetBody).toContain('contentBase64');
    expect(requests[2]?.url).toContain('/internal/audit/events');
  });
});
