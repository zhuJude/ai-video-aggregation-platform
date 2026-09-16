import { timingSafeEqual, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CanonicalCreateTask, ProviderResult, VideoProviderAdapter } from '@repo/provider-sdk';
import { createCallbackDelivery } from './callback.js';
import {
  MockProviderHttpError,
  deterministicTaskId,
  isCreateInput,
  isMockScenario,
  requestFingerprint,
  type CallbackDelivery,
  type MockBalance,
  type MockCallbackBody,
  type MockCancelResponse,
  type MockCreateInput,
  type MockCreateResponse,
  type MockScenario,
  type MockTaskResponse,
} from './protocol.js';

export type {
  CallbackDelivery,
  MockBalance,
  MockCallbackBody,
  MockCancelResponse,
  MockCreateInput,
  MockCreateResponse,
  MockScenario,
  MockTaskResponse,
} from './protocol.js';
export { MOCK_SCENARIOS, MockProviderHttpError } from './protocol.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;
const MAX_BODY_BYTES = 65_536;
const PROVIDER_STATES: ReadonlySet<unknown> = new Set([
  'ACCEPTED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
]);

export interface MockProviderServerOptions {
  callbackSecret?: string;
  callbackSecretRef?: string;
  resolveSecret?: (reference: string) => Promise<string>;
  deliverCallback?: (
    delivery: CallbackDelivery,
    context: { signal: AbortSignal; attempt: number },
  ) => Promise<void>;
  callbackDeliveryTimeoutMs?: number;
  callbackMaxAttempts?: number;
  onCallbackError?: (diagnostic: MockCallbackErrorDiagnostic) => void;
  timeoutDelayMs?: number;
  retryAfterSeconds?: number;
  maxTasks?: number;
  environment?: Readonly<Record<string, string | undefined>>;
}

export interface MockCallbackErrorDiagnostic {
  eventId: string;
  providerTaskId: string;
  sequence: number;
  attempts: number;
  code: 'CALLBACK_DELIVERY_FAILED' | 'CALLBACK_DELIVERY_TIMEOUT' | 'CALLBACK_DELIVERY_ABORTED';
}

export interface MockProviderDiagnostics {
  callbackAttempts: number;
  callbackSuccesses: number;
  callbackFailures: number;
  retainedTasks: number;
  retainedIdempotencyRecords: number;
}

export interface MockProviderServer {
  readonly url: string;
  listen(port?: number, host?: string): Promise<void>;
  close(): Promise<void>;
  drainCallbacks(): Promise<void>;
  getDiagnostics(): MockProviderDiagnostics;
}

interface StoredTask extends MockTaskResponse {
  state: 'ACCEPTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  polls: number;
  callbacksScheduled: Set<number>;
}

interface IdempotencyRecord {
  fingerprint: string;
  response: MockCreateResponse;
}

interface ErrorBody {
  error: { code: string; message: string };
}

interface RouteContext {
  callbackSecret: string;
  callbackTargetConfigured: boolean;
  deliverCallback: NonNullable<MockProviderServerOptions['deliverCallback']>;
  callbackDeliveryTimeoutMs: number;
  callbackMaxAttempts: number;
  onCallbackError: (diagnostic: MockCallbackErrorDiagnostic) => void;
  retryAfterSeconds: number;
  timeoutDelayMs: number;
  maxTasks: number;
  tasks: Map<string, StoredTask>;
  idempotency: Map<string, IdempotencyRecord>;
  lanes: Map<string, TaskLane>;
  callbackLanes: Map<string, TaskLane>;
  diagnostics: { callbackAttempts: number; callbackSuccesses: number; callbackFailures: number };
  getCallbackAbortSignal: () => AbortSignal;
  delay: (milliseconds: number, response: ServerResponse) => Promise<void>;
}

interface TaskLane {
  tail: Promise<void>;
  pending: number;
}

class NodeMockProviderServer implements MockProviderServer {
  private readonly httpServer: Server;
  private readonly pendingDelays = new Map<NodeJS.Timeout, () => void>();
  private listeningUrl: string | undefined;
  private callbackAbortController = new AbortController();

