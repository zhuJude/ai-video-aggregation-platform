import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Observable } from 'rxjs';
import type { TaskStatus } from '../domain/task-state-machine.js';
import type { GenerationDomainObserver } from '../application/observability.js';
import { validBearerAuthorization } from './auth.js';

export type ReadinessProbe = () => Promise<boolean>;
export type TransitionFailureReason =
  'ILLEGAL_TRANSITION' | 'VERSION_CONFLICT' | 'PERSISTENCE_ERROR';
export type RepairCaseReason =
  'AMBIGUOUS_PROVIDER_RESULT' | 'FINANCIAL_EFFECT_PENDING' | 'STALE_STATUS';
export type FinancialSagaPhase = 'ASSET_IMPORT' | 'SETTLEMENT' | 'RELEASE';
const MAX_RUNTIME_BODY_BYTES = 1_048_576;

export interface RuntimeRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly rawBody: Uint8Array;
}

export interface RuntimeResponse {
  readonly status: number;
  readonly body: unknown;
  readonly contentType?: 'text/event-stream';
  readonly stream?: Observable<RuntimeSseEvent>;
}

export interface RuntimeSseEvent {
  readonly id?: string;
  readonly type?: string;
  readonly data: unknown;
}

export interface GenerationBusinessRuntime {
  /** Verifies the composed repositories, consumers and publishers are usable. */
  readiness(): Promise<boolean>;
  readonly taskApi: { handle(request: RuntimeRequest): Promise<RuntimeResponse> };
  readonly dispatch: { resolve(rawBody: Uint8Array): Promise<unknown> };
  readonly providerEvents: { consume(rawBody: Uint8Array): Promise<unknown> };
  readonly repair: { run(): Promise<unknown> };
  readonly outbox: { publish(): Promise<unknown> };
  close?(): Promise<void>;
}

const TASK_STATUSES: ReadonlySet<string> = new Set([
  'QUOTED',
  'RESERVED',
  'QUEUED',
  'SUBMITTING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'EXPIRED',
  'SETTLED',
  'REFUNDED',
]);
const TRANSITION_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'ILLEGAL_TRANSITION',
  'VERSION_CONFLICT',
  'PERSISTENCE_ERROR',
]);
const REPAIR_CASE_REASONS: ReadonlySet<string> = new Set([
  'AMBIGUOUS_PROVIDER_RESULT',
  'FINANCIAL_EFFECT_PENDING',
  'STALE_STATUS',
]);
const FINANCIAL_SAGA_PHASES: ReadonlySet<string> = new Set([
  'ASSET_IMPORT',
  'SETTLEMENT',
  'RELEASE',
]);

export class GenerationMetrics implements GenerationDomainObserver {
  private readonly taskStates = new Map<string, number>();
  private readonly transitionFailures = new Map<string, number>();
  private readonly repairCases = new Map<string, number>();
  private readonly financialSagaLag = new Map<string, number>();
  private queueAgeCount = 0;
  private queueAgeSum = 0;

  recordTaskState(status: TaskStatus): void {
    assertMetricLabel(TASK_STATUSES, status);
    const labels = labelSet({ status });
    this.taskStates.set(labels, (this.taskStates.get(labels) ?? 0) + 1);
  }

  recordTransitionFailure(
    fromStatus: TaskStatus,
    toStatus: TaskStatus,
    reason: TransitionFailureReason,
  ): void {
    assertMetricLabel(TASK_STATUSES, fromStatus);
    assertMetricLabel(TASK_STATUSES, toStatus);
    assertMetricLabel(TRANSITION_FAILURE_REASONS, reason);
    const labels = labelSet({ from_status: fromStatus, reason, to_status: toStatus });
    this.transitionFailures.set(labels, (this.transitionFailures.get(labels) ?? 0) + 1);
  }

  observeQueueAge(seconds: number): void {
    this.queueAgeSum += finiteNonNegative(seconds);
    this.queueAgeCount += 1;
  }

  setRepairCases(reason: RepairCaseReason, value: number): void {
    assertMetricLabel(REPAIR_CASE_REASONS, reason);
    this.repairCases.set(labelSet({ reason }), finiteNonNegative(value));
  }

  incrementRepairCases(reason: RepairCaseReason): void {
    assertMetricLabel(REPAIR_CASE_REASONS, reason);
    const labels = labelSet({ reason });
    this.repairCases.set(labels, (this.repairCases.get(labels) ?? 0) + 1);
  }

  refreshRepairCases(snapshot: Readonly<Record<RepairCaseReason, number>>): void {
    for (const reason of REPAIR_CASE_REASONS)
      this.setRepairCases(reason as RepairCaseReason, snapshot[reason as RepairCaseReason]);
  }

