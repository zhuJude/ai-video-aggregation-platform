/* eslint-disable @typescript-eslint/no-confusing-void-expression, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unnecessary-condition -- timers and Prometheus values are normalized locally. */
import type { FastifyInstance } from 'fastify';
import type { OperationsHttpModule } from '../http/operations-http.module.js';
import { bootstrapOperationsRuntime } from './operations.runtime.js';

export interface OperationsHealthDependency {
  ping(): Promise<void>;
}

export class OperationsReadinessError extends Error {
  readonly code = 'DEPENDENCY_UNAVAILABLE';
  constructor() {
    super('DEPENDENCY_UNAVAILABLE');
    this.name = 'OperationsReadinessError';
  }
}

export class OperationsReadiness {
  constructor(
    private readonly input: {
      database: OperationsHealthDependency;
      broker: OperationsHealthDependency;
      auth: OperationsHealthDependency;
      asset: OperationsHealthDependency;
      generation: OperationsHealthDependency;
      timeoutMs?: number;
    },
  ) {}

  async check(): Promise<{
    database: 'ok';
    broker: 'ok';
    auth: 'ok';
    asset: 'ok';
    generation: 'ok';
  }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([
          boundedPing(this.input.database, this.input.timeoutMs ?? 2_000),
          boundedPing(this.input.broker, this.input.timeoutMs ?? 2_000),
          boundedPing(this.input.auth, this.input.timeoutMs ?? 2_000),
          boundedPing(this.input.asset, this.input.timeoutMs ?? 2_000),
          boundedPing(this.input.generation, this.input.timeoutMs ?? 2_000),
        ]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new OperationsReadinessError()),
            this.input.timeoutMs ?? 2_000,
          );
        }),
      ]);
      return { database: 'ok', broker: 'ok', auth: 'ok', asset: 'ok', generation: 'ok' };
    } catch {
      throw new OperationsReadinessError();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function boundedPing(dependency: OperationsHealthDependency, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve().then(() => dependency.ping()),
    new Promise<void>((_resolve, reject) => {
      timer = setTimeout(() => reject(new OperationsReadinessError()), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export class OperationsMetrics {
  private readonly publications = new Map<string, number>();

  constructor(
    private readonly input: {
      gauges: {
        ticketBacklog(): Promise<{ open: number; inProgress: number }>;
        pendingCompensations(): Promise<number>;
      };
    },
  ) {}

  publication(
    kind: 'package' | 'content' | 'setting' | 'feature_flag',
    result: 'published' | 'retired' | 'failed',
  ): void {
    const key = `${kind}\u0000${result}`;
    this.publications.set(key, (this.publications.get(key) ?? 0) + 1);
  }

  async render(): Promise<string> {
    const [tickets, compensations] = await Promise.all([
      this.input.gauges.ticketBacklog(),
      this.input.gauges.pendingCompensations(),
    ]);
    const publicationLines = [...this.publications.entries()].map(([key, value]) => {
      const [kind, result] = key.split('\u0000');
      return `support_operations_cms_publications_total{kind="${kind}",result="${result}"} ${value}`;
    });
    return [
      '# TYPE support_operations_cms_publications_total counter',
      ...publicationLines,
      '# TYPE support_operations_ticket_backlog gauge',
      `support_operations_ticket_backlog{status="open"} ${gauge(tickets.open)}`,
      `support_operations_ticket_backlog{status="in_progress"} ${gauge(tickets.inProgress)}`,
      '# TYPE support_operations_pending_compensations gauge',
      `support_operations_pending_compensations ${gauge(compensations)}`,
      '',
    ].join('\n');
  }
}

export class OperationsWorkerRunner {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly input: {
      outbox: { run(): Promise<number> };
      compensation: { run(): Promise<number> };
      intervalMs?: number;
      stopTimeoutMs?: number;
      onError?: (error: unknown) => void;
    },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await settle(this.inFlight, this.input.stopTimeoutMs ?? 25_000);
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.inFlight = this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.input.compensation.run();
      await this.input.outbox.run();
    } catch (error) {
      this.input.onError?.(error);
    }
    if (this.running) this.schedule(this.input.intervalMs ?? 1_000);
  }
}

export async function startOperationsService(input: {
  http: OperationsHttpModule;
  readiness: OperationsReadiness;
  metrics: OperationsMetrics;
  workers: OperationsWorkerRunner;
  workersEnabled?: boolean;
  host?: string;
  port?: number;
}): Promise<{ server: FastifyInstance; close(): Promise<void> }> {
  const runtime = await bootstrapOperationsRuntime({
    http: input.http,
    readiness: async () => {
      await input.readiness.check();
      return true;
    },
    metrics: () => input.metrics.render(),
    ...(input.host === undefined ? {} : { host: input.host }),
    ...(input.port === undefined ? {} : { port: input.port }),
  });
  if (input.workersEnabled ?? true) input.workers.start();
  return {
    server: runtime.server,
    close: async () => {
      if (input.workersEnabled ?? true) await input.workers.stop();
      await runtime.close();
    },
  };
}

async function settle(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

function gauge(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
