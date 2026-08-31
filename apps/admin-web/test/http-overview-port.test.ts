/* eslint-disable @typescript-eslint/require-await -- fetch fakes implement the platform contract. */
import { describe, expect, it } from 'vitest';

import { createHttpOverviewPort } from '../lib/http-overview-port';
import { createOutboundRequestContext } from '../lib/outbound-request-context';

const environment = {
  apiUrl: 'https://reporting.example.invalid',
  kmsIdentityReference: 'kms://service/admin-web',
};
const sourceTimestamp = '2026-08-31T08:00:00.000Z';
const requestContext = createOutboundRequestContext(
  () => '0123456789abcdef0123456789abcdef',
  () => '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f',
);

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, status: 200 });
}

function payload() {
  return { datasets: [
    { id: 'operations', label: '用户与点数', sourceTimestamp, status: 'READY', measures: [
      { id: 'registrations', label: '注册用户', value: '9007199254740993' }, { id: 'active-users', label: '活跃用户', value: '42' }, { id: 'recharge-points', label: '充值点数', value: '1234567890123456789025' }, { id: 'consumption-points', label: '消耗点数', value: '432150' },
    ] },
    { id: 'tasks', label: '任务与队列', sourceTimestamp, status: 'READY', measures: [
      { id: 'task-count', label: '任务数', value: '1234' }, { id: 'success-rate', label: '成功率', value: '99.95%' }, { id: 'average-generation-duration', label: '平均生成时长', unit: 'SECONDS', value: '12' }, { id: 'queue-backlog', label: '队列积压', value: '8' },
    ] },
    { id: 'finance', label: '财务', sourceTimestamp, status: 'READY', measures: [
      { currency: 'CNY', id: 'income', label: '收入', minorUnits: '1000000' }, { currency: 'CNY', id: 'provider-cost', label: '供应商成本', minorUnits: '450000' }, { currency: 'CNY', direction: 'CREDIT', id: 'gross-margin', label: '毛利', minorUnits: '550000' }, { id: 'gross-margin-rate', label: '毛利率', value: '55.00%' }, { currency: 'CNY', id: 'average-revenue-per-user', label: '客单价', minorUnits: '23810' }, { id: 'repeat-purchase-rate', label: '复购率', value: '42.50%' },
    ] },
    { id: 'supplier-risk', label: '供应商与风险', sourceTimestamp, status: 'READY', measures: [
      { id: 'supplier-balance', label: '供应商余额', value: '0' }, { id: 'supplier-failure-rate', label: '供应商失败率', value: '0.00%' }, { id: 'payment-anomalies', label: '支付异常', value: '0' }, { id: 'service-alerts', label: '服务告警', value: '0' },
    ] },
  ] };
}

