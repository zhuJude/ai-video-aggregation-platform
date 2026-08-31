import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { ExportService, ExportReport } from '../application/export.service.js';
import type {
  DailyMetric,
  InMemoryProjectionStore,
  ModelDailyMetric,
  ProviderDailyMetric,
  UserSegmentMetric,
} from '../application/projector.js';

const TIMEZONE = 'Asia/Shanghai';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 93;

interface RangeQuery {
  from?: string;
  to?: string;
}

export interface ReportRange {
  from: string;
  to: string;
}

interface JsonTotals {
  rechargePoints: string;
  rechargeAmountMinor: string;
  consumedPoints: string;
  revenueMinor: string;
  providerCostMinor: string;
  marginNumeratorMinor: string;
  marginDenominatorMinor: string;
  successfulTasks: number;
  failedTasks: number;
  taskDurationMsTotal: string;
  taskDurationSamples: number;
}

function parseDate(value: string | undefined, name: string): string {
  if (value === undefined || !DATE_PATTERN.test(value))
    throw new ReportError('REPORT_DATE_INVALID', `${name} is required`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ReportError('REPORT_DATE_INVALID', `${name} must be an ISO date`);
  }
  return value;
}

export function validateRange(query: RangeQuery): ReportRange {
  const from = parseDate(query.from, 'from');
  const to = parseDate(query.to, 'to');
  const fromTime = Date.parse(`${from}T00:00:00.000Z`);
  const toTime = Date.parse(`${to}T00:00:00.000Z`);
  if (fromTime > toTime) throw new ReportError('REPORT_RANGE_INVALID', 'from must not be after to');
  const rangeDays = Math.floor((toTime - fromTime) / 86_400_000) + 1;
  if (rangeDays > MAX_RANGE_DAYS) {
    throw new ReportError(
      'REPORT_RANGE_TOO_LARGE',
      `date range cannot exceed ${String(MAX_RANGE_DAYS)} days`,
    );
  }
  return { from, to };
}

function includesDate(date: string, range: ReportRange): boolean {
  return date >= range.from && date <= range.to;
}

function aggregateDaily(metrics: DailyMetric[]): JsonTotals {
  const bigintTotals = {
    rechargePoints: 0n,
    rechargeAmountMinor: 0n,
    consumedPoints: 0n,
    revenueMinor: 0n,
    providerCostMinor: 0n,
    marginNumeratorMinor: 0n,
    marginDenominatorMinor: 0n,
    taskDurationMsTotal: 0n,
  };
  let successfulTasks = 0;
  let failedTasks = 0;
  let taskDurationSamples = 0;
  for (const metric of metrics) {
    bigintTotals.rechargePoints += metric.rechargePoints;
    bigintTotals.rechargeAmountMinor += metric.rechargeAmountMinor;
    bigintTotals.consumedPoints += metric.consumedPoints;
    bigintTotals.revenueMinor += metric.revenueMinor;
    bigintTotals.providerCostMinor += metric.providerCostMinor;
    bigintTotals.marginNumeratorMinor += metric.marginNumeratorMinor;
    bigintTotals.marginDenominatorMinor += metric.marginDenominatorMinor;
    bigintTotals.taskDurationMsTotal += metric.taskDurationMsTotal;
    successfulTasks += metric.successfulTasks;
    failedTasks += metric.failedTasks;
    taskDurationSamples += metric.taskDurationSamples;
  }
  return {
    ...Object.fromEntries(
      Object.entries(bigintTotals).map(([key, value]) => [key, value.toString()]),
    ),
    successfulTasks,
    failedTasks,
    taskDurationSamples,
  } as JsonTotals;
}

