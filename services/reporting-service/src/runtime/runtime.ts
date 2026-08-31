import type { FastifyInstance } from 'fastify';
import {
  LowCardinalityRegistry,
  type CounterHandle,
  type GaugeHandle,
  type HistogramHandle,
} from '@repo/observability';
import type { ExportService } from '../application/export.service.js';
import { buildReportingApp, type ReportQueryService } from '../http/reports.controller.js';

export interface BooleanHealthProbe {
  check(): Promise<boolean>;
}

export interface ProjectionFreshnessProbe {
  projectedThrough(): Promise<string | undefined>;
}

export interface RuntimeDependencies {
  database: BooleanHealthProbe;
  consumer: BooleanHealthProbe;
  projection: ProjectionFreshnessProbe;
}

export interface ReadinessResult {
  status: 'ready' | 'not_ready';
  checks: {
    database: boolean;
    consumer: boolean;
    projectionFresh: boolean;
  };
  projectionLagSeconds: number | null;
}

const REBUILD_STATES = ['IDLE', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const;

export class ReportingRuntimeMetrics {
  readonly observability = new LowCardinalityRegistry('reporting_service');
  readonly projectionLagSeconds: GaugeHandle<'consumer'> = this.observability.gauge(
    'projection_lag_seconds',
    'Reporting projection lag in seconds',
    ['consumer'],
  );
  readonly projectionRebuildStatus: GaugeHandle<'status'> = this.observability.gauge(
    'projection_rebuild_status',
    'Projection rebuild state (1 for current state)',
    ['status'],
  );
  readonly projectionEventErrors: CounterHandle<'event_type' | 'error_code'> =
    this.observability.counter(
      'projection_event_errors_total',
      'Projection event processing errors',
      ['event_type', 'error_code'],
    );
  readonly reportQueryDuration: HistogramHandle<'report'> = this.observability.histogram(
    'report_query_duration_seconds',
    'Report query latency',
    ['report'],
  );

  setRebuildStatus(status: (typeof REBUILD_STATES)[number]): void {
    for (const candidate of REBUILD_STATES) {
      this.projectionRebuildStatus.set({ status: candidate }, candidate === status ? 1 : 0);
    }
  }

  markProjectionError(eventType: string, errorCode: string): void {
    this.projectionEventErrors.inc({ event_type: eventType, error_code: errorCode });
  }
}

export class RuntimeReadiness {
  private readonly hardLagLimitSeconds: number;
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: RuntimeDependencies,
    private readonly metrics: ReportingRuntimeMetrics,
    options: { hardLagLimitSeconds: number; now?: () => Date },
  ) {
    if (!Number.isSafeInteger(options.hardLagLimitSeconds) || options.hardLagLimitSeconds <= 0) {
      throw new Error('hardLagLimitSeconds must be a positive integer');
    }
    this.hardLagLimitSeconds = options.hardLagLimitSeconds;
    this.now = options.now ?? (() => new Date());
  }

  async check(): Promise<ReadinessResult> {
    const [database, consumer, projectedThrough] = await Promise.all([
      this.safeBooleanCheck(this.dependencies.database),
      this.safeBooleanCheck(this.dependencies.consumer),
      this.safeProjectionCheck(),
    ]);
    const projectionLagSeconds =
      projectedThrough === undefined
        ? null
        : Math.max(0, Math.floor((this.now().getTime() - Date.parse(projectedThrough)) / 1000));
    if (projectionLagSeconds !== null) {
      this.metrics.projectionLagSeconds.set({ consumer: 'reporting' }, projectionLagSeconds);
    }
    const projectionFresh =
      projectionLagSeconds !== null && projectionLagSeconds <= this.hardLagLimitSeconds;
    return {
      status: database && consumer && projectionFresh ? 'ready' : 'not_ready',
      checks: { database, consumer, projectionFresh },
      projectionLagSeconds,
    };
  }

  private async safeBooleanCheck(probe: BooleanHealthProbe): Promise<boolean> {
    try {
      return await probe.check();
    } catch {
      return false;
    }
  }

  private async safeProjectionCheck(): Promise<string | undefined> {
    try {
      const value = await this.dependencies.projection.projectedThrough();
      return value === undefined || Number.isNaN(Date.parse(value)) ? undefined : value;
    } catch {
      return undefined;
    }
  }
}

function reportLabel(route: string): string {
  const suffix = route.replace('/internal/reports/', '');
  return suffix.startsWith('exports') ? 'exports' : suffix;
}

export function buildRuntimeApp(dependencies: {
  queries: ReportQueryService;
  exports: ExportService;
  metrics: ReportingRuntimeMetrics;
  readiness: RuntimeReadiness;
}): FastifyInstance {
  const app = buildReportingApp({ queries: dependencies.queries, exports: dependencies.exports });
  dependencies.metrics.setRebuildStatus('IDLE');
  app.get('/health/live', () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const result = await dependencies.readiness.check();
    return reply.status(result.status === 'ready' ? 200 : 503).send(result);
  });
  app.get('/metrics', async (_request, reply) => {
    return reply
      .header('content-type', dependencies.metrics.observability.contentType())
      .send(await dependencies.metrics.observability.metrics());
  });
  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url;
    if (route !== undefined && route.startsWith('/internal/reports/')) {
      dependencies.metrics.reportQueryDuration.observe(
        { report: reportLabel(route) },
        reply.elapsedTime / 1000,
      );
    }
    done();
  });
  return app;
}
