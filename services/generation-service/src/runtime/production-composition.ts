import { PrismaPg } from '@prisma/adapter-pg';
import { randomBytes } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { HEADERS, UuidSchema } from '@repo/contracts/common';
import { QuoteSchema } from '@repo/contracts/routing';
import { map, type ObservableInput } from 'rxjs';
import { z } from 'zod';
import { CreateTaskService } from '../application/create-task.service.js';
import { GenerationApplicationError } from '../application/errors.js';
import type { GenerationDomainObserver } from '../application/observability.js';
import type {
  AssetImportPort,
  CancellationPort,
  WalletEffectsPort,
} from '../application/provider-events.consumer.js';
import { ProviderEventsConsumer } from '../application/provider-events.consumer.js';
import type { LedgerCommand, RoutingQuotePort, WalletLedgerPort } from '../application/ports.js';
import { TaskEventsService } from '../application/task-events.service.js';
import { TaskManagementService } from '../application/task-management.service.js';
import {
  TaskRepairJob,
  type ProviderRuntimeInspection,
  type ProviderRuntimeStatusPort,
} from '../application/task-repair.job.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { TasksController, type AuthenticatedRequest } from '../http/tasks.controller.js';
import { generationErrorStatus } from '../http/generation-exception.filter.js';
import { UuidV7Generator } from '../domain/uuid-v7.js';
import { PrismaProviderEventRepository } from '../infrastructure/prisma-provider-event.repository.js';
import { PrismaTaskEventStream } from '../infrastructure/prisma-task-event-stream.js';
import type { TransitionNotification } from '../infrastructure/prisma-task-event-stream.js';
import { PrismaTaskRepository } from '../infrastructure/prisma-task.repository.js';
import type { GenerationBusinessRuntime, RuntimeRequest, RuntimeResponse } from './operations.js';
import { GenerationHttpOutboxTransport } from './http-outbox-transport.js';
import { GatewayIdentityVerifier, requiredSecretList, type GatewayReplayStore } from './auth.js';

export interface ApprovedMessageTransport {
  ready(): Promise<boolean>;
  publishPending(): Promise<{ readonly published: number }>;
  readonly transitionNotifications: ObservableInput<TransitionNotification>;
  close?(): void | Promise<void>;
}

export interface GenerationCompositionOverrides {
  readonly prisma?: PrismaClient;
  readonly routing?: RoutingQuotePort;
  readonly wallet?: WalletLedgerPort & WalletEffectsPort;
  readonly asset?: AssetImportPort;
  readonly cancellation?: CancellationPort | null;
  readonly providerStatus?: ProviderRuntimeStatusPort;
  readonly messageTransport?: ApprovedMessageTransport;
}

export interface ProductionGenerationComposition extends GenerationBusinessRuntime {
  close(): Promise<void>;
}