  constructor(
    private readonly configuration: Omit<RouteContext, 'delay' | 'getCallbackAbortSignal'>,
  ) {
    const context: RouteContext = {
      ...configuration,
      getCallbackAbortSignal: () => this.callbackAbortController.signal,
      delay: async (milliseconds, response) => this.delay(milliseconds, response),
    };
    this.httpServer = createServer((request, response) => {
      void routeRequest(context, request, response).catch(() => {
        sendError(
          response,
          500,
          'INTERNAL_ERROR',
          'The mock provider could not process the request.',
        );
      });
    });
  }

  get url(): string {
    if (this.listeningUrl === undefined) throw new Error('MOCK_PROVIDER_NOT_LISTENING');
    return this.listeningUrl;
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<void> {
    if (this.httpServer.listening) return;
    if (this.callbackAbortController.signal.aborted) {
      this.callbackAbortController = new AbortController();
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(error);
      };
      this.httpServer.once('error', onError);
      this.httpServer.listen(port, host, () => {
        this.httpServer.off('error', onError);
        resolve();
      });
    });
    const address = this.httpServer.address() as AddressInfo;
    this.listeningUrl = `http://${host}:${String(address.port)}`;
  }

  async close(): Promise<void> {
    for (const [timer, resolve] of this.pendingDelays) {
      clearTimeout(timer);
      resolve();
    }
    this.pendingDelays.clear();
    this.callbackAbortController.abort();
    await this.drainCallbacks();
    if (this.httpServer.listening) {
      this.httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        this.httpServer.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
    this.listeningUrl = undefined;
    this.configuration.tasks.clear();
    this.configuration.idempotency.clear();
    this.configuration.lanes.clear();
    this.configuration.callbackLanes.clear();
  }

  async drainCallbacks(): Promise<void> {
    while (this.configuration.callbackLanes.size > 0) {
      await Promise.all([...this.configuration.callbackLanes.values()].map(({ tail }) => tail));
    }
  }

  getDiagnostics(): MockProviderDiagnostics {
    return {
      ...this.configuration.diagnostics,
      retainedTasks: this.configuration.tasks.size,
      retainedIdempotencyRecords: this.configuration.idempotency.size,
    };
  }

  private delay(milliseconds: number, response: ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      const complete = (): void => {
        clearTimeout(timer);
        this.pendingDelays.delete(timer);
        response.off('close', complete);
        resolve();
      };
      const timer = setTimeout(complete, milliseconds);
      response.once('close', complete);
      this.pendingDelays.set(timer, complete);
    });
  }
}

export async function createMockProviderServer(
  options: MockProviderServerOptions,
): Promise<MockProviderServer> {
  const callbackSecret = await resolveCallbackSecret(options);
  return new NodeMockProviderServer({
    callbackSecret,
    callbackTargetConfigured: options.deliverCallback !== undefined,
    deliverCallback: options.deliverCallback ?? (() => Promise.resolve()),
    callbackDeliveryTimeoutMs: boundedInteger(options.callbackDeliveryTimeoutMs, 1_000, 1, 60_000),
    callbackMaxAttempts: boundedInteger(options.callbackMaxAttempts, 1, 1, 10),
    onCallbackError: options.onCallbackError ?? (() => undefined),
    retryAfterSeconds: boundedInteger(options.retryAfterSeconds, 2, 1, 3_600),
    timeoutDelayMs: boundedInteger(options.timeoutDelayMs, 200, 1, 1_000),
    maxTasks: boundedInteger(options.maxTasks, 10_000, 1, 1_000_000),
    tasks: new Map(),
    idempotency: new Map(),
    lanes: new Map(),
    callbackLanes: new Map(),
    diagnostics: { callbackAttempts: 0, callbackSuccesses: 0, callbackFailures: 0 },
  });
}

async function resolveCallbackSecret(options: MockProviderServerOptions): Promise<string> {
  const direct = options.callbackSecret ?? options.environment?.MOCK_PROVIDER_CALLBACK_SECRET;
  if (direct !== undefined && direct.length > 0) return direct;
  if (options.callbackSecretRef !== undefined && options.resolveSecret !== undefined) {
    const resolved = await options.resolveSecret(options.callbackSecretRef);
    if (resolved.length > 0) return resolved;
  }
  throw new Error('MOCK_CALLBACK_SECRET_REQUIRED');
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error('INVALID_MOCK_PROVIDER_CONFIGURATION');
  }
  return value;
}