describe('HTTP overview port', () => {
  it('uses HTTPS, KMS reference, server session, redirect error, and an abortable deadline for authoritative data', async () => {
    let url = '';
    let request: RequestInit | undefined;
    const port = createHttpOverviewPort(environment, {
      deadlineMs: 25,
      fetchImpl: async (input, init) => {
        url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        request = init;
        return response(payload());
      },
    });

    await expect(
      port.getOverview({ requestContext, trustedSessionToken: 'trusted-session' }),
    ).resolves.toEqual(payload());
    expect(url).toBe('https://reporting.example.invalid/v1/admin/reporting/overview');
    expect(new Headers(request?.headers).get('X-Service-Identity-Ref')).toBe(environment.kmsIdentityReference);
    expect(new Headers(request?.headers).get('X-Admin-Session-Token')).toBe('trusted-session');
    expect(new Headers(request?.headers).get('X-Trace-Id')).toBe('0123456789abcdef0123456789abcdef');
    expect(new Headers(request?.headers).get('X-Correlation-Id')).toBe('0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f');
    expect(request?.redirect).toBe('error');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails closed on malformed response shapes without coercing authoritative values', async () => {
    const events: unknown[] = [];
    const port = createHttpOverviewPort(environment, {
      fetchImpl: async () =>
        response({
          datasets: [
            {
              ...payload().datasets[0],
              measures: [{ id: 'registrations', label: '注册用户', value: 5 }],
            },
          ],
        }),
      telemetry: { record(event: unknown) { events.push(event); } },
    });

    await expect(port.getOverview({ requestContext, trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid overview response');
    expect(events).toEqual([{ ...requestContext, operation: 'overview.read', reason: 'MALFORMED_RESPONSE' }]);
  });

  it('rejects overlong optional source warnings before rendering them', async () => {
    const events: unknown[] = [];
    const malformedPayload = payload();
    const supplierRisk = malformedPayload.datasets[3];
    if (!supplierRisk) throw new Error('missing supplier-risk fixture');
    Object.assign(supplierRisk, { warning: 'x'.repeat(513) });
    const port = createHttpOverviewPort(environment, {
      fetchImpl: async () => response(malformedPayload),
      telemetry: { record(event: unknown) { events.push(event); } },
    });

    await expect(
      port.getOverview({ requestContext, trustedSessionToken: 'trusted-session' }),
    ).rejects.toThrow('Invalid overview response');
    expect(events).toEqual([{ ...requestContext, operation: 'overview.read', reason: 'MALFORMED_RESPONSE' }]);
  });

  it.each(['dataset-label', 'measure-label', 'warning', 'symbol-separated-warning', 'control-separated-warning'])(
    'rejects phone-like overview render text in %s',
    async (field) => {
      const malformedPayload = payload();
      const operations = malformedPayload.datasets[0];
      if (!operations) throw new Error('missing operations fixture');
      if (field === 'dataset-label') operations.label = '用户-13800138000';
      if (field === 'measure-label') { const measure = operations.measures[0]; if (!measure) throw new Error('missing measure fixture'); measure.label = '+86 138-0013-8000'; }
      if (field === 'warning') Object.assign(operations, { status: 'STALE', warning: '告警-１３８００１３８０００' });
      if (field === 'symbol-separated-warning') Object.assign(operations, { status: 'STALE', warning: '告警-138😀0013🚀8000' });
      if (field === 'control-separated-warning') Object.assign(operations, { status: 'STALE', warning: '告警-138\u00000013\ue0008000' });
      const port = createHttpOverviewPort(environment, { fetchImpl: async () => response(malformedPayload) });
      await expect(port.getOverview({ requestContext, trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid overview response');
    },
  );

  it.each(
    ['recharge-points', 'consumption-points', 'supplier-balance'].flatMap((metricId) =>
      ['1.5', '-1', '01'].map((value) => [metricId, value] as const),
    ),
  )('rejects malformed frozen point metric %s=%s', async (metricId, value) => {
    const malformedPayload = payload();
    for (const dataset of malformedPayload.datasets) {
      const metric = dataset.measures.find((candidate) => candidate.id === metricId);
      if (metric) metric.value = value;
    }
    const port = createHttpOverviewPort(environment, { fetchImpl: async () => response(malformedPayload) });
    await expect(port.getOverview({ requestContext, trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid overview response');
  });

  it.each(
    ['registrations', 'active-users', 'task-count', 'queue-backlog', 'payment-anomalies', 'service-alerts'].flatMap((metricId) =>
      ['1.5', '-1', '01', 'NaN'].map((value) => [metricId, value] as const),
    ),
  )('rejects malformed authoritative count metric %s=%s', async (metricId, value) => {
    const malformedPayload = payload();
    for (const dataset of malformedPayload.datasets) {
      const metric = dataset.measures.find((candidate) => candidate.id === metricId);
      if (metric) metric.value = value;
    }
    const port = createHttpOverviewPort(environment, { fetchImpl: async () => response(malformedPayload) });
    await expect(port.getOverview({ requestContext, trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid overview response');
  });

  it.each(
    ['success-rate', 'supplier-failure-rate', 'gross-margin-rate', 'repeat-purchase-rate'].flatMap((metricId) =>
      ['-1.00%', '101.00%', '01.00%', '1.000%', 'NaN%', '1%'].map((value) => [metricId, value] as const),
    ),
  )('rejects malformed authoritative rate metric %s=%s', async (metricId, value) => {
    const malformedPayload = payload();
    for (const dataset of malformedPayload.datasets) {
      const metric = dataset.measures.find((candidate) => candidate.id === metricId);
      if (metric) metric.value = value;
    }
    const port = createHttpOverviewPort(environment, { fetchImpl: async () => response(malformedPayload) });
    await expect(port.getOverview({ requestContext, trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid overview response');
  });

  it.each([
    [{ value: '12.4' }, 'fractional duration'],
    [{ value: '-1' }, 'negative duration'],
    [{ value: '01' }, 'leading-zero duration'],
    [{ value: 'NaN' }, 'NaN duration'],
    [{ unit: undefined }, 'missing duration unit'],
    [{ unit: 'MILLISECONDS' }, 'invalid duration unit'],
  ])('rejects %s', async (override, description) => {
    expect(description).not.toHaveLength(0);
    const malformedPayload = payload();
    const tasks = malformedPayload.datasets.find((dataset) => dataset.id === 'tasks');
    const duration = tasks?.measures.find((candidate) => candidate.id === 'average-generation-duration');
    if (!duration) throw new Error('missing duration fixture');
    Object.assign(duration, override);
    const port = createHttpOverviewPort(environment, { fetchImpl: async () => response(malformedPayload) });
    await expect(port.getOverview({ requestContext, trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid overview response');
  });

  it.each([
    ['income decimal minor units', 'income', { minorUnits: '100.00' }],
    ['provider cost signed minor units', 'provider-cost', { minorUnits: '-1' }],
    ['average order value leading zero', 'average-revenue-per-user', { minorUnits: '01' }],
    ['income missing currency', 'income', { currency: undefined }],
    ['provider cost invalid currency', 'provider-cost', { currency: 'RMB' }],
    ['gross margin signed minor units', 'gross-margin', { minorUnits: '-550000' }],
    ['gross margin missing direction', 'gross-margin', { direction: undefined }],
    ['gross margin invalid direction', 'gross-margin', { direction: 'NEGATIVE' }],
    ['regular money with direction', 'income', { direction: 'CREDIT' }],
  ])('rejects malformed authoritative finance amount: %s', async (_name, metricId, override) => {
    const malformedPayload = payload();
    const finance = malformedPayload.datasets.find((dataset) => dataset.id === 'finance');
    const measure = finance?.measures.find((candidate) => candidate.id === metricId);
    if (!measure) throw new Error('missing finance fixture');
    Object.assign(measure, override);
    const port = createHttpOverviewPort(environment, { fetchImpl: async () => response(malformedPayload) });
    await expect(port.getOverview({ requestContext, trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid overview response');
  });

  it.each(['-1%', '+1%', '01%', '100.01%', '55.000%', 'NaN%'])(
    'rejects malformed finance rate %s',
    async (value) => {
      const malformedPayload = payload();
      const finance = malformedPayload.datasets.find((dataset) => dataset.id === 'finance');
      const measure = finance?.measures.find((candidate) => candidate.id === 'gross-margin-rate');
      if (!measure) throw new Error('missing rate fixture');
      measure.value = value;
      const port = createHttpOverviewPort(environment, { fetchImpl: async () => response(malformedPayload) });
    await expect(port.getOverview({ requestContext, trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid overview response');
    },
  );

  it.each(
    ['operations', 'tasks', 'finance', 'supplier-risk'].flatMap((datasetId) =>
      ['2026-08-31T16:00:00+08:00', '2026-08-31T08:00:00', '2026-02-30T08:00:00Z'].map((timestamp) => [datasetId, timestamp] as const),
    ),
  )(
    'rejects non-canonical or invalid UTC source timestamp for %s: %s',
    async (datasetId, timestamp) => {
      const malformedPayload = payload();
      const dataset = malformedPayload.datasets.find((candidate) => candidate.id === datasetId);
      if (!dataset) throw new Error('missing overview fixture');
      dataset.sourceTimestamp = timestamp;
      const port = createHttpOverviewPort(environment, { fetchImpl: async () => response(malformedPayload) });
    await expect(port.getOverview({ requestContext, trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid overview response');
    },
  );

  it('fails closed on response body timeout and emits sanitized telemetry', async () => {
    const events: unknown[] = [];
    const port = createHttpOverviewPort(environment, {
      deadlineMs: 1,
      fetchImpl: async (_input, init) =>
        ({
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('timed out', 'AbortError'));
              });
            }),
        }) as Response,
      telemetry: { record(event: unknown) { events.push(event); } },
    });

    await expect(port.getOverview({ requestContext, trustedSessionToken: 'sensitive-session' })).rejects.toThrow();
    expect(events).toEqual([{ ...requestContext, operation: 'overview.read', reason: 'TIMEOUT' }]);
    expect(JSON.stringify(events)).not.toContain('sensitive-session');
  });
});
