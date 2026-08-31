import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ExportService,
  type AuditSink,
  type PrivateAssetStore,
} from '../src/application/export.service.js';
import { InMemoryProjectionStore } from '../src/application/projector.js';
import { ReportQueryService } from '../src/http/reports.controller.js';
import {
  ReportingRuntimeMetrics,
  RuntimeReadiness,
  buildRuntimeApp,
} from '../src/runtime/runtime.js';

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

class NoopAssets implements PrivateAssetStore {
  putPrivate(): Promise<void> {
    return Promise.resolve();
  }
}

class NoopAudit implements AuditSink {
  record(): Promise<void> {
    return Promise.resolve();
  }
}

describe('reporting production runtime', () => {
  let databaseHealthy = true;
  let consumerHealthy = true;
  let projectedThrough = '2026-08-28T02:59:30.000Z';
  const now = () => new Date('2026-08-28T03:00:00.000Z');
  const store = new InMemoryProjectionStore();
  const queries = new ReportQueryService(store, now);
  const exports = new ExportService(queries, new NoopAssets(), new NoopAudit(), now);
  const metrics = new ReportingRuntimeMetrics();
  const readiness = new RuntimeReadiness(
    {
      database: { check: () => Promise.resolve(databaseHealthy) },
      consumer: { check: () => Promise.resolve(consumerHealthy) },
      projection: { projectedThrough: () => Promise.resolve(projectedThrough) },
    },
    metrics,
    { hardLagLimitSeconds: 120, now },
  );
  const app = buildRuntimeApp({ queries, exports, metrics, readiness });

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps liveness independent from dependencies', async () => {
    databaseHealthy = false;
    consumerHealthy = false;
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('requires database, consumer and bounded projection lag for readiness', async () => {
    databaseHealthy = true;
    consumerHealthy = true;
    projectedThrough = '2026-08-28T02:59:30.000Z';
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);

    projectedThrough = '2026-08-28T02:55:00.000Z';
    const stale = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(stale.statusCode).toBe(503);
    expect(stale.json()).toMatchObject({
      status: 'not_ready',
      checks: { database: true, consumer: true, projectionFresh: false },
    });
  });

  it('exports projection lag, rebuild, event error and report latency metrics', async () => {
    metrics.setRebuildStatus('RUNNING');
    metrics.markProjectionError('generation.task-settled.v1', 'INVALID_EVENT');
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('reporting_service_projection_lag_seconds');
    expect(response.body).toContain('reporting_service_projection_rebuild_status');
    expect(response.body).toContain('reporting_service_projection_event_errors_total');
    expect(response.body).toContain('reporting_service_report_query_duration_seconds');
  });
});

describe('production image and runbook', () => {
  it('runs the final container as a non-root user', async () => {
    const dockerfile = await readFile(resolve(serviceRoot, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^USER\s+(?!root\b)\S+/m);
    expect(dockerfile).toContain('/health/live');
  });

  it.each([
    'Missing telemetry',
    'High-cardinality prevention',
    'Projection lag',
    'Poison event',
    'Projection rebuild',
    'Dashboard deployment',
    'Alert testing',
    'P0/P1 routing',
    'Log access approval',
    'Read-only reconciliation queries',
    'Rollback',
  ])('documents %s', async (section) => {
    const runbook = await readFile(
      resolve(serviceRoot, '..', '..', 'docs', 'runbooks', 'observability.md'),
      'utf8',
    );
    expect(runbook).toContain(section);
  });
});
