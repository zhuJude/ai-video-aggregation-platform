import { Counter, Gauge, Histogram, Registry, type Metric } from 'prom-client';

const FORBIDDEN_LABELS = new Set([
  'userid',
  'taskid',
  'orderid',
  'objectkey',
  'phone',
  'traceid',
  'correlationid',
]);

function normalizeLabel(label: string): string {
  return label.replaceAll(/[-_]/g, '').toLowerCase();
}

function normalizePrefix(prefix: string): string {
  const normalized = prefix.replaceAll(/[^a-zA-Z0-9_:]/g, '_').replaceAll(/_+/g, '_');
  return normalized.endsWith('_') ? normalized : `${normalized}_`;
}

export class LowCardinalityRegistry {
  readonly registry = new Registry();
  readonly http;
  readonly messaging;
  readonly providers;
  readonly tasks;
  readonly wallet;
  readonly business;
  private readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = normalizePrefix(prefix);
    this.http = {
      requestsTotal: this.counter('http_requests_total', 'HTTP requests', [
        'method',
        'route',
        'status_class',
      ]),
      durationSeconds: this.histogram('http_request_duration_seconds', 'HTTP latency', [
        'method',
        'route',
        'status_class',
      ]),
    };
    this.messaging = {
      lagSeconds: this.gauge('message_lag_seconds', 'Message consumer lag', ['consumer', 'topic']),
      retriesTotal: this.counter('message_retries_total', 'Message retries', ['consumer', 'topic']),
      deadLettersTotal: this.counter('message_dead_letters_total', 'Dead-letter messages', [
        'consumer',
        'topic',
      ]),
    };
    this.providers = {
      durationSeconds: this.histogram('provider_request_duration_seconds', 'Provider latency', [
        'provider',
        'operation',
        'status_class',
      ]),
      health: this.gauge('provider_health', 'Provider health (1 healthy, 0 unhealthy)', [
        'provider',
      ]),
      balanceMinor: this.gauge('provider_balance_minor', 'Provider balance in minor units', [
        'provider',
        'currency',
      ]),
    };
    this.tasks = {
      transitionsTotal: this.counter('task_transitions_total', 'Task state transitions', [
        'from_state',
        'to_state',
      ]),
      sagaLagSeconds: this.gauge('task_saga_lag_seconds', 'Task Saga lag', ['saga']),
    };
    this.wallet = {
      reconciliationMismatch: this.gauge(
        'wallet_reconciliation_mismatch',
        'Wallet reconciliation mismatch count',
        ['check'],
      ),
    };
    this.business = {
      paymentEffects: this.counter('payment_effects_total', 'Applied payment effects', ['outcome']),
      taskEffects: this.counter('task_effects_total', 'Applied task effects', ['outcome']),
    };
  }

  counter<T extends string>(name: string, help: string, labelNames: T[]): Counter<T> {
    this.assertLowCardinality(labelNames);
    return new Counter({
      name: `${this.prefix}${name}`,
      help,
      labelNames,
      registers: [this.registry],
    });
  }

  gauge<T extends string>(name: string, help: string, labelNames: T[]): Gauge<T> {
    this.assertLowCardinality(labelNames);
    return new Gauge({
      name: `${this.prefix}${name}`,
      help,
      labelNames,
      registers: [this.registry],
    });
  }

  histogram<T extends string>(name: string, help: string, labelNames: T[]): Histogram<T> {
    this.assertLowCardinality(labelNames);
    return new Histogram({
      name: `${this.prefix}${name}`,
      help,
      labelNames,
      registers: [this.registry],
    });
  }

  register(metric: Metric): void {
    const labelNames = 'labelNames' in metric ? (metric.labelNames as string[]) : [];
    this.assertLowCardinality(labelNames);
    this.registry.registerMetric(metric);
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }

  private assertLowCardinality(labelNames: readonly string[]): void {
    const forbidden = labelNames.find((label) => FORBIDDEN_LABELS.has(normalizeLabel(label)));
    if (forbidden !== undefined) {
      throw new Error(`High-cardinality metric label is forbidden: ${forbidden}`);
    }
  }
}
