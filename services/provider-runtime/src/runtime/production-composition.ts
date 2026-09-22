import { PrismaPg } from '@prisma/adapter-pg';
import { MockProviderClient } from '@repo/mock-provider';
import { UuidSchema } from '@repo/contracts/common';
import type { VideoProviderAdapter } from '@repo/provider-sdk';
import { z } from 'zod';
import { canonicalJson } from '../domain/canonical-json.js';
import { createHash, randomBytes } from 'node:crypto';
import {
  ProviderExecutionService,
  type DispatchResolver,
  type ResolvedDispatch,
} from '../application/execution.service.js';
import { ProviderPollingService } from '../application/polling.consumer.js';
import {
  ProviderBalanceCheckService,
  ProviderBalanceMonitor,
} from '../application/provider-health.service.js';
import { CircuitBreaker } from '../domain/circuit-breaker.js';
import { PrismaClient } from '../generated/prisma/client.js';
import {
  ProviderCallbackController,
  ProviderCallbackError,
  ProviderCallbackService,
} from '../http/provider-callback.controller.js';
import { PrismaExecutionRepository } from '../infrastructure/prisma-execution.repository.js';
import {
  PrismaCallbackRepository,
  PrismaCircuitRepository,
  PrismaPollRepository,
} from '../infrastructure/prisma-lifecycle.repository.js';
import type {
  ProviderBusinessRuntime,
  ProviderRuntimeMetrics,
  RuntimeRequest,
  RuntimeResponse,
} from './operations.js';
import { ProviderHttpOutboxTransport } from './http-outbox-transport.js';
import { requiredSecretList } from './auth.js';

export interface ApprovedProviderMessageTransport {
  ready(): Promise<boolean>;
  publishPending(): Promise<{ readonly published: number }>;
  close?(): void | Promise<void>;
}

export interface ProviderCompositionOverrides {
  readonly prisma?: PrismaClient;
  readonly dispatch?: DispatchResolver;
  readonly messageTransport?: ApprovedProviderMessageTransport;
  readonly controlAdapter?: {
    readonly cancelTask: NonNullable<VideoProviderAdapter['cancelTask']>;
  };
}

export interface ProductionProviderComposition extends ProviderBusinessRuntime {
  close(): Promise<void>;
}