async function routeRequest(
  context: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? '';
  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://mock-provider.invalid');
  } catch {
    sendError(response, 400, 'INVALID_REQUEST', 'The request is invalid.');
    return;
  }
  if (method === 'GET' && url.pathname === '/health/live') {
    if (rejectUnexpectedBody(request, response)) return;
    sendJson(response, 200, { status: 'ok' });
    return;
  }
  if (method === 'GET' && url.pathname === '/health/ready') {
    if (rejectUnexpectedBody(request, response)) return;
    const ready = context.callbackSecret.length > 0 && context.callbackTargetConfigured;
    sendJson(response, ready ? 200 : 503, {
      status: ready ? 'ready' : 'not_ready',
      checks: {
        callback_signing_key: context.callbackSecret.length > 0,
        callback_target: context.callbackTargetConfigured,
      },
    });
    return;
  }
  if (method === 'GET' && url.pathname === '/metrics') {
    if (rejectUnexpectedBody(request, response)) return;
    sendText(response, 200, renderMetrics(context));
    return;
  }
  if (method === 'POST' && url.pathname === '/tasks') {
    await createTask(context, request, response);
    return;
  }
  if (method === 'GET' && url.pathname === '/balance') {
    if (rejectUnexpectedBody(request, response)) return;
    sendJson(response, 200, { unit: 'MOCK_CREDITS', available: '1000000', nonReal: true });
    return;
  }
  const match = /^\/tasks\/([^/]+)(\/cancel)?$/.exec(url.pathname);
  if (match !== null) {
    let providerTaskId: string;
    try {
      providerTaskId = decodeURIComponent(match[1] ?? '');
    } catch {
      sendError(response, 400, 'INVALID_REQUEST', 'The request is invalid.');
      return;
    }
    if (method === 'GET' && match[2] === undefined) {
      if (rejectUnexpectedBody(request, response)) return;
      await queryTask(context, providerTaskId, response);
      return;
    }
    if (method === 'POST' && match[2] === '/cancel') {
      if (rejectUnexpectedBody(request, response)) return;
      await cancelTask(context, providerTaskId, response);
      return;
    }
  }
  sendError(response, 404, 'NOT_FOUND', 'The endpoint was not found.');
}

