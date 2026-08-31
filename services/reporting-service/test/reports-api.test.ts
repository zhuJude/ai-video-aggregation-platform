import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@repo/contracts/common';
import {
  ExportService,
  type AuditSink,
  type PrivateAssetStore,
} from '../src/application/export.service.js';
import { InMemoryProjectionStore, ReportingProjector } from '../src/application/projector.js';
import { ReportQueryService, buildReportingApp } from '../src/http/reports.controller.js';

const now = new Date('2026-08-28T03:00:00.000Z');
const permissionHeaders = {
  'x-admin-id': '01991f17-2166-7000-8000-000000000001',
  'x-admin-permissions': 'reports:read,reports:export',
};

function event(id: string, type: string, data: Record<string, unknown>): EventEnvelope {
  return {
    id,
    type,
    version: 1,
    occurredAt: '2026-08-28T02:59:30.000Z',
    traceId: 'a'.repeat(32),
    correlationId: '01991f17-2166-7000-8000-000000000002',
    producer: 'test',
    data,
  };
}

class CapturingAssets implements PrivateAssetStore {
  readonly writes: Array<{
    objectKey: string;
    body: string;
    private: boolean;
    expiresAt: string;
  }> = [];

  putPrivate(input: { objectKey: string; body: string; expiresAt: string }): Promise<void> {
    this.writes.push({ ...input, private: true });
    return Promise.resolve();
  }
}

class CapturingAudit implements AuditSink {
  readonly records: Array<Record<string, string>> = [];

  record(entry: Record<string, string>): Promise<void> {
    this.records.push(entry);
    return Promise.resolve();
  }
}

describe('reporting APIs and exports', () => {
  const store = new InMemoryProjectionStore();
  const assets = new CapturingAssets();
  const audit = new CapturingAudit();
  const queries = new ReportQueryService(store, () => now);
  const exports = new ExportService(queries, assets, audit, () => now);
  const app = buildReportingApp({ queries, exports });

  beforeAll(async () => {
    const projector = new ReportingProjector(store);
    await projector.handle(
      event('01991f17-2166-7000-8000-000000000010', 'payment.recharge-paid.v1', {
        rechargePoints: '10000',
        rechargeAmountMinor: '10000',
      }),
    );
    await projector.handle(
      event('01991f17-2166-7000-8000-000000000011', 'generation.task-settled.v1', {
        consumedPoints: '1200',
        revenueMinor: '1200',
        providerCostMinor: '700',
        providerId: '01991f17-2166-7000-8000-000000000003',
        modelId: '01991f17-2166-7000-8000-000000000004',
        durationMs: 45_000,
      }),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns point totals as strings with timezone and freshness metadata', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/internal/reports/overview?from=2026-08-01&to=2026-08-28',
      headers: permissionHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      timezone: 'Asia/Shanghai',
      totals: {
        rechargePoints: '10000',
        consumedPoints: '1200',
        revenueMinor: '1200',
        providerCostMinor: '700',
      },
      freshness: {
        projectedThrough: '2026-08-28T02:59:30.000Z',
        lagSeconds: 30,
      },
    });
  });

  it.each(['finance', 'providers', 'models', 'tasks', 'users', 'alert-summary'])(
    'serves the %s report with bounded server-side grouping',
    async (report) => {
      const response = await app.inject({
        method: 'GET',
        url: `/internal/reports/${report}?from=2026-08-01&to=2026-08-28`,
        headers: permissionHeaders,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ timezone: 'Asia/Shanghai' });
    },
  );

  it('rejects report ranges beyond the configured maximum', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/internal/reports/overview?from=2025-01-01&to=2026-08-28',
      headers: permissionHeaders,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'REPORT_RANGE_TOO_LARGE' });
  });

  it('creates a permission-checked, audited asynchronous private CSV export', async () => {
    const forbidden = await app.inject({
      method: 'POST',
      url: '/internal/reports/exports',
      headers: { 'x-admin-id': permissionHeaders['x-admin-id'] },
      payload: { report: 'overview', from: '2026-08-01', to: '2026-08-28' },
    });
    expect(forbidden.statusCode).toBe(403);

    const accepted = await app.inject({
      method: 'POST',
      url: '/internal/reports/exports',
      headers: permissionHeaders,
      payload: { report: 'overview', from: '2026-08-01', to: '2026-08-28' },
    });
    expect(accepted.statusCode).toBe(202);
    const job = accepted.json<{ id: string; status: string }>();
    expect(job.status).toBe('QUEUED');

    await exports.runNext();

    expect(exports.status(job.id)).toMatchObject({ status: 'SUCCEEDED' });
    expect(assets.writes).toHaveLength(1);
    expect(assets.writes[0]).toMatchObject({ private: true });
    expect(Date.parse(assets.writes[0]?.expiresAt ?? '') - now.getTime()).toBe(15 * 60 * 1000);
    expect(audit.records.at(-1)).toMatchObject({
      action: 'REPORT_EXPORT_CREATED',
      adminId: permissionHeaders['x-admin-id'],
      exportId: job.id,
    });
  });
});
