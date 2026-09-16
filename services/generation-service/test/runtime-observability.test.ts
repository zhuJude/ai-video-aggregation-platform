import { readFile } from 'node:fs/promises';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY, Observable, Subject } from 'rxjs';
import {
  GenerationMetrics,
  GenerationRuntimeController,
  createGenerationRuntimeServer,
  type GenerationBusinessRuntime,
  type ReadinessProbe,
} from '../src/runtime/operations.js';
import { bootstrapGenerationRuntime, loadGenerationRuntimeConfig } from '../src/runtime/main.js';
import { createProductionGenerationComposition } from '../src/runtime/production-composition.js';

const INTERNAL_TOKEN = 'internal-service-token-value-000001';
const PREVIOUS_INTERNAL_TOKEN = 'previous-internal-token-value-00001';
const GATEWAY_SECRET = 'gateway-identity-secret-value-000001';
const PREVIOUS_GATEWAY_SECRET = 'previous-gateway-secret-value-00001';
const SECURITY = { internalServiceAuthTokens: [INTERNAL_TOKEN, PREVIOUS_INTERNAL_TOKEN] };

function gatewayHeaders(
  userId: string,
  method: string,
  path: string,
  body = '',
  options: {
    readonly secret?: string;
    readonly requestId?: string;
    readonly idempotencyKey?: string;
    readonly lastEventId?: string;
    readonly traceId?: string;
  } = {},
) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const requestId = options.requestId ?? randomUUID();
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', options.secret ?? GATEWAY_SECRET)
    .update(
      [
        userId,
        timestamp,
        requestId,
        method.toUpperCase(),
        path,
        bodyHash,
        `idempotency-key:${options.idempotencyKey ?? ''}`,
        `last-event-id:${options.lastEventId ?? ''}`,
        `x-trace-id:${options.traceId ?? ''}`,
      ].join('\n'),
    )
    .digest('hex');
  return {
    'x-authenticated-user-id': userId,
    'x-gateway-timestamp': timestamp,
    'x-gateway-request-id': requestId,
    'x-gateway-signature': signature,
    ...(options.idempotencyKey === undefined ? {} : { 'idempotency-key': options.idempotencyKey }),
    ...(options.lastEventId === undefined ? {} : { 'last-event-id': options.lastEventId }),
    ...(options.traceId === undefined ? {} : { 'x-trace-id': options.traceId }),
  };
}

function businessRuntime(ready = true): GenerationBusinessRuntime {
  return {
    readiness: () => Promise.resolve(ready),
    taskApi: { handle: () => Promise.resolve({ status: 202, body: { taskId: 'opaque' } }) },
    dispatch: { resolve: () => Promise.resolve({ parameters: {} }) },
    providerEvents: { consume: () => Promise.resolve({ disposition: 'ACK' }) },
    repair: { run: () => Promise.resolve({ scanned: 0 }) },
    outbox: { publish: () => Promise.resolve({ published: 0 }) },
  };
}