export class ReportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export class ReportQueryService {
  constructor(
    private readonly store: InMemoryProjectionStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  overview(range: ReportRange): Record<string, unknown> {
    const daily = this.store.allDailyMetrics().filter((metric) => includesDate(metric.date, range));
    return this.envelope({ totals: aggregateDaily(daily), daily: daily.map(this.serializeDaily) });
  }

  finance(range: ReportRange): Record<string, unknown> {
    const totals = aggregateDaily(
      this.store.allDailyMetrics().filter((metric) => includesDate(metric.date, range)),
    );
    const denominator = BigInt(totals.marginDenominatorMinor);
    return this.envelope({
      totals,
      marginRate:
        denominator === 0n
          ? null
          : Number(BigInt(totals.marginNumeratorMinor)) / Number(denominator),
    });
  }

  providers(range: ReportRange): Record<string, unknown> {
    return this.envelope({
      items: this.groupProviders(this.store.allProviderDailyMetrics(), range),
    });
  }

  models(range: ReportRange): Record<string, unknown> {
    return this.envelope({ items: this.groupModels(this.store.allModelDailyMetrics(), range) });
  }

  tasks(range: ReportRange): Record<string, unknown> {
    const totals = aggregateDaily(
      this.store.allDailyMetrics().filter((metric) => includesDate(metric.date, range)),
    );
    const totalTasks = totals.successfulTasks + totals.failedTasks;
    return this.envelope({
      successfulTasks: totals.successfulTasks,
      failedTasks: totals.failedTasks,
      successRate: totalTasks === 0 ? null : totals.successfulTasks / totalTasks,
      averageDurationMs:
        totals.taskDurationSamples === 0
          ? null
          : Number(BigInt(totals.taskDurationMsTotal)) / totals.taskDurationSamples,
    });
  }

  users(range: ReportRange): Record<string, unknown> {
    return this.envelope({ items: this.groupUsers(this.store.allUserSegmentMetrics(), range) });
  }

  alertSummary(): Record<string, unknown> {
    return this.envelope({ items: [] });
  }

  exportRows(
    report: ExportReport,
    range: ReportRange,
  ): Array<Record<string, string | number | null>> {
    const result = this.report(report, range);
    const payload = JSON.stringify(result, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    return [{ report, from: range.from, to: range.to, timezone: TIMEZONE, payload }];
  }

  report(report: ExportReport, range: ReportRange): Record<string, unknown> {
    switch (report) {
      case 'overview':
        return this.overview(range);
      case 'finance':
        return this.finance(range);
      case 'providers':
        return this.providers(range);
      case 'models':
        return this.models(range);
      case 'tasks':
        return this.tasks(range);
      case 'users':
        return this.users(range);
    }
  }

  private envelope(payload: Record<string, unknown>): Record<string, unknown> {
    const checkpoint = this.store.checkpoint();
    const projectedThrough = checkpoint?.projectedThrough ?? null;
    const lagSeconds =
      projectedThrough === null
        ? null
        : Math.max(0, Math.floor((this.now().getTime() - Date.parse(projectedThrough)) / 1000));
    return {
      timezone: TIMEZONE,
      ...payload,
      freshness: { projectedThrough, lagSeconds },
    };
  }

  private readonly serializeDaily = (metric: DailyMetric): Record<string, string | number> => ({
    date: metric.date,
    ...aggregateDaily([metric]),
  });

  private groupProviders(
    metrics: ProviderDailyMetric[],
    range: ReportRange,
  ): Array<Record<string, unknown>> {
    const grouped = new Map<string, Omit<ProviderDailyMetric, 'date'>>();
    for (const metric of metrics.filter((item) => includesDate(item.date, range))) {
      const value = grouped.get(metric.providerId) ?? { ...metric };
      if (grouped.has(metric.providerId)) {
        value.successfulTasks += metric.successfulTasks;
        value.failedTasks += metric.failedTasks;
        value.providerCostMinor += metric.providerCostMinor;
        value.durationMsTotal += metric.durationMsTotal;
        value.durationSamples += metric.durationSamples;
      }
      grouped.set(metric.providerId, value);
    }
    return [...grouped.values()].map((metric) => ({
      ...metric,
      providerCostMinor: metric.providerCostMinor.toString(),
      durationMsTotal: metric.durationMsTotal.toString(),
    }));
  }

  private groupModels(
    metrics: ModelDailyMetric[],
    range: ReportRange,
  ): Array<Record<string, unknown>> {
    return metrics
      .filter((metric) => includesDate(metric.date, range))
      .map((metric) => ({
        ...metric,
        consumedPoints: metric.consumedPoints.toString(),
        revenueMinor: metric.revenueMinor.toString(),
        providerCostMinor: metric.providerCostMinor.toString(),
      }));
  }

  private groupUsers(
    metrics: UserSegmentMetric[],
    range: ReportRange,
  ): Array<Record<string, unknown>> {
    return metrics
      .filter((metric) => includesDate(metric.date, range))
      .map((metric) => ({ ...metric }));
  }
}

function permissions(request: FastifyRequest): Set<string> {
  const value = request.headers['x-admin-permissions'];
  const raw = Array.isArray(value) ? value.join(',') : (value ?? '');
  return new Set(
    raw
      .split(',')
      .map((permission) => permission.trim())
      .filter(Boolean),
  );
}

function requirePermission(request: FastifyRequest, permission: string): void {
  if (!permissions(request).has(permission)) {
    throw new ReportError('REPORT_FORBIDDEN', 'Required permission is missing', 403);
  }
}

export function buildReportingApp(dependencies: {
  queries: ReportQueryService;
  exports: ExportService;
}): FastifyInstance {
  const app = Fastify({ logger: false });
  const reportHandlers = {
    overview: (range: ReportRange) => dependencies.queries.overview(range),
    finance: (range: ReportRange) => dependencies.queries.finance(range),
    providers: (range: ReportRange) => dependencies.queries.providers(range),
    models: (range: ReportRange) => dependencies.queries.models(range),
    tasks: (range: ReportRange) => dependencies.queries.tasks(range),
    users: (range: ReportRange) => dependencies.queries.users(range),
  } as const;

  for (const [name, handler] of Object.entries(reportHandlers)) {
    app.get(`/internal/reports/${name}`, (request) => {
      requirePermission(request, 'reports:read');
      return handler(validateRange(request.query as RangeQuery));
    });
  }
  app.get('/internal/reports/alert-summary', (request) => {
    requirePermission(request, 'reports:read');
    validateRange(request.query as RangeQuery);
    return dependencies.queries.alertSummary();
  });
  app.post('/internal/reports/exports', async (request, reply) => {
    requirePermission(request, 'reports:export');
    const payload = request.body as Partial<{ report: ExportReport; from: string; to: string }>;
    const report = payload.report;
    if (!['overview', 'finance', 'providers', 'models', 'tasks', 'users'].includes(report ?? '')) {
      throw new ReportError('REPORT_EXPORT_INVALID', 'Unsupported export report');
    }
    const adminId = request.headers['x-admin-id'];
    if (typeof adminId !== 'string' || adminId.length === 0) {
      throw new ReportError('REPORT_ADMIN_REQUIRED', 'Admin identity is required', 401);
    }
    const job = await dependencies.exports.enqueue(
      adminId,
      report as ExportReport,
      validateRange(payload),
    );
    return reply.status(202).send(job);
  });
  app.get('/internal/reports/exports/:id', (request) => {
    requirePermission(request, 'reports:export');
    const { id } = request.params as { id: string };
    const job = dependencies.exports.status(id);
    if (job === undefined)
      throw new ReportError('REPORT_EXPORT_NOT_FOUND', 'Export not found', 404);
    return job;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ReportError) {
      void reply.status(error.statusCode).send({ code: error.code, message: error.message });
      return;
    }
    void reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
  });
  return app;
}