  setFinancialSagaLag(phase: FinancialSagaPhase, seconds: number): void {
    assertMetricLabel(FINANCIAL_SAGA_PHASES, phase);
    this.financialSagaLag.set(labelSet({ phase }), finiteNonNegative(seconds));
  }

  refreshFinancialSagaLag(snapshot: Readonly<Record<FinancialSagaPhase, number>>): void {
    for (const phase of FINANCIAL_SAGA_PHASES) {
      this.setFinancialSagaLag(phase as FinancialSagaPhase, snapshot[phase as FinancialSagaPhase]);
    }
  }

  render(): string {
    const lines = [
      '# HELP generation_tasks_total Tasks entering each canonical state.',
      '# TYPE generation_tasks_total counter',
      ...samples('generation_tasks_total', this.taskStates),
      '# HELP generation_transition_failures_total Rejected task state transitions.',
      '# TYPE generation_transition_failures_total counter',
      ...samples('generation_transition_failures_total', this.transitionFailures),
      '# HELP generation_queue_age_seconds Age of tasks leaving the generation queue.',
      '# TYPE generation_queue_age_seconds summary',
      `generation_queue_age_seconds_sum ${String(this.queueAgeSum)}`,
      `generation_queue_age_seconds_count ${String(this.queueAgeCount)}`,
      '# HELP generation_repair_cases Open repair cases by bounded reason.',
      '# TYPE generation_repair_cases gauge',
      ...samples('generation_repair_cases', this.repairCases),
      '# HELP generation_financial_saga_lag_seconds Oldest incomplete financial Saga age.',
      '# TYPE generation_financial_saga_lag_seconds gauge',
      ...samples('generation_financial_saga_lag_seconds', this.financialSagaLag),
    ];
    return `${lines.join('\n')}\n`;
  }
}

export interface ReadinessResult {
  readonly status: 'ready' | 'not_ready';
  readonly checks: Readonly<Record<string, boolean>>;
}

export class GenerationRuntimeController {
  constructor(
    private readonly metrics: GenerationMetrics,
    private readonly probes: Readonly<Record<string, ReadinessProbe>>,
    private readonly probeTimeoutMs = 500,
  ) {
    if (!Number.isInteger(probeTimeoutMs) || probeTimeoutMs < 1 || probeTimeoutMs > 30_000) {
      throw new Error('INVALID_READINESS_TIMEOUT');
    }
  }

  liveness(): { readonly status: 'ok' } {
    return { status: 'ok' };
  }

  async readiness(
    additional: Readonly<Record<string, ReadinessProbe>> = {},
  ): Promise<ReadinessResult> {
    const entries = Object.entries({ ...this.probes, ...additional }).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const checkEntries: Array<readonly [string, boolean]> = await Promise.all(
      entries.map(
        async ([name, probe]) => [name, await probeBefore(probe, this.probeTimeoutMs)] as const,
      ),
    );
    const checks: Record<string, boolean> = Object.fromEntries(checkEntries);
    return {
      status: entries.length > 0 && Object.values(checks).every(Boolean) ? 'ready' : 'not_ready',
      checks,
    };
  }

  prometheus(): string {
    return this.metrics.render();
  }
}

export interface GenerationRuntimeServer {
  readonly url: string;
  listen(port?: number, host?: string): Promise<void>;
  close(): Promise<void>;
}

interface ActiveEventStream {
  close(): void;
}

export function createGenerationRuntimeServer(
  controller: GenerationRuntimeController,
  business: GenerationBusinessRuntime,
  security: { readonly internalServiceAuthTokens: readonly string[] },
): GenerationRuntimeServer {
  return createOperationsServer(controller, business, security);
}

function createOperationsServer(
  controller: GenerationRuntimeController,
  business: GenerationBusinessRuntime,
  security: { readonly internalServiceAuthTokens: readonly string[] },
): GenerationRuntimeServer {
  let listeningUrl: string | undefined;
  const activeEventStreams = new Set<ActiveEventStream>();
  const server = createServer((request, response) => {
    void routeOperationsRequest(
      controller,
      business,
      activeEventStreams,
      request,
      response,
      security,
    ).catch(() => {
      sendJson(response, 500, { error: 'RUNTIME_HANDLER_FAILED' });
    });
  });
  return {
    get url(): string {
      if (listeningUrl === undefined) throw new Error('RUNTIME_SERVER_NOT_LISTENING');
      return listeningUrl;
    },
    async listen(port = 0, host = '127.0.0.1'): Promise<void> {
      if (server.listening) return;
      await listen(server, port, host);
      const address = server.address() as AddressInfo;
      listeningUrl = `http://${host}:${String(address.port)}`;
    },
    async close(): Promise<void> {
      for (const eventStream of activeEventStreams) eventStream.close();
      activeEventStreams.clear();
      if (server.listening) await close(server);
      await business.close?.();
      listeningUrl = undefined;
    },
  };
}