async function createTask(
  context: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const scenarioHeader = singleHeader(request, 'x-mock-scenario');
  const idempotencyKey = singleHeader(request, 'x-idempotency-key');
  const contentType = singleHeader(request, 'content-type');
  const parsedBody = await readJson(request);
  if (parsedBody.kind === 'too-large') {
    sendError(response, 413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
    return;
  }
  const body = parsedBody.kind === 'ok' ? parsedBody.value : undefined;
  if (
    !isJsonContentType(contentType) ||
    !isMockScenario(scenarioHeader) ||
    !isIdempotencyKey(idempotencyKey) ||
    !isCreateInput(body)
  ) {
    sendError(response, 400, 'INVALID_REQUEST', 'The request is invalid.');
    return;
  }

  const fingerprint = requestFingerprint(body, scenarioHeader);
  const existing = context.idempotency.get(idempotencyKey);
  if (existing !== undefined) {
    if (existing.fingerprint !== fingerprint) {
      sendError(
        response,
        409,
        'IDEMPOTENCY_CONFLICT',
        'The idempotency key was used for a different request.',
      );
      return;
    }
    sendJson(response, 202, existing.response);
    return;
  }

  if (scenarioHeader === 'rate-limit') {
    response.setHeader('retry-after', String(context.retryAfterSeconds));
    sendError(response, 429, 'RATE_LIMITED', 'The deterministic rate limit was reached.');
    return;
  }
  if (scenarioHeader === 'server-error') {
    sendError(response, 503, 'PROVIDER_UNAVAILABLE', 'The mock provider is unavailable.');
    return;
  }

  if (context.tasks.size >= context.maxTasks) {
    response.setHeader('retry-after', String(context.retryAfterSeconds));
    sendError(response, 503, 'MOCK_CAPACITY_EXCEEDED', 'The mock provider capacity was reached.');
    return;
  }

  const providerTaskId = deterministicTaskId(idempotencyKey, fingerprint);
  if (context.tasks.has(providerTaskId)) {
    sendError(response, 409, 'TASK_ID_COLLISION', 'The deterministic task ID already exists.');
    return;
  }
  const created: MockCreateResponse = {
    providerTaskId,
    scenario: scenarioHeader,
    state: 'ACCEPTED',
  };
  context.idempotency.set(idempotencyKey, { fingerprint, response: created });
  context.tasks.set(providerTaskId, {
    ...created,
    polls: 0,
    callbacksScheduled: new Set(),
  });

  if (scenarioHeader === 'timeout') await context.delay(context.timeoutDelayMs, response);
  sendJson(response, 202, created);
}

async function queryTask(
  context: RouteContext,
  providerTaskId: string,
  response: ServerResponse,
): Promise<void> {
  await inTaskLane(context, providerTaskId, () => {
    queryTaskInLane(context, providerTaskId, response);
  });
}

function queryTaskInLane(
  context: RouteContext,
  providerTaskId: string,
  response: ServerResponse,
): void {
  const task = context.tasks.get(providerTaskId);
  if (task === undefined) {
    sendError(response, 404, 'TASK_NOT_FOUND', 'The task was not found.');
    return;
  }
  if (isTerminal(task.state)) {
    sendJson(response, 200, publicTask(task));
    return;
  }

  task.polls += 1;
  if (task.polls === 1) {
    task.state = 'RUNNING';
    if (task.scenario === 'callback-out-of-order') {
      const running = publicTask(task);
      const terminal = terminalResponse(task);
      Object.assign(task, terminal);
      scheduleOnce(context, terminal, task, 2);
      scheduleOnce(context, running, task, 1);
    } else {
      scheduleOnce(context, publicTask(task), task, 1);
    }
  } else {
    const terminal = terminalResponse(task);
    Object.assign(task, terminal);
    if (task.scenario !== 'callback-out-of-order') {
      scheduleOnce(context, publicTask(task), task, 2);
      if (task.scenario === 'callback-duplicate') {
        enqueueCallback(context, createCallbackDelivery(context.callbackSecret, task, 2));
      }
    }
  }
  sendJson(response, 200, publicTask(task));
}

async function inTaskLane<T>(
  context: RouteContext,
  providerTaskId: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  let lane = context.lanes.get(providerTaskId);
  if (lane === undefined) {
    lane = { tail: Promise.resolve(), pending: 0 };
    context.lanes.set(providerTaskId, lane);
  }
  const previous = lane.tail;
  let release!: () => void;
  lane.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  lane.pending += 1;
  await previous;
  try {
    return await operation();
  } finally {
    release();
    lane.pending -= 1;
    if (lane.pending === 0 && context.lanes.get(providerTaskId) === lane) {
      context.lanes.delete(providerTaskId);
    }
  }
}

async function cancelTask(
  context: RouteContext,
  providerTaskId: string,
  response: ServerResponse,
): Promise<void> {
  await inTaskLane(context, providerTaskId, () => {
    cancelTaskInLane(context, providerTaskId, response);
  });
}

function cancelTaskInLane(
  context: RouteContext,
  providerTaskId: string,
  response: ServerResponse,
): void {
  const task = context.tasks.get(providerTaskId);
  if (task === undefined) {
    sendError(response, 404, 'TASK_NOT_FOUND', 'The task was not found.');
    return;
  }
  if (task.state === 'CANCELED') {
    sendJson(response, 200, { ...publicTask(task), state: 'CANCELED', canceled: true });
    return;
  }
  if (task.state === 'SUCCEEDED' || task.state === 'FAILED') {
    sendError(response, 409, 'TASK_TERMINAL', 'A terminal task cannot be canceled.');
    return;
  }
  task.state = 'CANCELED';
  const canceled: MockCancelResponse = {
    providerTaskId: task.providerTaskId,
    scenario: task.scenario,
    state: 'CANCELED',
    canceled: true,
  };
  sendJson(response, 200, canceled);
}

function scheduleOnce(
  context: RouteContext,
  publicResponse: MockTaskResponse,
  task: StoredTask,
  sequence: number,
): void {
  if (task.scenario === 'callback-lost' || task.callbacksScheduled.has(sequence)) return;
  task.callbacksScheduled.add(sequence);
  enqueueCallback(
    context,
    createCallbackDelivery(context.callbackSecret, publicResponse, sequence),
  );
}

function enqueueCallback(context: RouteContext, delivery: CallbackDelivery): void {
  const snapshot = copyCallbackDelivery(delivery);
  const providerTaskId = snapshot.body.providerTaskId;
  let lane = context.callbackLanes.get(providerTaskId);
  if (lane === undefined) {
    lane = { tail: Promise.resolve(), pending: 0 };
    context.callbackLanes.set(providerTaskId, lane);
  }
  const activeLane = lane;
  activeLane.pending += 1;
  const queued = activeLane.tail.then(() => deliverCallbackWithPolicy(context, snapshot));
  activeLane.tail = queued
    .catch(() => undefined)
    .finally(() => {
      activeLane.pending -= 1;
      if (activeLane.pending === 0 && context.callbackLanes.get(providerTaskId) === activeLane) {
        context.callbackLanes.delete(providerTaskId);
      }
    });
}

async function deliverCallbackWithPolicy(
  context: RouteContext,
  delivery: CallbackDelivery,
): Promise<void> {
  let diagnosticCode: MockCallbackErrorDiagnostic['code'] = 'CALLBACK_DELIVERY_FAILED';
  let attempts = 0;
  for (let attempt = 1; attempt <= context.callbackMaxAttempts; attempt += 1) {
    attempts = attempt;
    context.diagnostics.callbackAttempts += 1;
    try {
      await deliverWithTimeout(context, delivery, attempt);
      context.diagnostics.callbackSuccesses += 1;
      return;
    } catch (error) {
      diagnosticCode = callbackFailureCode(error);
      if (diagnosticCode === 'CALLBACK_DELIVERY_ABORTED') break;
    }
  }
  context.diagnostics.callbackFailures += 1;
  try {
    context.onCallbackError({
      eventId: delivery.body.eventId,
      providerTaskId: delivery.body.providerTaskId,
      sequence: delivery.body.sequence,
      attempts,
      code: diagnosticCode,
    });
  } catch {
    // Diagnostics are observational and must not change provider behavior.
  }
}

async function deliverWithTimeout(
  context: RouteContext,
  delivery: CallbackDelivery,
  attempt: number,
): Promise<void> {
  const signal = context.getCallbackAbortSignal();
  if (signal.aborted) throw new Error('CALLBACK_DELIVERY_ABORTED');
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('CALLBACK_DELIVERY_TIMEOUT'));
    }, context.callbackDeliveryTimeoutMs);
    onAbort = () => {
      reject(new Error('CALLBACK_DELIVERY_ABORTED'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([
      Promise.resolve().then(async () =>
        context.deliverCallback(copyCallbackDelivery(delivery), { signal, attempt }),
      ),
      boundary,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

function copyCallbackDelivery(delivery: CallbackDelivery): CallbackDelivery {
  return {
    headers: { ...delivery.headers },
    rawBody: Buffer.from(delivery.rawBody),
    body: {
      ...delivery.body,
      ...(delivery.body.resultUrls === undefined
        ? {}
        : { resultUrls: [...delivery.body.resultUrls] }),
    },
  };
}

function callbackFailureCode(error: unknown): MockCallbackErrorDiagnostic['code'] {
  if (error instanceof Error && error.message === 'CALLBACK_DELIVERY_TIMEOUT') {
    return 'CALLBACK_DELIVERY_TIMEOUT';
  }
  if (error instanceof Error && error.message === 'CALLBACK_DELIVERY_ABORTED') {
    return 'CALLBACK_DELIVERY_ABORTED';
  }
  return 'CALLBACK_DELIVERY_FAILED';
}

function terminalResponse(task: StoredTask): MockTaskResponse {
  if (task.scenario === 'failed') {
    return {
      providerTaskId: task.providerTaskId,
      scenario: task.scenario,
      state: 'FAILED',
      errorCode: 'MOCK_GENERATION_FAILED',
      errorMessage: 'The deterministic mock generation failed.',
    };
  }
  return {
    providerTaskId: task.providerTaskId,
    scenario: task.scenario,
    state: 'SUCCEEDED',
    resultUrls: [`mock://results/${task.providerTaskId}.mp4`],
  };
}

function publicTask(task: StoredTask): MockTaskResponse {
  return {
    providerTaskId: task.providerTaskId,
    scenario: task.scenario,
    state: task.state,
    ...(task.resultUrls === undefined ? {} : { resultUrls: task.resultUrls }),
    ...(task.errorCode === undefined ? {} : { errorCode: task.errorCode }),
    ...(task.errorMessage === undefined ? {} : { errorMessage: task.errorMessage }),
  };
}

function isTerminal(state: StoredTask['state']): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELED';
}

function isIdempotencyKey(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.length <= 256;
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.toLowerCase().split(';', 1)[0]?.trim() === 'application/json';
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name.toLowerCase()) {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  return values.length === 1 ? values[0] : undefined;
}

function rejectUnexpectedBody(request: IncomingMessage, response: ServerResponse): boolean {
  const contentLength = singleHeader(request, 'content-length');
  const transferEncoding = singleHeader(request, 'transfer-encoding');
  if ((contentLength !== undefined && contentLength !== '0') || transferEncoding !== undefined) {
    request.resume();
    sendError(response, 400, 'INVALID_REQUEST', 'The request is invalid.');
    return true;
  }
  return false;
}

type JsonReadResult = { kind: 'ok'; value: unknown } | { kind: 'invalid' } | { kind: 'too-large' };

async function readJson(request: IncomingMessage): Promise<JsonReadResult> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const rawChunk of request) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
      length += chunk.length;
      if (length > MAX_BODY_BYTES) return { kind: 'too-large' };
      chunks.push(chunk);
    }
    return { kind: 'ok', value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
  } catch {
    return { kind: 'invalid' };
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { ...JSON_HEADERS, 'content-length': String(bytes.length) });
  response.end(bytes);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } };
  sendJson(response, status, body);
}