export function createProductionGenerationComposition(
  environment: Readonly<Record<string, string | undefined>>,
  observer: GenerationDomainObserver,
  overrides: GenerationCompositionOverrides = {},
): Promise<ProductionGenerationComposition> {
  const ids = new UuidV7Generator();
  const ownedPrisma = overrides.prisma === undefined;
  const prisma = overrides.prisma ?? createPrisma(requiredDatabaseUrl(environment));
  const internalTokens = requiredSecretList(
    environment,
    'INTERNAL_SERVICE_AUTH_TOKENS',
    'INTERNAL_SERVICE_AUTH_TOKEN',
  );
  const internalToken = internalTokens[0] as string;
  const identityVerifier = new GatewayIdentityVerifier(
    requiredSecretList(
      environment,
      'GATEWAY_IDENTITY_HMAC_SECRETS',
      'GATEWAY_IDENTITY_HMAC_SECRET',
    ),
    new PrismaGatewayReplayStore(prisma, ids),
  );
  const routing =
    overrides.routing ??
    new HttpRoutingPort(requiredUrl(environment, 'ROUTING_API_URL'), internalToken);
  const wallet =
    overrides.wallet ??
    new HttpWalletPort(requiredUrl(environment, 'WALLET_API_URL'), internalToken);
  const asset =
    overrides.asset ?? new HttpAssetPort(requiredUrl(environment, 'ASSET_API_URL'), internalToken);
  const providerStatus =
    overrides.providerStatus ??
    new HttpProviderStatusPort(requiredUrl(environment, 'PROVIDER_RUNTIME_API_URL'), internalToken);
  const cancellation =
    overrides.cancellation === undefined
      ? new HttpCancellationPort(
          requiredUrl(environment, 'PROVIDER_RUNTIME_API_URL'),
          internalToken,
        )
      : overrides.cancellation;
  const taskRepository = new PrismaTaskRepository(prisma);
  const eventRepository = new PrismaProviderEventRepository(prisma);
  const createTasks = new CreateTaskService({
    repository: taskRepository,
    routing,
    wallet,
    observer,
  });
  const tasks = new TaskManagementService(taskRepository, undefined, observer);
  const messageTransport =
    overrides.messageTransport ??
    new GenerationHttpOutboxTransport(prisma, {
      publishUrl: requiredEndpointUrl(environment, 'MESSAGE_TRANSPORT_PUBLISH_URL'),
      readyUrl: requiredEndpointUrl(environment, 'MESSAGE_TRANSPORT_READY_URL'),
      bearerToken: internalToken,
    });
  const taskEvents = new TaskEventsService(
    tasks,
    new PrismaTaskEventStream(prisma, messageTransport.transitionNotifications),
  );
  const taskController = new TasksController(createTasks, tasks, taskEvents);
  const providerEvents = new ProviderEventsConsumer({
    repository: eventRepository,
    asset,
    wallet,
    cancellation,
    clock: { now: () => new Date() },
    ids,
    observer,
  });
  const repair = new TaskRepairJob({
    repository: eventRepository,
    provider: providerStatus,
    providerEvents,
    wallet,
    clock: { now: () => new Date() },
    ids,
    observer,
  });
  return Promise.resolve({
    readiness: async () => (await databaseReady(prisma)) && (await messageTransport.ready()),
    taskApi: { handle: (request) => routeTaskApi(taskController, identityVerifier, request) },
    dispatch: { resolve: (rawBody) => resolveDispatch(prisma, parseJson(rawBody)) },
    providerEvents: {
      consume: async (rawBody) => providerEvents.consume(parseJson(rawBody)),
    },
    repair: { run: async () => repair.run() },
    outbox: {
      publish: () => messageTransport.publishPending(),
    },
    close: async () => {
      await messageTransport.close?.();
      if (ownedPrisma) await prisma.$disconnect();
    },
  });
}