export function createProductionProviderComposition(
  environment: Readonly<Record<string, string | undefined>>,
  metrics: ProviderRuntimeMetrics,
  overrides: ProviderCompositionOverrides = {},
): Promise<ProductionProviderComposition> {
  const ownedPrisma = overrides.prisma === undefined;
  const prisma = overrides.prisma ?? createPrisma(required(environment, 'DATABASE_URL'));
  const internalTokens = requiredSecretList(
    environment,
    'INTERNAL_SERVICE_AUTH_TOKENS',
    'INTERNAL_SERVICE_AUTH_TOKEN',
  );
  const internalToken = internalTokens[0] as string;
  const providerId = required(environment, 'MOCK_PROVIDER_ID');
  const modelCode = required(environment, 'MOCK_PROVIDER_MODEL_CODE');
  const mock = new MockProviderClient({
    baseUrl: requiredUrl(environment, 'MOCK_PROVIDER_URL').href,
    callbackSecret: required(environment, 'MOCK_PROVIDER_CALLBACK_SECRET'),
  });
  const adapterRegistry = {
    resolve: (key: { providerId: string; modelCode?: string }) =>
      Promise.resolve(
        key.providerId === providerId &&
          (key.modelCode === undefined || key.modelCode === modelCode)
          ? mock
          : null,
      ),
  };
  const executionRepository = new PrismaExecutionRepository(prisma);
  const circuit = new CircuitBreaker({
    repository: new PrismaCircuitRepository(prisma, { next: uuid }),
    clock: { now: () => new Date() },
    ids: { next: uuid },
    observer: metrics,
  });
  const dispatch =
    overrides.dispatch ??
    new HttpMockDispatchResolver(
      requiredEndpointUrl(environment, 'GENERATION_DISPATCH_API_URL'),
      providerId,
      modelCode,
      mock,
      internalToken,
    );
  const execution = new ProviderExecutionService({
    repository: executionRepository,
    resolver: dispatch,
    clock: { now: () => new Date() },
    ids: { next: uuid },
    circuit,
    observer: metrics,
  });
  const polling = new ProviderPollingService({
    repository: new PrismaPollRepository(prisma),
    adapters: adapterRegistry,
    clock: { now: () => new Date() },
    ids: { next: uuid },
    circuit,
    observer: metrics,
  });
  const health = new ProviderBalanceCheckService({
    monitor: new ProviderBalanceMonitor(circuit),
    adapters: { resolve: (key) => adapterRegistry.resolve(key) },
  });
  const callback = new ProviderCallbackController(
    new ProviderCallbackService({
      adapters: {
        resolve: (requestedProviderId) =>
          Promise.resolve(
            requestedProviderId === providerId
              ? {
                  verifyCallback: (input) =>
                    mock.verifyCallback({
                      headers: input.headers,
                      rawBody: input.body as Uint8Array,
                    }),
                  normalizeCallback: async (input) => {
                    const payload = input.payload;
                    if (!isRecord(payload)) throw new Error('INVALID_MOCK_CALLBACK');
                    const normalized = await mock.normalizeCallback(input);
                    return {
                      providerEventId: payload.eventId,
                      providerTaskId: payload.providerTaskId,
                      sequence: payload.sequence,
                      ...normalized,
                    };
                  },
                }
              : null,
          ),
      },
      repository: new PrismaCallbackRepository(prisma),
      clock: { now: () => new Date() },
      ids: { next: uuid },
    }),
  );
  const messageTransport =
    overrides.messageTransport ??
    new ProviderHttpOutboxTransport(prisma, {
      publishUrl: requiredEndpointUrl(environment, 'MESSAGE_TRANSPORT_PUBLISH_URL'),
      readyUrl: requiredEndpointUrl(environment, 'MESSAGE_TRANSPORT_READY_URL'),
      bearerToken: internalToken,
    });
  const controlAdapter = overrides.controlAdapter ?? mock;
  return Promise.resolve({
    readiness: async () => {
      if (!(await databaseReady(prisma))) return false;
      try {
        await Promise.all([
          refreshPollingBacklog(prisma, metrics),
          refreshCircuitStateCounts(prisma, metrics),
        ]);
        return (await mock.validateConfiguration()).valid && (await messageTransport.ready());
      } catch {
        return false;
      }
    },
    callbackIngress: { handle: (request) => routeCallback(callback, request) },
    execution: { consume: async (rawBody) => execution.handle(parseJson(rawBody)) },
    polling: { consume: async (rawBody) => polling.handle(parseJson(rawBody)) },
    health: {
      consume: async (rawBody) => {
        await refreshPollingBacklog(prisma, metrics);
        await refreshCircuitStateCounts(prisma, metrics);
        return health.handle(parseJson(rawBody));
      },
    },
    control: {
      inspect: (rawBody) => inspectExecution(prisma, parseJson(rawBody)),
      cancel: (rawBody) =>
        cancelExecution(prisma, providerId, controlAdapter, metrics, parseJson(rawBody)),
    },
    outbox: {
      publish: () => messageTransport.publishPending(),
    },
    close: async () => {
      await closeTransport(messageTransport);
      if (ownedPrisma) await prisma.$disconnect();
    },
  });
}

const InspectionSchema = z.strictObject({
  taskId: UuidSchema,
  providerId: UuidSchema,
  executionId: UuidSchema,
  providerTaskId: z.string().min(1).max(512),
  routeEpoch: z.int().nonnegative(),
});

const CancellationSchema = z.strictObject({
  taskId: UuidSchema,
  providerTaskId: z.string().min(1).max(512),
  businessKey: z.string().min(1).max(160),
  traceId: z.string().regex(/^[a-f0-9]{32}$/),
});

export async function inspectExecution(prisma: PrismaClient, value: unknown): Promise<unknown> {
  const input = InspectionSchema.parse(value);
  const execution = await prisma.providerExecution.findFirst({
    where: {
      id: input.executionId,
      taskId: input.taskId,
      providerId: input.providerId,
      providerTaskId: input.providerTaskId,
      routeEpoch: input.routeEpoch,
    },
    select: {
      taskId: true,
      providerId: true,
      id: true,
      providerTaskId: true,
      routeEpoch: true,
      status: true,
      attempts: {
        where: { action: 'CREATE' },
        orderBy: { attemptNumber: 'desc' },
        select: { status: true, providerTaskId: true },
      },
    },
  });
  if (execution === null) throw new Error('PROVIDER_EXECUTION_NOT_FOUND');
  const state = ['ACCEPTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED'].includes(
    execution.status,
  )
    ? execution.status
    : 'AMBIGUOUS';
  const accepted = execution.attempts.some(
    (attempt) =>
      attempt.providerTaskId === execution.providerTaskId &&
      ['ACCEPTED', 'RUNNING', 'SUCCEEDED'].includes(attempt.status),
  );
  return {
    taskId: execution.taskId,
    providerId: execution.providerId,
    executionId: execution.id,
    providerTaskId: execution.providerTaskId,
    routeEpoch: execution.routeEpoch,
    state,
    acceptance: accepted ? 'ACCEPTED' : 'UNKNOWN',
    // This schema records provider lifecycle, not an independently verifiable billing fact.
    billing: 'UNKNOWN',
  };
}

