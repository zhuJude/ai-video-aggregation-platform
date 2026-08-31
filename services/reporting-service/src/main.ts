import { registeredTracing } from '@repo/observability/tracing/register';
import { createSafeLogger } from '@repo/observability';
import { Pool } from 'pg';
import { ExportService } from './application/export.service.js';
import { ReportQueryService } from './http/reports.controller.js';
import {
  PostgresHealthProbe,
  PostgresReportingReader,
  type SqlClient,
} from './infrastructure/postgres.js';
import {
  HttpAuditSink,
  HttpConsumerHealthProbe,
  HttpPrivateAssetStore,
} from './infrastructure/service-adapters.js';
import { ReportingRuntimeMetrics, RuntimeReadiness, buildRuntimeApp } from './runtime/runtime.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`Required configuration is missing: ${name}`);
  return value;
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

const logger = createSafeLogger({
  service: 'reporting-service',
  environment: process.env.DEPLOYMENT_ENVIRONMENT ?? 'local',
  version: process.env.SERVICE_VERSION ?? 'development',
  successSampleRate: Number(process.env.LOG_SUCCESS_SAMPLE_RATE ?? '0.1'),
});

async function start(): Promise<void> {
  const pool = new Pool({
    connectionString: requiredEnvironment('DATABASE_URL'),
    max: positiveIntegerEnvironment('DATABASE_POOL_MAX', 10),
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: true },
  });
  const sql: SqlClient = {
    async query(text, values) {
      const result = await pool.query(text, values as unknown[] | undefined);
      return { rows: result.rows as Array<Record<string, unknown>> };
    },
  };
  const reader = new PostgresReportingReader(sql);
  const queries = new ReportQueryService(reader);
  const serviceToken = requiredEnvironment('INTERNAL_SERVICE_TOKEN');
  const exports = new ExportService(
    queries,
    new HttpPrivateAssetStore(requiredEnvironment('REPORTING_ASSET_SERVICE_URL'), serviceToken),
    new HttpAuditSink(requiredEnvironment('REPORTING_AUDIT_SERVICE_URL'), serviceToken),
  );
  const metrics = new ReportingRuntimeMetrics();
  const readiness = new RuntimeReadiness(
    {
      database: new PostgresHealthProbe(sql),
      consumer: new HttpConsumerHealthProbe(requiredEnvironment('ROCKETMQ_CONSUMER_HEALTH_URL')),
      projection: reader,
    },
    metrics,
    {
      hardLagLimitSeconds: positiveIntegerEnvironment('PROJECTION_HARD_LAG_SECONDS', 120),
    },
  );
  const app = buildRuntimeApp({ queries, exports, metrics, readiness });
  const exportWorker = setInterval(() => {
    void exports.runNext().catch((error: unknown) => {
      logger.error(
        { err: error, errorCode: 'REPORT_EXPORT_WORKER_FAILED' },
        'export worker failed',
      );
    });
  }, 1_000);
  exportWorker.unref();

  const shutdown = async (signal: string): Promise<void> => {
    clearInterval(exportWorker);
    logger.info({ signal }, 'reporting service shutting down');
    await app.close();
    await pool.end();
    await registeredTracing.shutdown();
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  const port = positiveIntegerEnvironment('PORT', 3000);
  await app.listen({ host: '0.0.0.0', port });
  logger.info({ port }, 'reporting service started');
}

void start().catch(async (error: unknown) => {
  logger.error(
    { err: error, errorCode: 'REPORTING_START_FAILED' },
    'reporting service failed to start',
  );
  await registeredTracing.shutdown();
  process.exitCode = 1;
});