async function routeOperationsRequest(
  controller: GenerationRuntimeController,
  business: GenerationBusinessRuntime,
  activeEventStreams: Set<ActiveEventStream>,
  request: IncomingMessage,
  response: ServerResponse,
  security: { readonly internalServiceAuthTokens: readonly string[] },
): Promise<void> {
  const method = request.method ?? '';
  const requestUrl = request.url ?? '/';
  const pathname = new URL(requestUrl, 'http://runtime.invalid').pathname;
  if (pathname === '/health/live') {
    if (method !== 'GET') {
      sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }
    sendJson(response, 200, controller.liveness());
    return;
  }
  if (pathname === '/health/ready') {
    if (method !== 'GET') {
      sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }
    const readiness = await controller.readiness({ business_runtime: () => business.readiness() });
    sendJson(response, readiness.status === 'ready' ? 200 : 503, readiness);
    return;
  }
  if (pathname === '/metrics') {
    if (method !== 'GET') {
      sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }
    sendText(response, 200, controller.prometheus());
    return;
  }
  if (pathname === '/v1/tasks' || pathname.startsWith('/v1/tasks/')) {
    const result = await business.taskApi.handle({
      method,
      path: requestUrl,
      headers: request.headers,
      rawBody: await readBody(request),
    });
    if (result.contentType === 'text/event-stream' && result.stream !== undefined) {
      sendEventStream(response, result.status, result.stream, activeEventStreams);
    } else {
      sendJson(response, result.status, result.body);
    }
    return;
  }
  if (method === 'POST' && pathname === '/internal/provider-events') {
    if (
      !validBearerAuthorization(request.headers.authorization, security.internalServiceAuthTokens)
    ) {
      sendJson(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    sendJson(response, 200, await business.providerEvents.consume(await readBody(request)));
    return;
  }
  if (method === 'POST' && pathname === '/internal/repair/run') {
    if (
      !validBearerAuthorization(request.headers.authorization, security.internalServiceAuthTokens)
    ) {
      sendJson(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    sendJson(response, 200, await business.repair.run());
    return;
  }
  if (method === 'POST' && pathname === '/internal/outbox/publish') {
    if (
      !validBearerAuthorization(request.headers.authorization, security.internalServiceAuthTokens)
    ) {
      sendJson(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    sendJson(response, 200, await business.outbox.publish());
    return;
  }
  if (method === 'POST' && pathname === '/internal/dispatch') {
    if (
      !validBearerAuthorization(request.headers.authorization, security.internalServiceAuthTokens)
    ) {
      sendJson(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    const result = await business.dispatch.resolve(await readBody(request));
    sendJson(response, result === null ? 404 : 200, result ?? { error: 'NOT_FOUND' });
    return;
  }
  sendJson(response, 404, { error: 'NOT_FOUND' });
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    length += chunk.length;
    if (length > MAX_RUNTIME_BODY_BYTES) throw new Error('RUNTIME_BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function assertMetricLabel(allowed: ReadonlySet<string>, value: string): void {
  if (!allowed.has(value)) throw new Error('INVALID_METRIC_LABEL');
}

function finiteNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('INVALID_METRIC_VALUE');
  return value;
}

function labelSet(labels: Readonly<Record<string, string>>): string {
  return `{${Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}="${value}"`)
    .join(',')}}`;
}

function samples(name: string, values: ReadonlyMap<string, number>): string[] {
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([labels, value]) => `${name}${labels} ${String(value)}`);
}

function probeBefore(probe: ReadinessProbe, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    void Promise.resolve()
      .then(probe)
      .then(
        (value) => {
          finish(value);
        },
        () => {
          finish(false);
        },
      );
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(bytes.length),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(bytes);
}

function sendText(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain; version=0.0.4; charset=utf-8',
): void {
  const bytes = Buffer.from(body);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(bytes.length),
    'content-type': contentType,
  });
  response.end(bytes);
}

function sendEventStream(
  response: ServerResponse,
  status: number,
  stream: Observable<RuntimeSseEvent>,
  activeEventStreams: Set<ActiveEventStream>,
): void {
  response.writeHead(status, {
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
  });
  response.flushHeaders();
  const active: ActiveEventStream = {
    close: () => {
      subscription.unsubscribe();
      if (!response.writableEnded && !response.destroyed) response.end();
    },
  };
  activeEventStreams.add(active);
  const finish = (): void => {
    activeEventStreams.delete(active);
    if (!response.writableEnded && !response.destroyed) response.end();
  };
  const subscription = stream.subscribe({
    next: (event) => {
      if (response.writableEnded || response.destroyed) return;
      if (event.id !== undefined) response.write(`id: ${event.id}\n`);
      if (event.type !== undefined) response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event.data)}\n\n`);
    },
    error: finish,
    complete: finish,
  });
  response.once('close', () => {
    activeEventStreams.delete(active);
    subscription.unsubscribe();
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
