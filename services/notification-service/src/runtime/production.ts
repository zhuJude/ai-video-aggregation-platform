/* eslint-disable @typescript-eslint/no-confusing-void-expression, @typescript-eslint/restrict-template-expressions -- timers and Prometheus values are normalized locally. */
import type { FastifyInstance } from 'fastify';
import type { RocketMqNotificationConsumer } from '../adapters/rocketmq.consumer.js';
import type { NotificationWorkerRunner } from '../application/notification.consumer.js';
import type { NotificationHttpModule } from '../http/notification-http.module.js';
import { bootstrapNotificationRuntime } from './notification.runtime.js';

export interface NotificationHealthDependency {
  ping(): Promise<void>;
}

export interface NotificationRuntimeConfig {
  kmsPhoneKey: string;
  ramRoleArn: string;
  smsRegion: string;
  brokerEndpoints: string;
  consumerGroup: string;
  topic: string;
}

export class NotificationReadinessError extends Error {
  readonly code = 'DEPENDENCY_UNAVAILABLE';
  constructor() {
    super('DEPENDENCY_UNAVAILABLE');
    this.name = 'NotificationReadinessError';
  }
}

export class NotificationReadiness {
  readonly dependencies: {
    database: NotificationHealthDependency;
    kms: NotificationHealthDependency;
    ram: NotificationHealthDependency;
    auth: NotificationHealthDependency;
    sms: NotificationHealthDependency;
    broker: NotificationHealthDependency;
    config: NotificationRuntimeConfig;
  };
  private readonly timeoutMs: number;

  constructor(input: NotificationReadiness['dependencies'] & { timeoutMs?: number }) {
    const { timeoutMs, ...dependencies } = input;
    this.dependencies = dependencies;
    this.timeoutMs = timeoutMs ?? 2_000;
  }

  async check(): Promise<{
    database: 'ok';
    kms: 'ok';
    ram: 'ok';
    auth: 'ok';
    sms: 'ok';
    broker: 'ok';
    config: 'ok';
  }> {
    validateConfig(this.dependencies.config);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([
          boundedPing(this.dependencies.ram, this.timeoutMs),
          boundedPing(this.dependencies.auth, this.timeoutMs),
          boundedPing(this.dependencies.database, this.timeoutMs),
          boundedPing(this.dependencies.kms, this.timeoutMs),
          boundedPing(this.dependencies.sms, this.timeoutMs),
          boundedPing(this.dependencies.broker, this.timeoutMs),
        ]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new NotificationReadinessError()), this.timeoutMs);
        }),
      ]);
      return {
        database: 'ok',
        kms: 'ok',
        ram: 'ok',
        auth: 'ok',
        sms: 'ok',
        broker: 'ok',
        config: 'ok',
      };
    } catch {
      throw new NotificationReadinessError();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function boundedPing(dependency: NotificationHealthDependency, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve().then(() => dependency.ping()),
    new Promise<void>((_resolve, reject) => {
      timer = setTimeout(() => reject(new NotificationReadinessError()), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export class NotificationMetrics {
  private readonly retryCounts = new Map<string, number>();
  private consumerLagSeconds = 0;

  constructor(
    private readonly input: {
      gauges: { operatorQueue(): Promise<number>; retryQueue(): Promise<number> };
    },
  ) {}

  smsRetry(reason: 'transient' | 'unknown_acceptance' | 'receipt_pending'): void {
    this.retryCounts.set(reason, (this.retryCounts.get(reason) ?? 0) + 1);
  }

  observeConsumerLag(milliseconds: number): void {
    if (Number.isFinite(milliseconds) && milliseconds >= 0) {
      this.consumerLagSeconds = milliseconds / 1_000;
    }
  }

  async render(): Promise<string> {
    const [operatorQueue, retryQueue] = await Promise.all([
      this.input.gauges.operatorQueue(),
      this.input.gauges.retryQueue(),
    ]);
    return [
      '# TYPE support_notification_sms_retries_total counter',
      ...[...this.retryCounts.entries()].map(
        ([reason, value]) => `support_notification_sms_retries_total{reason="${reason}"} ${value}`,
      ),
      '# TYPE support_notification_operator_queue gauge',
      `support_notification_operator_queue ${gauge(operatorQueue)}`,
      '# TYPE support_notification_retry_queue gauge',
      `support_notification_retry_queue ${gauge(retryQueue)}`,
      '# TYPE support_notification_consumer_lag_seconds gauge',
      `support_notification_consumer_lag_seconds ${this.consumerLagSeconds}`,
      '',
    ].join('\n');
  }
}

export async function startNotificationService(input: {
  http: NotificationHttpModule;
  readiness: NotificationReadiness;
  metrics: NotificationMetrics;
  deliveryWorkers: NotificationWorkerRunner;
  eventConsumer: RocketMqNotificationConsumer;
  workersEnabled?: boolean;
  host?: string;
  port?: number;
}): Promise<{ server: FastifyInstance; close(): Promise<void> }> {
  await input.eventConsumer.connect();
  const runtime = await bootstrapNotificationRuntime({
    http: input.http,
    readiness: async () => {
      await input.readiness.check();
      return true;
    },
    metrics: () => input.metrics.render(),
    workerRunner: input.deliveryWorkers,
    workersEnabled: input.workersEnabled ?? true,
    ...(input.host === undefined ? {} : { host: input.host }),
    ...(input.port === undefined ? {} : { port: input.port }),
  });
  if (input.workersEnabled ?? true) input.eventConsumer.start();
  return {
    server: runtime.server,
    close: async () => {
      await input.eventConsumer.stop();
      await runtime.close();
    },
  };
}

function validateConfig(config: NotificationRuntimeConfig): void {
  if (
    !/^kms:\/\/.+/.test(config.kmsPhoneKey) ||
    !/^acs:ram::[^:]+:role\/.+/.test(config.ramRoleArn) ||
    config.smsRegion.length === 0 ||
    !/^[^\s:]+:\d+$/.test(config.brokerEndpoints) ||
    config.consumerGroup.length === 0 ||
    config.topic.length === 0
  ) {
    throw new NotificationReadinessError();
  }
}

function gauge(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