async function routeTaskApi(
  controller: TasksController,
  identityVerifier: GatewayIdentityVerifier,
  request: RuntimeRequest,
): Promise<RuntimeResponse> {
  const url = new URL(request.path, 'http://generation.invalid');
  const userId = await identityVerifier.verify(request);
  if (userId === null) return { status: 401, body: { error: 'UNAUTHORIZED' } };
  const authenticated = { principal: { userId } } as AuthenticatedRequest;
  const segments = url.pathname.split('/').filter(Boolean);
  try {
    if (request.method === 'POST' && url.pathname === '/v1/tasks') {
      const body = await controller.create(
        authenticated,
        singleHeader(request, HEADERS.idempotencyKey),
        singleHeader(request, HEADERS.traceId),
        parseJson(request.rawBody),
      );
      return { status: 202, body };
    }
    if (request.method === 'GET' && url.pathname === '/v1/tasks') {
      const body = await controller.list(
        authenticated,
        url.searchParams.get('cursor') ?? undefined,
        url.searchParams.get('limit') ?? undefined,
      );
      return { status: 200, body };
    }
    const taskId = segments[2];
    if (
      taskId !== undefined &&
      request.method === 'GET' &&
      segments.length === 4 &&
      segments[3] === 'events'
    ) {
      const stream = await controller.streamEvents(
        authenticated,
        taskId,
        singleHeader(request, 'last-event-id'),
      );
      return {
        status: 200,
        contentType: 'text/event-stream',
        body: null,
        stream: stream.pipe(
          map((event) => ({
            ...(event.id === undefined ? {} : { id: event.id }),
            ...(event.type === undefined ? {} : { type: event.type }),
            data: event.data,
          })),
        ),
      };
    }
    if (taskId !== undefined && request.method === 'GET' && segments.length === 3) {
      return { status: 200, body: await controller.get(authenticated, taskId) };
    }
    if (taskId !== undefined && request.method === 'POST' && segments[3] === 'cancel') {
      return {
        status: 202,
        body: await controller.cancel(
          authenticated,
          taskId,
          singleHeader(request, HEADERS.traceId),
        ),
      };
    }
    if (taskId !== undefined && request.method === 'POST' && segments[3] === 'retry') {
      return {
        status: 202,
        body: await controller.retry(
          authenticated,
          taskId,
          singleHeader(request, HEADERS.idempotencyKey),
          singleHeader(request, HEADERS.traceId),
          parseJson(request.rawBody),
        ),
      };
    }
    return { status: 404, body: { error: 'NOT_FOUND' } };
  } catch (error) {
    return generationErrorResponse(error, singleHeader(request, HEADERS.traceId));
  }
}

class HttpRoutingPort implements RoutingQuotePort {
  constructor(
    private readonly baseUrl: URL,
    private readonly token: string,
  ) {}
  async getQuote(quoteId: string) {
    const body = await requestJson(
      new URL(`quotes/${encodeURIComponent(quoteId)}`, this.baseUrl),
      undefined,
      this.token,
    );
    if (!isRecord(body)) throw new Error('INVALID_ROUTING_RESPONSE');
    const quote = QuoteSchema.parse(body.quote);
    return {
      quote,
      capabilitySnapshot: body.capabilitySnapshot,
      pricingSnapshot: body.pricingSnapshot,
    };
  }
}

class PrismaGatewayReplayStore implements GatewayReplayStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ids: { next(): string },
  ) {}

  async claim(input: Parameters<GatewayReplayStore['claim']>[0]): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.inboxMessage.deleteMany({
          where: {
            consumer: 'generation:gateway-identity:v1',
            receivedAt: { lt: new Date(input.receivedAt.getTime() - 600_000) },
          },
        });
        await transaction.inboxMessage.create({
          data: {
            id: this.ids.next(),
            consumer: 'generation:gateway-identity:v1',
            messageId: input.requestId,
            eventType: 'gateway.identity-authenticated.v1',
            payloadSha256: input.bodySha256,
            receivedAt: input.receivedAt,
            processedAt: input.receivedAt,
          },
        });
      });
      return true;
    } catch {
      return false;
    }
  }
}

class HttpWalletPort implements WalletLedgerPort, WalletEffectsPort {
  constructor(
    private readonly baseUrl: URL,
    private readonly token: string,
  ) {}
  reserve(command: LedgerCommand): Promise<void> {
    return postJson(new URL('reserve', this.baseUrl), command, this.token);
  }
  release(command: LedgerCommand): Promise<void> {
    return postJson(new URL('release', this.baseUrl), command, this.token);
  }
  settle(command: LedgerCommand): Promise<void> {
    return postJson(new URL('settle', this.baseUrl), command, this.token);
  }
}

class HttpAssetPort implements AssetImportPort {
  constructor(
    private readonly baseUrl: URL,
    private readonly token: string,
  ) {}
  requestImport(input: Parameters<AssetImportPort['requestImport']>[0]): Promise<void> {
    return postJson(new URL('imports', this.baseUrl), input, this.token);
  }
}

