import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProviderRuntimeObserver } from '../application/observability.js';
import { validBearerAuthorization } from './auth.js';

export type ReadinessProbe = () => Promise<boolean>;
export type ProviderOperation = 'CREATE' | 'QUERY' | 'CANCEL' | 'CALLBACK';
export type ProviderCallOutcome = 'SUCCESS' | 'FAILURE';
export type ProviderErrorClass =
  'RATE_LIMITED' | 'UNAVAILABLE' | 'TIMEOUT' | 'AUTH' | 'BALANCE' | 'PROTOCOL';
export type ProviderCircuitMetricState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

const OPERATIONS: ReadonlySet<string> = new Set(['CREATE', 'QUERY', 'CANCEL', 'CALLBACK']);
const OUTCOMES: ReadonlySet<string> = new Set(['SUCCESS', 'FAILURE']);
const ERROR_CLASSES: ReadonlySet<string> = new Set([
  'RATE_LIMITED',
  'UNAVAILABLE',
  'TIMEOUT',
  'AUTH',
  'BALANCE',
  'PROTOCOL',
]);
const CIRCUIT_STATES = ['CLOSED', 'OPEN', 'HALF_OPEN'] as const;
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
}

export interface ProviderBusinessRuntime {
  readiness(): Promise<boolean>;
  readonly callbackIngress: { handle(request: RuntimeRequest): Promise<RuntimeResponse> };
  readonly execution: { consume(rawBody: Uint8Array): Promise<unknown> };
  readonly polling: { consume(rawBody: Uint8Array): Promise<unknown> };
  readonly health: { consume(rawBody: Uint8Array): Promise<unknown> };
  readonly control: {
    inspect(rawBody: Uint8Array): Promise<unknown>;
    cancel(rawBody: Uint8Array): Promise<unknown>;
  };
  readonly outbox: { publish(): Promise<unknown> };
  close?(): Promise<void>;
}

export class ProviderRuntimeMetrics implements ProviderRuntimeObserver {
  private readonly requestDuration = new Map<string, { count: number; sum: number }>();
  private readonly providerErrors = new Map<string, number>();
  private readonly circuitStates = new Map<string, ProviderCircuitMetricState>();
  private durableCircuitCounts: Readonly<Record<ProviderCircuitMetricState, number>> | undefined;
  private pollingBacklog = 0;

  observeProviderCall(
    operation: ProviderOperation,
    outcome: ProviderCallOutcome,
    durationSeconds: number,
  ): void {
    assertMetricLabel(OPERATIONS, operation);
    assertMetricLabel(OUTCOMES, outcome);
    const labels = labelSet({ operation, outcome });
    const current = this.requestDuration.get(labels) ?? { count: 0, sum: 0 };
    this.requestDuration.set(labels, {
      count: current.count + 1,
      sum: current.sum + finiteNonNegative(durationSeconds),
    });
  }

  recordProviderError(operation: ProviderOperation, errorClass: ProviderErrorClass): void {
    assertMetricLabel(OPERATIONS, operation);
    assertMetricLabel(ERROR_CLASSES, errorClass);
    const labels = labelSet({ error_class: errorClass, operation });
    this.providerErrors.set(labels, (this.providerErrors.get(labels) ?? 0) + 1);
  }

  observeCircuitState(channelKey: string, state: ProviderCircuitMetricState): void {
    assertMetricLabel(new Set(CIRCUIT_STATES), state);
    if (channelKey.length === 0 || channelKey.length > 512)
      throw new Error('INVALID_METRIC_CHANNEL');
    this.circuitStates.set(channelKey, state);
  }

  setPollingBacklog(value: number): void {
    this.pollingBacklog = finiteNonNegative(value);
  }

  refreshCircuitStateCounts(snapshot: Readonly<Record<ProviderCircuitMetricState, number>>): void {
    this.durableCircuitCounts = {
      CLOSED: finiteNonNegative(snapshot.CLOSED),
      OPEN: finiteNonNegative(snapshot.OPEN),
      HALF_OPEN: finiteNonNegative(snapshot.HALF_OPEN),
    };
  }