function sendText(response: ServerResponse, status: number, body: string): void {
  if (response.destroyed || response.writableEnded) return;
  const bytes = Buffer.from(body);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(bytes.length),
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
  });
  response.end(bytes);
}

function renderMetrics(context: RouteContext): string {
  return [
    '# HELP mock_provider_callback_attempts_total Callback delivery attempts.',
    '# TYPE mock_provider_callback_attempts_total counter',
    `mock_provider_callback_attempts_total ${String(context.diagnostics.callbackAttempts)}`,
    '# HELP mock_provider_callback_successes_total Successful callback deliveries.',
    '# TYPE mock_provider_callback_successes_total counter',
    `mock_provider_callback_successes_total ${String(context.diagnostics.callbackSuccesses)}`,
    '# HELP mock_provider_callback_failures_total Exhausted callback deliveries.',
    '# TYPE mock_provider_callback_failures_total counter',
    `mock_provider_callback_failures_total ${String(context.diagnostics.callbackFailures)}`,
    '# HELP mock_provider_retained_tasks In-memory deterministic task records.',
    '# TYPE mock_provider_retained_tasks gauge',
    `mock_provider_retained_tasks ${String(context.tasks.size)}`,
    '',
  ].join('\n');
}

export interface MockProviderClientOptions {
  baseUrl: string;
  requestTimeoutMs?: number;
  defaultScenario?: MockScenario;
  callbackSecret?: string;
}