class HttpProviderStatusPort implements ProviderRuntimeStatusPort {
  constructor(
    private readonly baseUrl: URL,
    private readonly token: string,
  ) {}
  async inspect(input: Parameters<ProviderRuntimeStatusPort['inspect']>[0]) {
    const body = await requestJson(new URL('inspect', this.baseUrl), input, this.token);
    if (!isRecord(body)) throw new Error('INVALID_PROVIDER_STATUS_RESPONSE');
    return body as unknown as ProviderRuntimeInspection;
  }
}

class HttpCancellationPort implements CancellationPort {
  constructor(
    private readonly baseUrl: URL,
    private readonly token: string,
  ) {}
  async cancel(input: Parameters<CancellationPort['cancel']>[0]) {
    const body = await requestJson(new URL('cancel', this.baseUrl), input, this.token);
    if (!isRecord(body) || !['CONFIRMED', 'REJECTED', 'AMBIGUOUS'].includes(String(body.outcome))) {
      throw new Error('INVALID_PROVIDER_CANCEL_RESPONSE');
    }
    return { outcome: body.outcome as 'CONFIRMED' | 'REJECTED' | 'AMBIGUOUS' };
  }
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

function requiredDatabaseUrl(environment: Readonly<Record<string, string | undefined>>): string {
  const value = environment.DATABASE_URL;
  if (value === undefined || value.trim().length === 0) throw new Error('DATABASE_URL_REQUIRED');
  return value;
}

function requiredUrl(environment: Readonly<Record<string, string | undefined>>, name: string): URL {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`${name}_REQUIRED`);
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`INVALID_${name}`);
  }
  return url.href.endsWith('/') ? url : new URL(`${url.href}/`);
}

function requiredEndpointUrl(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): URL {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`${name}_REQUIRED`);
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`INVALID_${name}`);
  }
  return url;
}

function singleHeader(request: RuntimeRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? undefined : value;
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
}

async function requestJson(url: URL, body: unknown, token: string): Promise<unknown> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('INTERNAL_HTTP_REQUEST_FAILED');
  return response.json() as Promise<unknown>;
}

async function postJson(url: URL, body: unknown, token: string): Promise<void> {
  await requestJson(url, body, token);
}

function generationErrorResponse(
  error: unknown,
  incomingTraceId: string | undefined,
): RuntimeResponse {
  if (error instanceof GenerationApplicationError) {
    return {
      status: generationErrorStatus(error),
      body: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        traceId: safeTraceId(incomingTraceId),
      },
    };
  }
  if (error instanceof HttpException)
    return { status: error.getStatus(), body: error.getResponse() };
  if (error instanceof SyntaxError) {
    return {
      status: 400,
      body: {
        code: 'INVALID_TASK_REQUEST',
        message: 'The request body is not valid JSON.',
        retryable: false,
        traceId: safeTraceId(incomingTraceId),
      },
    };
  }
  return {
    status: 500,
    body: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      retryable: false,
      traceId: safeTraceId(incomingTraceId),
    },
  };
}

const DispatchLookupSchema = z.strictObject({
  taskId: UuidSchema,
  capabilityVersionId: UuidSchema,
  parametersSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

async function resolveDispatch(prisma: PrismaClient, value: unknown): Promise<unknown> {
  const input = DispatchLookupSchema.safeParse(value);
  if (!input.success) return null;
  const task = await prisma.generationTask.findFirst({
    where: {
      id: input.data.taskId,
      capabilityVersionId: input.data.capabilityVersionId,
      parametersSnapshotSha256: input.data.parametersSnapshotSha256,
    },
    select: { parametersSnapshot: true },
  });
  if (task === null || !isRecord(task.parametersSnapshot)) return null;
  return { parameters: task.parametersSnapshot };
}

function safeTraceId(value: string | undefined): string {
  return value !== undefined && /^[a-f0-9]{32}$/.test(value)
    ? value
    : randomBytes(16).toString('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