describe('generation runtime observability', () => {
  it('renders the required Prometheus metrics with bounded labels only', () => {
    const metrics = new GenerationMetrics();

    metrics.recordTaskState('QUEUED');
    metrics.recordTransitionFailure('RUNNING', 'SUCCEEDED', 'VERSION_CONFLICT');
    metrics.observeQueueAge(12.5);
    metrics.setRepairCases('AMBIGUOUS_PROVIDER_RESULT', 2);
    metrics.setFinancialSagaLag('SETTLEMENT', 31);

    const output = metrics.render();
    expect(output).toContain('# TYPE generation_tasks_total counter');
    expect(output).toContain('generation_tasks_total{status="QUEUED"} 1');
    expect(output).toContain('# TYPE generation_transition_failures_total counter');
    expect(output).toContain(
      'generation_transition_failures_total{from_status="RUNNING",reason="VERSION_CONFLICT",to_status="SUCCEEDED"} 1',
    );
    expect(output).toContain('# TYPE generation_queue_age_seconds summary');
    expect(output).toContain('generation_queue_age_seconds_sum 12.5');
    expect(output).toContain('generation_repair_cases{reason="AMBIGUOUS_PROVIDER_RESULT"} 2');
    expect(output).toContain('generation_financial_saga_lag_seconds{phase="SETTLEMENT"} 31');
    expect(output).not.toMatch(/task_id|user_id|provider_task_id/);
  });

  it('rejects unbounded label values instead of exporting attacker-controlled labels', () => {
    const metrics = new GenerationMetrics();

    expect(() => {
      metrics.recordTaskState('task-0198' as 'QUEUED');
    }).toThrow('INVALID_METRIC_LABEL');
    expect(() => {
      metrics.recordTransitionFailure('RUNNING', 'FAILED', 'task-0198' as 'VERSION_CONFLICT');
    }).toThrow('INVALID_METRIC_LABEL');
  });

  it('keeps liveness independent and returns only boolean readiness checks', async () => {
    const probes: Readonly<Record<string, ReadinessProbe>> = {
      database: vi.fn().mockResolvedValue(true),
      message_bus: vi.fn().mockRejectedValue(new Error('secret://must-not-leak')),
    };
    const controller = new GenerationRuntimeController(new GenerationMetrics(), probes, 50);

    expect(controller.liveness()).toEqual({ status: 'ok' });
    await expect(controller.readiness()).resolves.toEqual({
      status: 'not_ready',
      checks: { database: true, message_bus: false },
    });
    expect(JSON.stringify(await controller.readiness())).not.toContain('secret://');
  });

  it('fails closed when a readiness dependency does not answer before the deadline', async () => {
    const controller = new GenerationRuntimeController(
      new GenerationMetrics(),
      { database: () => new Promise<boolean>(() => undefined) },
      1,
    );

    await expect(controller.readiness()).resolves.toEqual({
      status: 'not_ready',
      checks: { database: false },
    });
  });

  it('serves liveness, readiness and Prometheus media types over HTTP', async () => {
    const controller = new GenerationRuntimeController(
      new GenerationMetrics(),
      { database: () => Promise.resolve(true), message_bus: () => Promise.resolve(true) },
      50,
    );
    const runtime = createGenerationRuntimeServer(controller, businessRuntime(), SECURITY);
    await runtime.listen(0, '127.0.0.1');
    try {
      expect((await fetch(`${runtime.url}/health/live`)).status).toBe(200);
      expect((await fetch(`${runtime.url}/health/ready`)).status).toBe(200);
      const metrics = await fetch(`${runtime.url}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get('content-type')).toContain('text/plain');
      expect(await metrics.text()).toContain('generation_tasks_total');
      expect((await fetch(`${runtime.url}/unknown`)).status).toBe(404);
      const task = await fetch(`${runtime.url}/v1/tasks`, { method: 'POST', body: '{}' });
      expect(task.status).toBe(202);
      expect(await task.json()).toEqual({ taskId: 'opaque' });
      expect(
        (
          await fetch(`${runtime.url}/internal/provider-events`, {
            method: 'POST',
            headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
            body: '{}',
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${runtime.url}/internal/repair/run`, {
            method: 'POST',
            headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${runtime.url}/internal/outbox/publish`, {
            method: 'POST',
            headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
          })
        ).status,
      ).toBe(200);
      for (const path of [
        '/internal/provider-events',
        '/internal/repair/run',
        '/internal/outbox/publish',
        '/internal/dispatch',
      ]) {
        expect((await fetch(`${runtime.url}${path}`, { method: 'POST' })).status).toBe(401);
        expect(
          (
            await fetch(`${runtime.url}${path}`, {
              method: 'POST',
              headers: { authorization: 'Bearer invalid-token-value-000000000000' },
            })
          ).status,
        ).toBe(401);
      }
    } finally {
      await runtime.close();
    }
  });

  it('streams task events as they arrive without waiting for the source to complete', async () => {
    const source = new Subject<{
      readonly id: string;
      readonly type: string;
      readonly data: unknown;
    }>();
    let subscribed!: () => void;
    const connected = new Promise<void>((resolve) => {
      subscribed = resolve;
    });
    const business = businessRuntime();
    const runtime = createGenerationRuntimeServer(
      new GenerationRuntimeController(new GenerationMetrics(), {
        database: () => Promise.resolve(true),
      }),
      {
        ...business,
        taskApi: {
          handle: () =>
            Promise.resolve({
              status: 200,
              body: null,
              contentType: 'text/event-stream' as const,
              stream: new Observable((subscriber) => {
                subscribed();
                return source.subscribe(subscriber);
              }),
            }),
        },
      },
      SECURITY,
    );
    await runtime.listen();
    try {
      const responsePromise = fetch(`${runtime.url}/v1/tasks/task/events`);
      await connected;
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      if (reader === undefined) throw new Error('EXPECTED_RESPONSE_BODY');

      source.next({ id: '1:first', type: 'task-transition', data: { status: 'RUNNING' } });
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('data: {"status":"RUNNING"}');

      source.next({ id: '2:second', type: 'task-transition', data: { status: 'SUCCEEDED' } });
      const second = await reader.read();
      expect(new TextDecoder().decode(second.value)).toContain('data: {"status":"SUCCEEDED"}');

      await expect(runtime.close()).resolves.toBeUndefined();
      await expect(reader.read()).resolves.toMatchObject({ done: true });
    } finally {
      source.complete();
      await runtime.close();
    }
  });

  it('fails readiness and startup closed without a ready business runtime', async () => {
    const controller = new GenerationRuntimeController(
      new GenerationMetrics(),
      { database: () => Promise.resolve(true) },
      50,
    );
    const runtime = createGenerationRuntimeServer(controller, businessRuntime(false), SECURITY);
    await runtime.listen();
    try {
      const response = await fetch(`${runtime.url}/health/ready`);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        checks: { business_runtime: false, database: true },
      });
    } finally {
      await runtime.close();
    }
    await expect(
      bootstrapGenerationRuntime({
        READINESS_DATABASE_URL: 'http://database/ready',
        READINESS_MESSAGE_BUS_URL: 'http://message-bus/ready',
        READINESS_WALLET_URL: 'http://wallet/ready',
        READINESS_ROUTING_URL: 'http://routing/ready',
        READINESS_ASSET_URL: 'http://asset/ready',
        PROVIDER_RUNTIME_API_URL: 'http://provider-runtime/',
        INTERNAL_SERVICE_AUTH_TOKEN: INTERNAL_TOKEN,
      }),
    ).rejects.toThrow('DATABASE_URL_REQUIRED');
  });

  it('bundled composition routes task reads through the real service and Prisma repository', async () => {
    const task = {
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
      userId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
      quoteId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a3',
      capabilityVersionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4',
      parametersSnapshot: { prompt: 'frozen prompt' },
      parametersSnapshotSha256: 'b'.repeat(64),
      status: 'RUNNING',
      version: 4,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:01:00.000Z'),
    } as const;
    const findFirst = vi.fn().mockResolvedValue(task);
    const replaySignatures = new Set<string>();
    const replayCreate = vi.fn((input: { data: { messageId: string } }) => {
      if (replaySignatures.has(input.data.messageId))
        return Promise.reject(new Error('UNIQUE_CONSTRAINT'));
      replaySignatures.add(input.data.messageId);
      return Promise.resolve({});
    });
    const transaction = {
      generationTask: { findFirst: vi.fn().mockResolvedValue(null) },
      inboxMessage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: replayCreate,
      },
    };
    const prisma = {
      generationTask: { findFirst },
      taskTransition: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51c0',
            taskId: task.id,
            taskVersion: 4,
            toStatus: 'RUNNING',
            createdAt: task.updatedAt,
          },
        ]),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $transaction: vi.fn(async (operation: (value: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
      ),
    } as never;
    const composition = await createProductionGenerationComposition(
      {
        INTERNAL_SERVICE_AUTH_TOKENS: `${INTERNAL_TOKEN},${PREVIOUS_INTERNAL_TOKEN}`,
        GATEWAY_IDENTITY_HMAC_SECRETS: `${GATEWAY_SECRET},${PREVIOUS_GATEWAY_SECRET}`,
      },
      new GenerationMetrics(),
      {
        prisma,
        routing: { getQuote: vi.fn() },
        wallet: { reserve: vi.fn(), release: vi.fn(), settle: vi.fn() },
        asset: { requestImport: vi.fn() },
        cancellation: null,
        providerStatus: { inspect: vi.fn() },
        messageTransport: {
          ready: vi.fn().mockResolvedValue(true),
          publishPending: vi.fn().mockResolvedValue({ published: 0 }),
          transitionNotifications: EMPTY,
        },
      },
    );
    const runtime = createGenerationRuntimeServer(
      new GenerationRuntimeController(new GenerationMetrics(), {
        database: () => Promise.resolve(true),
      }),
      composition,
      SECURITY,
    );
    await runtime.listen();
    try {
      const unsigned = await fetch(`${runtime.url}/v1/tasks/${task.id}`, {
        headers: { 'x-authenticated-user-id': task.userId },
      });
      expect(unsigned.status).toBe(401);
      const malformedBody = '{';
      const malformedPath = '/v1/tasks';
      const malformedHeaders = gatewayHeaders(task.userId, 'POST', malformedPath, malformedBody, {
        secret: PREVIOUS_GATEWAY_SECRET,
        idempotencyKey: 'malformed-json-request',
      });
      const tamperedIdempotency = await fetch(`${runtime.url}${malformedPath}`, {
        method: 'POST',
        headers: { ...malformedHeaders, 'idempotency-key': 'tampered-key' },
        body: malformedBody,
      });
      expect(tamperedIdempotency.status).toBe(401);
      expect(replayCreate).not.toHaveBeenCalled();
      const malformed = await fetch(`${runtime.url}${malformedPath}`, {
        method: 'POST',
        headers: malformedHeaders,
        body: malformedBody,
      });
      expect(malformed.status).toBe(400);
      const invalidSignaturePath = `/v1/tasks/${task.id}?signature=invalid`;
      const invalidSignatureHeaders = gatewayHeaders(task.userId, 'GET', invalidSignaturePath);
      const invalidSignature = await fetch(`${runtime.url}${invalidSignaturePath}`, {
        headers: { ...invalidSignatureHeaders, 'x-gateway-signature': '0'.repeat(64) },
      });
      expect(invalidSignature.status).toBe(401);
      const impersonatedHeaders = gatewayHeaders(task.userId, 'GET', `/v1/tasks/${task.id}`);
      const impersonated = await fetch(`${runtime.url}/v1/tasks/${task.id}`, {
        headers: {
          ...impersonatedHeaders,
          'x-authenticated-user-id': '0198f4d4-21c2-7b7d-8a03-08a0da2a51ff',
        },
      });
      expect(impersonated.status).toBe(401);
      const invalidPath = '/v1/tasks/not-a-uuid';
      const invalid = await fetch(`${runtime.url}${invalidPath}`, {
        headers: gatewayHeaders(task.userId, 'GET', invalidPath),
      });
      expect(invalid.status).toBe(400);
      const missingTaskId = '0198f4d4-21c2-7b7d-8a03-08a0da2a51d0';
      findFirst.mockResolvedValueOnce(null);
      const missingPath = `/v1/tasks/${missingTaskId}`;
      const missing = await fetch(`${runtime.url}${missingPath}`, {
        headers: gatewayHeaders(task.userId, 'GET', missingPath),
      });
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toMatchObject({ code: 'TASK_NOT_FOUND' });
      const cancelPath = `/v1/tasks/${task.id}/cancel`;
      const conflict = await fetch(`${runtime.url}${cancelPath}`, {
        method: 'POST',
        headers: gatewayHeaders(task.userId, 'POST', cancelPath),
      });
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toMatchObject({ code: 'TASK_STATE_CONFLICT' });
      const failurePath = `/v1/tasks/${task.id}?failure=1`;
      findFirst.mockRejectedValueOnce(new Error('database-password-must-not-leak'));
      const failure = await fetch(`${runtime.url}${failurePath}`, {
        headers: gatewayHeaders(task.userId, 'GET', failurePath),
      });
      expect(failure.status).toBe(500);
      const failureBody = (await failure.json()) as { code: string; traceId: string };
      expect(failureBody).toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(failureBody.traceId).toMatch(/^[a-f0-9]{32}$/);
      expect(JSON.stringify(failureBody)).not.toContain('database-password');
      const validHeaders = gatewayHeaders(task.userId, 'GET', `/v1/tasks/${task.id}`);
      const [response, sameRequestNewNonce] = await Promise.all([
        fetch(`${runtime.url}/v1/tasks/${task.id}`, { headers: validHeaders }),
        fetch(`${runtime.url}/v1/tasks/${task.id}`, {
          headers: gatewayHeaders(task.userId, 'GET', `/v1/tasks/${task.id}`),
        }),
      ]);
      expect(response.status).toBe(200);
      expect(sameRequestNewNonce.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ id: task.id, status: 'RUNNING' });
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: task.id, userId: task.userId } }),
      );
      expect(
        (await fetch(`${runtime.url}/v1/tasks/${task.id}`, { headers: validHeaders })).status,
      ).toBe(401);
      const eventsPath = `/v1/tasks/${task.id}/events`;
      const tamperedEventHeaders = gatewayHeaders(task.userId, 'GET', eventsPath, '', {
        lastEventId: 'transition-1',
      });
      expect(
        (
          await fetch(`${runtime.url}${eventsPath}`, {
            headers: { ...tamperedEventHeaders, 'last-event-id': 'transition-2' },
          })
        ).status,
      ).toBe(401);
      const events = await fetch(`${runtime.url}/v1/tasks/${task.id}/events`, {
        headers: gatewayHeaders(task.userId, 'GET', eventsPath),
      });
      expect(events.status).toBe(200);
      expect(events.headers.get('content-type')).toContain('text/event-stream');
      expect(await events.text()).toContain('event: task-transition');
      const dispatchBody = JSON.stringify({
        taskId: task.id,
        capabilityVersionId: task.capabilityVersionId,
        parametersSnapshotSha256: task.parametersSnapshotSha256,
      });
      const dispatch = await fetch(`${runtime.url}/internal/dispatch`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${PREVIOUS_INTERNAL_TOKEN}`,
          'content-type': 'application/json',
        },
        body: dispatchBody,
      });
      expect(dispatch.status).toBe(200);
      await expect(dispatch.json()).resolves.toEqual({ parameters: task.parametersSnapshot });
      expect(findFirst).toHaveBeenCalledWith({
        where: {
          id: task.id,
          capabilityVersionId: task.capabilityVersionId,
          parametersSnapshotSha256: task.parametersSnapshotSha256,
        },
        select: { parametersSnapshot: true },
      });
      expect((await fetch(`${runtime.url}/health/ready`)).status).toBe(200);
    } finally {
      await runtime.close();
    }
  });

  it('uses a non-root multi-stage image with an HTTP healthcheck', async () => {
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
    const dockerignore = await readFile(
      new URL('../Dockerfile.dockerignore', import.meta.url),
      'utf8',
    );

    expect(dockerfile).toMatch(/^FROM node:24\.15\.0-bookworm-slim AS build/m);
    expect(dockerfile).toMatch(/^FROM node:24\.15\.0-bookworm-slim AS runtime/m);
    expect(dockerfile).toMatch(/^USER 10001:10001/m);
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('/health/live');
    expect(dockerfile).toContain('pnpm install --lockfile=false');
    expect(dockerfile).not.toContain('--frozen-lockfile');
    expect(dockerfile).not.toMatch(/DATABASE_URL=|SECRET=|TOKEN=/);
    expect(dockerignore).toContain('**/node_modules');
    expect(dockerignore).toContain('**/dist');
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { files?: string[] };
    expect(manifest.files).toEqual(['dist', 'prisma/migrations', 'package.json']);
  });

  it('requires named durable dependency probes without accepting credential-bearing URLs', () => {
    expect(
      loadGenerationRuntimeConfig({
        PORT: '3000',
        READINESS_DATABASE_URL: 'http://database:8080/ready',
        READINESS_MESSAGE_BUS_URL: 'http://message-bus:8080/ready',
        READINESS_WALLET_URL: 'http://wallet:8080/ready',
        READINESS_ROUTING_URL: 'http://routing:8080/ready',
        READINESS_ASSET_URL: 'http://asset:8080/ready',
        PROVIDER_RUNTIME_API_URL: 'http://provider-runtime:3001/',
        INTERNAL_SERVICE_AUTH_TOKENS: `${INTERNAL_TOKEN},${PREVIOUS_INTERNAL_TOKEN}`,
      }),
    ).toMatchObject({
      port: 3000,
      host: '0.0.0.0',
      readinessUrls: { provider_runtime: new URL('http://provider-runtime:3001/health/ready') },
      internalServiceAuthTokens: [INTERNAL_TOKEN, PREVIOUS_INTERNAL_TOKEN],
    });
    expect(() =>
      loadGenerationRuntimeConfig({
        PORT: '3000',
        READINESS_DATABASE_URL: 'http://user:password@database:8080/ready',
        READINESS_MESSAGE_BUS_URL: 'http://message-bus:8080/ready',
        READINESS_WALLET_URL: 'http://wallet:8080/ready',
        READINESS_ROUTING_URL: 'http://routing:8080/ready',
        READINESS_ASSET_URL: 'http://asset:8080/ready',
        PROVIDER_RUNTIME_API_URL: 'http://provider-runtime:3001/',
        INTERNAL_SERVICE_AUTH_TOKEN: INTERNAL_TOKEN,
      }),
    ).toThrow('INVALID_READINESS_URL');
  });

  it('ships an executable runbook for every WS13 failure and recovery boundary', async () => {
    const runbook = await readFile(
      new URL('../../../docs/runbooks/generation-provider.md', import.meta.url),
      'utf8',
    );

    for (const required of [
      '原始字节',
      '密钥轮换',
      '重放',
      '半开',
      '死信',
      'providerTaskId',
      'routeEpoch',
      '全额释放',
      '回滚',
      'callback-out-of-order',
      '负责人',
      '关闭条件',
    ]) {
      expect(runbook).toContain(required);
    }
  });
});