  render(): string {
    const lines = [
      '# HELP provider_request_duration_seconds Provider call duration by operation and outcome.',
      '# TYPE provider_request_duration_seconds summary',
    ];
    for (const [labels, value] of [...this.requestDuration.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      lines.push(`provider_request_duration_seconds_sum${labels} ${String(value.sum)}`);
      lines.push(`provider_request_duration_seconds_count${labels} ${String(value.count)}`);
    }
    lines.push(
      '# HELP provider_errors_total Provider call failures by bounded class.',
      '# TYPE provider_errors_total counter',
      ...samples('provider_errors_total', this.providerErrors),
      '# HELP provider_circuit_state Number of durable provider circuits by bounded state.',
      '# TYPE provider_circuit_state gauge',
      ...CIRCUIT_STATES.map((state) => {
        const count =
          this.durableCircuitCounts?.[state] ??
          [...this.circuitStates.values()].filter((value) => value === state).length;
        return `provider_circuit_state${labelSet({ state })} ${String(count)}`;
      }),
      '# HELP provider_polling_backlog Provider executions awaiting a due poll.',
      '# TYPE provider_polling_backlog gauge',
      `provider_polling_backlog ${String(this.pollingBacklog)}`,
    );
    return `${lines.join('\n')}\n`;
  }
}

export interface ReadinessResult {
  readonly status: 'ready' | 'not_ready';
  readonly checks: Readonly<Record<string, boolean>>;
}

export class ProviderRuntimeController {
  constructor(
    private readonly metrics: ProviderRuntimeMetrics,
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

export interface ProviderRuntimeServer {
  readonly url: string;
  listen(port?: number, host?: string): Promise<void>;
  close(): Promise<void>;
}

export function createProviderRuntimeServer(
  controller: ProviderRuntimeController,
  business: ProviderBusinessRuntime,
  security: { readonly internalServiceAuthTokens: readonly string[] },
): ProviderRuntimeServer {
  let listeningUrl: string | undefined;
  const server = createServer((request, response) => {
    void routeOperationsRequest(controller, business, request, response, security).catch(() => {
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
      if (server.listening) await close(server);
      await business.close?.();
      listeningUrl = undefined;
    },
  };
}

async function routeOperationsRequest(
  controller: ProviderRuntimeController,
  business: ProviderBusinessRuntime,
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
  const callbackMatch = /^\/callbacks\/[^/]+$/.exec(pathname);
  if (method === 'POST' && callbackMatch !== null) {
    const result = await business.callbackIngress.handle({
      method,
      path: requestUrl,
      headers: request.headers,
      rawBody: await readBody(request),
    });
    sendJson(response, result.status, result.body);
    return;
  }
  if (method === 'POST' && pathname === '/internal/execution/consume') {
    if (
      !validBearerAuthorization(request.headers.authorization, security.internalServiceAuthTokens)
    ) {
      sendJson(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    sendJson(response, 200, await business.execution.consume(await readBody(request)));
    return;
  }
  if (method === 'POST' && pathname === '/internal/polling/consume') {
    if (
      !validBearerAuthorization(request.headers.authorization, security.internalServiceAuthTokens)
    ) {
      sendJson(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    sendJson(response, 200, await business.polling.consume(await readBody(request)));
    return;
  }
  if (method === 'POST' && pathname === '/internal/health/run') {
    if (
      !validBearerAuthorization(request.headers.authorization, security.internalServiceAuthTokens)
    ) {
      sendJson(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    sendJson(response, 200, await business.health.consume(await readBody(request)));
    return;
  }
  if (method === 'POST' && pathname === '/inspect') {
    if (
      !validBearerAuthorization(request.headers.authorization, security.internalServiceAuthTokens)
    ) {
      sendJson(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    sendJson(response, 200, await business.control.inspect(await readBody(request)));
    return;
  }
  if (method === 'POST' && pathname === '/cancel') {
    if (
      !validBearerAuthorization(request.headers.authorization, security.internalServiceAuthTokens)
    ) {
      sendJson(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    sendJson(response, 200, await business.control.cancel(await readBody(request)));
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

function sendText(response: ServerResponse, status: number, body: string): void {
  const bytes = Buffer.from(body);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(bytes.length),
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
  });
  response.end(bytes);
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