async function cancelExecution(
  prisma: PrismaClient,
  providerId: string,
  adapter: { readonly cancelTask: NonNullable<VideoProviderAdapter['cancelTask']> },
  metrics: ProviderRuntimeMetrics,
  value: unknown,
): Promise<unknown> {
  const input = CancellationSchema.parse(value);
  const execution = await prisma.providerExecution.findFirst({
    where: { taskId: input.taskId, providerId, providerTaskId: input.providerTaskId },
    select: { providerTaskId: true },
  });
  if (execution?.providerTaskId === null || execution?.providerTaskId === undefined) {
    throw new Error('PROVIDER_EXECUTION_NOT_FOUND');
  }
  const startedAt = Date.now();
  try {
    const result = await adapter.cancelTask({ providerTaskId: execution.providerTaskId });
    metrics.observeProviderCall('CANCEL', 'SUCCESS', (Date.now() - startedAt) / 1_000);
    return {
      outcome:
        result.state === 'CANCELED'
          ? 'CONFIRMED'
          : result.state === 'FAILED'
            ? 'REJECTED'
            : 'AMBIGUOUS',
    };
  } catch (error) {
    metrics.observeProviderCall('CANCEL', 'FAILURE', (Date.now() - startedAt) / 1_000);
    metrics.recordProviderError('CANCEL', 'PROTOCOL');
    void error;
    return { outcome: 'AMBIGUOUS' };
  }
}

async function routeCallback(
  controller: ProviderCallbackController,
  request: RuntimeRequest,
): Promise<RuntimeResponse> {
  const providerId = new URL(request.path, 'http://provider.invalid').pathname.split('/')[2];
  if (providerId === undefined) return { status: 404, body: { error: 'NOT_FOUND' } };
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers[name] = value;
  }
  try {
    const result = await controller.post(providerId, headers, request.rawBody);
    return { status: result.statusCode, body: result.body };
  } catch (error) {
    if (error instanceof ProviderCallbackError) {
      return { status: error.statusCode, body: { error: error.code } };
    }
    throw error;
  }
}

export class HttpMockDispatchResolver implements DispatchResolver {
  constructor(
    private readonly baseUrl: URL,
    private readonly providerId: string,
    private readonly modelCode: string,
    private readonly adapter: MockProviderClient,
    private readonly token: string,
  ) {}
  async resolve(
    input: Parameters<DispatchResolver['resolve']>[0],
  ): Promise<ResolvedDispatch | null> {
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('DISPATCH_LOOKUP_FAILED');
    const body = (await response.json()) as unknown;
    if (!isRecord(body) || !isRecord(body.parameters)) throw new Error('INVALID_DISPATCH_RESPONSE');
    const parameters = body.parameters;
    if (
      createHash('sha256').update(canonicalJson(parameters)).digest('hex') !==
      input.parametersSnapshotSha256
    ) {
      throw new Error('DISPATCH_SNAPSHOT_MISMATCH');
    }
    return {
      ...input,
      providerId: this.providerId,
      modelCode: this.modelCode,
      parameters,
      adapter: this.adapter,
      callbackMode: 'EXPECTED',
    };
  }
}

async function refreshPollingBacklog(
  prisma: PrismaClient,
  metrics: ProviderRuntimeMetrics,
): Promise<void> {
  const count = await prisma.providerExecution.count({
    where: {
      nextPollAt: { not: null },
      status: { in: ['ACCEPTED', 'RUNNING'] },
    },
  });
  metrics.setPollingBacklog(count);
}

async function refreshCircuitStateCounts(
  prisma: PrismaClient,
  metrics: ProviderRuntimeMetrics,
): Promise<void> {
  const rows = await prisma.circuitState.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  const snapshot = { CLOSED: 0, OPEN: 0, HALF_OPEN: 0 };
  for (const row of rows) snapshot[row.status] = row._count._all;
  metrics.refreshCircuitStateCounts(snapshot);
}

function createPrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

async function databaseReady(prisma: PrismaClient): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}

function requiredUrl(environment: Readonly<Record<string, string | undefined>>, name: string): URL {
  const url = new URL(required(environment, name));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`INVALID_${name}`);
  }
  return url.href.endsWith('/') ? url : new URL(`${url.href}/`);
}

function requiredEndpointUrl(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): URL {
  const url = new URL(required(environment, name));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`INVALID_${name}`);
  }
  return url;
}

async function closeTransport(transport: ApprovedProviderMessageTransport): Promise<void> {
  await transport.close?.();
}

function uuid(): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes.writeUInt8(0x70 | (bytes.readUInt8(6) & 0x0f), 6);
  bytes.writeUInt8(0x80 | (bytes.readUInt8(8) & 0x3f), 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseJson(rawBody: Uint8Array): unknown {
  return JSON.parse(Buffer.from(rawBody).toString('utf8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