export interface CreateOptions {
  scenario?: MockScenario;
  idempotencyKey: string;
}

export type MockCallbackVerificationInput =
  | {
      headers: Record<string, string>;
      rawBody: string | Uint8Array;
      body?: never;
    }
  | {
      headers: Record<string, string>;
      body: unknown;
      rawBody?: never;
    };

export class MockProviderClient implements VideoProviderAdapter {
  readonly code = 'mock';
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly defaultScenario: MockScenario;
  private readonly callbackSecret: string | undefined;

  constructor(options: MockProviderClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs, 100, 1, 60_000);
    this.defaultScenario = options.defaultScenario ?? 'success';
    this.callbackSecret = options.callbackSecret;
  }

  create(input: MockCreateInput, options: CreateOptions): Promise<MockCreateResponse> {
    return this.request('/tasks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': options.idempotencyKey,
        'x-mock-scenario': options.scenario ?? this.defaultScenario,
      },
      body: JSON.stringify(input),
    });
  }

  get(providerTaskId: string): Promise<MockTaskResponse> {
    return this.request(`/tasks/${encodeURIComponent(providerTaskId)}`);
  }

  cancel(providerTaskId: string): Promise<MockCancelResponse> {
    return this.request(`/tasks/${encodeURIComponent(providerTaskId)}/cancel`, { method: 'POST' });
  }

  getBalance(): Promise<MockBalance> {
    return this.request('/balance');
  }

  validateConfiguration(): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];
    try {
      const url = new URL(this.baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        issues.push('baseUrl must use http or https');
      }
      if (url.username.length > 0 || url.password.length > 0) {
        issues.push('baseUrl must not contain credentials');
      }
    } catch {
      issues.push('baseUrl must be a valid absolute URL');
    }
    return Promise.resolve({ valid: issues.length === 0, issues });
  }

  getHealth(): Promise<{ status: 'UP' | 'DEGRADED' | 'DOWN'; latencyMs: number }> {
    return this.getBalance()
      .then(() => ({ status: 'UP' as const, latencyMs: 0 }))
      .catch(() => ({ status: 'DOWN' as const, latencyMs: 0 }));
  }

  async createTask(input: CanonicalCreateTask): Promise<{
    providerTaskId: string;
    state: 'ACCEPTED';
  }> {
    const created = await this.create(
      { taskId: input.taskId, modelCode: input.modelCode, parameters: input.parameters },
      { idempotencyKey: input.idempotencyKey, scenario: this.defaultScenario },
    );
    return { providerTaskId: created.providerTaskId, state: created.state };
  }

  async queryTask(input: { providerTaskId: string }): Promise<ProviderResult> {
    return toProviderResult(await this.get(input.providerTaskId));
  }

  async cancelTask(input: { providerTaskId: string }): Promise<ProviderResult> {
    return toProviderResult(await this.cancel(input.providerTaskId));
  }

  verifyCallback(
    input: MockCallbackVerificationInput,
  ): Promise<{ valid: boolean; payload: unknown }> {
    const headers = normalizeHeaders(input.headers);
    if (headers === undefined) {
      return Promise.resolve({ valid: false, payload: null });
    }
    const signature = headers['x-mock-signature'];
    const rawBody =
      'rawBody' in input
        ? input.rawBody
        : typeof input.body === 'string' || input.body instanceof Uint8Array
          ? input.body
          : undefined;
    if (this.callbackSecret === undefined || signature === undefined || rawBody === undefined) {
      return Promise.resolve({ valid: false, payload: null });
    }
    const bodyBytes =
      typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
    const expected = `sha256=${createHmac('sha256', this.callbackSecret)
      .update(bodyBytes)
      .digest('hex')}`;
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    const signatureValid =
      actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
    if (!signatureValid) return Promise.resolve({ valid: false, payload: null });
    try {
      const payload = JSON.parse(bodyBytes.toString('utf8')) as unknown;
      if (
        !isCallbackBody(payload) ||
        headers['x-provider-event-id'] !== payload.eventId ||
        headers['x-provider-sequence'] !== String(payload.sequence)
      ) {
        return Promise.resolve({ valid: false, payload: null });
      }
      return Promise.resolve({ valid: true, payload });
    } catch {
      return Promise.resolve({ valid: false, payload: null });
    }
  }

  normalizeCallback(input: { payload: unknown }): Promise<ProviderResult> {
    if (!isCallbackBody(input.payload)) {
      return Promise.reject(new Error('INVALID_MOCK_CALLBACK'));
    }
    return Promise.resolve(toProviderResult(input.payload));
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.requestTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
      const responseText = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(responseText) as unknown;
      } catch {
        throw new MockProviderHttpError({
          code: 'INVALID_PROVIDER_RESPONSE',
          message: 'The mock provider response was invalid.',
          status: response.status,
        });
      }
      if (!response.ok) throw responseError(response, payload);
      return payload as T;
    } catch (error) {
      if (error instanceof MockProviderHttpError) throw error;
      if (controller.signal.aborted) {
        throw new MockProviderHttpError({
          code: 'MOCK_TIMEOUT',
          message: 'The deterministic mock request timed out.',
          status: 408,
        });
      }
      throw new MockProviderHttpError({
        code: 'MOCK_NETWORK_ERROR',
        message: 'The mock provider could not be reached.',
        status: 503,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Adapts the provider-sdk's frozen unsigned callback fixture for conformance tests only.
 * Production callback verification remains strict and always requires the exact signed bytes.
 */
export function createMockProviderConformanceAdapter(
  client: MockProviderClient,
  callbackSecret: string,
): VideoProviderAdapter {
  const fixture = createCallbackDelivery(
    callbackSecret,
    {
      providerTaskId: 'mock_conformance_callback',
      scenario: 'success',
      state: 'RUNNING',
    },
    1,
  );
  return {
    code: client.code,
    validateConfiguration: async () => client.validateConfiguration(),
    getHealth: async () => client.getHealth(),
    createTask: async (input) => client.createTask(input),
    queryTask: async (input) => client.queryTask(input),
    cancelTask: async (input) => client.cancelTask(input),
    getBalance: async () => client.getBalance(),
    verifyCallback: async (input) => {
      if (
        Object.keys(input.headers).length === 0 &&
        isRecord(input.body) &&
        Object.keys(input.body).length === 0
      ) {
        return client.verifyCallback({ headers: { ...fixture.headers }, rawBody: fixture.rawBody });
      }
      return client.verifyCallback(input);
    },
    normalizeCallback: async (input) => client.normalizeCallback(input),
  };
}

function responseError(response: Response, payload: unknown): MockProviderHttpError {
  const stable = extractError(payload);
  const retryAfter = response.headers.get('retry-after');
  const retryAfterSeconds = retryAfter === null ? undefined : Number.parseInt(retryAfter, 10);
  return new MockProviderHttpError({
    code: stable.code,
    message: stable.message,
    status: response.status,
    ...(retryAfterSeconds !== undefined && Number.isInteger(retryAfterSeconds)
      ? { retryAfterSeconds }
      : {}),
  });
}

function extractError(payload: unknown): { code: string; message: string } {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof payload.error === 'object' &&
    payload.error !== null &&
    'code' in payload.error &&
    typeof payload.error.code === 'string' &&
    'message' in payload.error &&
    typeof payload.error.message === 'string'
  ) {
    return { code: payload.error.code, message: payload.error.message };
  }
  return { code: 'INVALID_PROVIDER_RESPONSE', message: 'The mock provider response was invalid.' };
}

function isCallbackBody(value: unknown): value is MockCallbackBody {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    'eventId',
    'providerTaskId',
    'sequence',
    'state',
    'occurredAt',
    'resultUrls',
    'errorCode',
    'errorMessage',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (
    !isBoundedNonEmptyString(value.eventId, 256) ||
    !isBoundedNonEmptyString(value.providerTaskId, 256) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) <= 0 ||
    !PROVIDER_STATES.has(value.state) ||
    !isIsoTimestamp(value.occurredAt)
  ) {
    return false;
  }
  const resultUrlsValid =
    value.resultUrls === undefined ||
    (Array.isArray(value.resultUrls) &&
      value.resultUrls.length > 0 &&
      value.resultUrls.every((item) => isBoundedNonEmptyString(item, 2_048)));
  if (!resultUrlsValid) return false;
  const errorCodeValid =
    value.errorCode === undefined || isBoundedNonEmptyString(value.errorCode, 128);
  const errorMessageValid =
    value.errorMessage === undefined || isBoundedNonEmptyString(value.errorMessage, 1_024);
  if (!errorCodeValid || !errorMessageValid) return false;

  if (value.state === 'SUCCEEDED') {
    return (
      value.resultUrls !== undefined &&
      value.errorCode === undefined &&
      value.errorMessage === undefined
    );
  }
  if (value.state === 'FAILED') {
    return (
      value.resultUrls === undefined &&
      value.errorCode !== undefined &&
      value.errorMessage !== undefined
    );
  }
  return (
    value.resultUrls === undefined &&
    value.errorCode === undefined &&
    value.errorMessage === undefined
  );
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> | undefined {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (Object.hasOwn(normalized, normalizedName)) return undefined;
    normalized[normalizedName] = value;
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedNonEmptyString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

function toProviderResult(task: MockTaskResponse | MockCallbackBody): ProviderResult {
  return {
    state: task.state,
    ...(task.resultUrls === undefined ? {} : { resultUrls: task.resultUrls }),
    ...(task.errorCode === undefined ? {} : { errorCode: task.errorCode }),
    ...(task.errorMessage === undefined ? {} : { errorMessage: task.errorMessage }),
  };
}
