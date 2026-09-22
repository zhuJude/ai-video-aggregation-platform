import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { MockProviderClient } from '@repo/mock-provider';
import { describe, expect, it, vi } from 'vitest';
import {
  ProviderRuntimeController,
  ProviderRuntimeMetrics,
  createProviderRuntimeServer,
  type ProviderBusinessRuntime,
  type ReadinessProbe,
} from '../src/runtime/operations.js';
import { bootstrapProviderRuntime, loadProviderRuntimeConfig } from '../src/runtime/main.js';
import {
  HttpMockDispatchResolver,
  createProductionProviderComposition,
} from '../src/runtime/production-composition.js';

const INTERNAL_TOKEN = 'internal-service-token-value-000001';
const PREVIOUS_INTERNAL_TOKEN = 'previous-internal-token-value-00001';
const SECURITY = { internalServiceAuthTokens: [INTERNAL_TOKEN, PREVIOUS_INTERNAL_TOKEN] };
const INTERNAL_HEADERS = { authorization: `Bearer ${INTERNAL_TOKEN}` };

function businessRuntime(ready = true): ProviderBusinessRuntime {
  return {
    readiness: () => Promise.resolve(ready),
    callbackIngress: {
      handle: () => Promise.resolve({ status: 202, body: { accepted: true } }),
    },
    execution: { consume: () => Promise.resolve({ disposition: 'ACK' }) },
    polling: { consume: () => Promise.resolve({ disposition: 'ACK' }) },
    health: { consume: () => Promise.resolve({ checked: 0 }) },
    control: {
      inspect: () => Promise.resolve({ state: 'RUNNING' }),
      cancel: () => Promise.resolve({ outcome: 'CONFIRMED' }),
    },
    outbox: { publish: () => Promise.resolve({ published: 0 }) },
  };
}

describe('provider runtime observability', () => {
  it('renders provider RED, circuit and polling metrics without identifiers', () => {
    const metrics = new ProviderRuntimeMetrics();

    metrics.observeProviderCall('CREATE', 'SUCCESS', 1.25);
    metrics.recordProviderError('QUERY', 'TIMEOUT');
    metrics.observeCircuitState('opaque-channel-a', 'OPEN');
    metrics.observeCircuitState('opaque-channel-b', 'OPEN');
    metrics.setPollingBacklog(7);

    const output = metrics.render();
    expect(output).toContain('# TYPE provider_request_duration_seconds summary');
    expect(output).toContain(
      'provider_request_duration_seconds_sum{operation="CREATE",outcome="SUCCESS"} 1.25',
    );
    expect(output).toContain('provider_errors_total{error_class="TIMEOUT",operation="QUERY"} 1');
    expect(output).toContain('provider_circuit_state{state="OPEN"} 2');
    expect(output).toContain('provider_polling_backlog 7');
    expect(output).toContain('provider_circuit_state{state="CLOSED"} 0');
    expect(output).toContain('provider_circuit_state{state="HALF_OPEN"} 0');
    expect(output).not.toMatch(/task_id|user_id|provider_task_id|execution_id/);
  });

  it('permits only fixed low-cardinality provider labels', () => {
    const metrics = new ProviderRuntimeMetrics();

    expect(() => {
      metrics.observeProviderCall('provider-123' as 'CREATE', 'SUCCESS', 1);
    }).toThrow('INVALID_METRIC_LABEL');
    expect(() => {
      metrics.recordProviderError('CREATE', 'provider-task-123' as 'TIMEOUT');
    }).toThrow('INVALID_METRIC_LABEL');
    expect(() => {
      metrics.observeProviderCall('CREATE', 'SUCCESS', Number.NaN);
    }).toThrow('INVALID_METRIC_VALUE');
    expect(() => {
      metrics.setPollingBacklog(-1);
    }).toThrow('INVALID_METRIC_VALUE');
  });

  it('replaces the durable circuit snapshot and resets absent states', () => {
    const metrics = new ProviderRuntimeMetrics();
    metrics.refreshCircuitStateCounts({ CLOSED: 2, OPEN: 1, HALF_OPEN: 3 });
    expect(metrics.render()).toContain('provider_circuit_state{state="HALF_OPEN"} 3');

    metrics.refreshCircuitStateCounts({ CLOSED: 4, OPEN: 0, HALF_OPEN: 0 });
    const output = metrics.render();
    expect(output).toContain('provider_circuit_state{state="CLOSED"} 4');
    expect(output).toContain('provider_circuit_state{state="OPEN"} 0');
    expect(output).toContain('provider_circuit_state{state="HALF_OPEN"} 0');
  });

  it('reports durable dependency readiness without error or secret details', async () => {
    const probes: Readonly<Record<string, ReadinessProbe>> = {
      database: vi.fn().mockResolvedValue(true),
      message_bus: vi.fn().mockResolvedValue(false),
      adapter_registry: vi.fn().mockRejectedValue(new Error('api-key-must-not-leak')),
    };
    const controller = new ProviderRuntimeController(new ProviderRuntimeMetrics(), probes, 50);

    expect(controller.liveness()).toEqual({ status: 'ok' });
    await expect(controller.readiness()).resolves.toEqual({
      status: 'not_ready',
      checks: { adapter_registry: false, database: true, message_bus: false },
    });
    expect(JSON.stringify(await controller.readiness())).not.toContain('api-key');
  });

  it('fails readiness closed when a durable dependency exceeds the probe deadline', async () => {
    const controller = new ProviderRuntimeController(
      new ProviderRuntimeMetrics(),
      { database: () => new Promise<boolean>(() => undefined) },
      1,
    );

    await expect(controller.readiness()).resolves.toEqual({
      status: 'not_ready',
      checks: { database: false },
    });
  });

  it('serves liveness, readiness and Prometheus media types over HTTP', async () => {
    const controller = new ProviderRuntimeController(
      new ProviderRuntimeMetrics(),
      {
        adapter_registry: () => Promise.resolve(true),
        database: () => Promise.resolve(true),
        message_bus: () => Promise.resolve(false),
      },
      50,
    );
    const runtime = createProviderRuntimeServer(controller, businessRuntime(), SECURITY);
    await runtime.listen(0, '127.0.0.1');
    try {
      expect((await fetch(`${runtime.url}/health/live`)).status).toBe(200);
      expect((await fetch(`${runtime.url}/health/ready`)).status).toBe(503);
      const metrics = await fetch(`${runtime.url}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get('content-type')).toContain('text/plain');
      expect(await metrics.text()).toContain('provider_polling_backlog');
      expect((await fetch(`${runtime.url}/unknown`)).status).toBe(404);
      expect(
        (
          await fetch(`${runtime.url}/health/live`, {
            method: 'POST',
          })
        ).status,
      ).toBe(405);
      await runtime.listen(0, '127.0.0.1');
      expect(
        (
          await fetch(`${runtime.url}/callbacks/mock`, {
            method: 'POST',
            body: '{}',
          })
        ).status,
      ).toBe(202);
      expect(
        (
          await fetch(`${runtime.url}/internal/execution/consume`, {
            method: 'POST',
            headers: INTERNAL_HEADERS,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${runtime.url}/internal/polling/consume`, {
            method: 'POST',
            headers: INTERNAL_HEADERS,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${runtime.url}/internal/health/run`, {
            method: 'POST',
            headers: INTERNAL_HEADERS,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${runtime.url}/internal/outbox/publish`, {
            method: 'POST',
            headers: { authorization: `Bearer ${PREVIOUS_INTERNAL_TOKEN}` },
          })
        ).status,
      ).toBe(200);
      for (const path of [
        '/internal/execution/consume',
        '/internal/polling/consume',
        '/internal/health/run',
        '/internal/outbox/publish',
        '/inspect',
        '/cancel',
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
      await runtime.close();
    }
  });

  it('fails readiness and startup closed without a ready business runtime', async () => {
    const controller = new ProviderRuntimeController(
      new ProviderRuntimeMetrics(),
      { database: () => Promise.resolve(true) },
      50,
    );
    const runtime = createProviderRuntimeServer(controller, businessRuntime(false), SECURITY);
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
      bootstrapProviderRuntime({
        READINESS_DATABASE_URL: 'http://database/ready',
        READINESS_MESSAGE_BUS_URL: 'http://message-bus/ready',
        READINESS_ADAPTER_REGISTRY_URL: 'http://registry/ready',
        INTERNAL_SERVICE_AUTH_TOKEN: INTERNAL_TOKEN,
      }),
    ).rejects.toThrow('DATABASE_URL_REQUIRED');
  });

  it('resolves frozen dispatch parameters from the exact authenticated Generation endpoint', async () => {
    const parameters = { prompt: 'frozen prompt' };
    const hash = createHash('sha256').update(JSON.stringify(parameters)).digest('hex');
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ parameters }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    try {
      const resolver = new HttpMockDispatchResolver(
        new URL('http://generation:3000/internal/dispatch'),
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51a7',
        'mock-video-v1',
        new MockProviderClient({
          baseUrl: 'http://mock-provider:3002',
          callbackSecret: 'test-secret',
        }),
        INTERNAL_TOKEN,
      );
      await expect(
        resolver.resolve({
          taskId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
          capabilityVersionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4',
          parametersSnapshotSha256: hash,
        }),
      ).resolves.toMatchObject({ parameters, modelCode: 'mock-video-v1' });
      const [dispatchUrl, dispatchRequest] = request.mock.calls[0] as [URL, RequestInit];
      expect(dispatchUrl).toEqual(new URL('http://generation:3000/internal/dispatch'));
      expect(dispatchRequest.headers).toMatchObject({
        authorization: `Bearer ${INTERNAL_TOKEN}`,
      });
    } finally {
      request.mockRestore();
    }
  });

  it('bundled composition routes signed callbacks through the real service and Prisma repository', async () => {
    const providerId = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a7';
    const callbackCreate = vi.fn().mockResolvedValue({});
    const pollingCount = vi.fn().mockResolvedValue(7);
    const transaction = {
      callbackInbox: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: callbackCreate,
        update: vi.fn().mockResolvedValue({}),
      },
      providerExecution: {
        findUnique: vi.fn().mockResolvedValue({
          id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
          taskId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
          modelCode: 'mock-video-v1',
          status: 'ACCEPTED',
          currentAttempt: 1,
          routeEpoch: 0,
          lastProviderSequence: -1,
          version: 0,
          traceId: 'a'.repeat(32),
          correlationId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      circuitState: {
        groupBy: vi.fn().mockResolvedValue([
          { status: 'CLOSED', _count: { _all: 2 } },
          { status: 'OPEN', _count: { _all: 1 } },
        ]),
      },
      providerAttempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
      ),
      $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
      $disconnect: vi.fn().mockResolvedValue(undefined),
      providerExecution: {
        count: pollingCount,
        findFirst: vi.fn().mockResolvedValue({
          id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
          taskId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
          providerId,
          modelCode: 'mock-video-v1',
          providerTaskId: 'remote-1',
          routeEpoch: 0,
          status: 'RUNNING',
          attempts: [{ status: 'ACCEPTED', providerTaskId: 'remote-1' }],
        }),
      },
      circuitState: {
        groupBy: vi.fn().mockResolvedValue([
          { status: 'CLOSED', _count: { _all: 2 } },
          { status: 'OPEN', _count: { _all: 1 } },
        ]),
      },
    } as never;
    const metrics = new ProviderRuntimeMetrics();
    const composition = await createProductionProviderComposition(
      {
        MOCK_PROVIDER_ID: providerId,
        MOCK_PROVIDER_MODEL_CODE: 'mock-video-v1',
        MOCK_PROVIDER_URL: 'http://mock-provider:3002',
        MOCK_PROVIDER_CALLBACK_SECRET: 'test-secret',
        INTERNAL_SERVICE_AUTH_TOKEN: INTERNAL_TOKEN,
      },
      metrics,
      {
        prisma,
        dispatch: { resolve: vi.fn() },
        messageTransport: {
          ready: vi.fn().mockResolvedValue(true),
          publishPending: vi.fn().mockResolvedValue({ published: 0 }),
        },
        controlAdapter: {
          cancelTask: vi.fn().mockResolvedValue({ state: 'CANCELED' }),
        },
      },
    );
    const runtime = createProviderRuntimeServer(
      new ProviderRuntimeController(metrics, { database: () => Promise.resolve(true) }),
      composition,
      SECURITY,
    );
    const callbackBody = Buffer.from(
      JSON.stringify({
        eventId: 'mock-event-1',
        providerTaskId: 'remote-1',
        sequence: 1,
        state: 'RUNNING',
        occurredAt: '2026-09-01T00:00:00.000Z',
      }),
    );
    const callbackHeaders = {
      'x-mock-signature': `sha256=${createHmac('sha256', 'test-secret').update(callbackBody).digest('hex')}`,
      'x-provider-event-id': 'mock-event-1',
      'x-provider-sequence': '1',
    };
    await runtime.listen();
    try {
      const response = await fetch(`${runtime.url}/callbacks/${providerId}`, {
        method: 'POST',
        headers: { ...callbackHeaders, 'content-type': 'application/json' },
        body: callbackBody.toString('utf8'),
      });
      expect(response.status).toBe(202);
      expect(callbackCreate).toHaveBeenCalledOnce();
      const rejected = await fetch(`${runtime.url}/callbacks/${providerId}`, {
        method: 'POST',
        headers: { ...callbackHeaders, 'content-type': 'application/json' },
        body: callbackBody.toString('utf8').replace('RUNNING', 'ACCEPTED'),
      });
      expect(rejected.status).toBe(401);
      const inspected = await fetch(`${runtime.url}/inspect`, {
        method: 'POST',
        headers: { ...INTERNAL_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
          providerId,
          executionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
          providerTaskId: 'remote-1',
          routeEpoch: 0,
        }),
      });
      expect(inspected.status).toBe(200);
      await expect(inspected.json()).resolves.toMatchObject({
        state: 'RUNNING',
        acceptance: 'ACCEPTED',
        billing: 'UNKNOWN',
      });
      const canceled = await fetch(`${runtime.url}/cancel`, {
        method: 'POST',
        headers: { ...INTERNAL_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
          providerTaskId: 'remote-1',
          businessKey: 'task:0198f4d4-21c2-7b7d-8a03-08a0da2a51a2:cancel',
          traceId: 'a'.repeat(32),
        }),
      });
      expect(canceled.status).toBe(200);
      await expect(canceled.json()).resolves.toEqual({ outcome: 'CONFIRMED' });
      expect((await fetch(`${runtime.url}/health/ready`)).status).toBe(200);
      expect(metrics.render()).toContain('provider_polling_backlog 7');
      expect(metrics.render()).toContain('provider_circuit_state{state="CLOSED"} 2');
      expect(metrics.render()).toContain('provider_circuit_state{state="OPEN"} 1');
      pollingCount.mockRejectedValueOnce(new Error('database unavailable'));
      expect((await fetch(`${runtime.url}/health/ready`)).status).toBe(503);
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
    expect(dockerfile).toContain('pnpm-lock.yaml');
    expect(dockerfile).toContain('pnpm install --frozen-lockfile');
    expect(dockerfile).not.toMatch(/--lockfile=false|--no-frozen-lockfile/);
    expect(dockerfile).not.toMatch(/DATABASE_URL=|SECRET=|TOKEN=/);
    expect(dockerignore).toContain('**/node_modules');
    expect(dockerignore).toContain('**/dist');
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { files?: string[] };
    expect(manifest.files).toEqual(['dist', 'prisma/migrations', 'package.json']);
  });

  it('requires database, message bus and adapter registry readiness probes', () => {
    expect(
      loadProviderRuntimeConfig({
        PORT: '3001',
        READINESS_DATABASE_URL: 'http://database:8080/ready',
        READINESS_MESSAGE_BUS_URL: 'http://message-bus:8080/ready',
        READINESS_ADAPTER_REGISTRY_URL: 'http://adapter-registry:8080/ready',
        INTERNAL_SERVICE_AUTH_TOKENS: `${INTERNAL_TOKEN},${PREVIOUS_INTERNAL_TOKEN}`,
      }),
    ).toMatchObject({
      port: 3001,
      host: '0.0.0.0',
      internalServiceAuthTokens: [INTERNAL_TOKEN, PREVIOUS_INTERNAL_TOKEN],
    });
    expect(() =>
      loadProviderRuntimeConfig({
        PORT: '3001',
        READINESS_DATABASE_URL: 'not-a-url',
        READINESS_MESSAGE_BUS_URL: 'http://message-bus:8080/ready',
        READINESS_ADAPTER_REGISTRY_URL: 'http://adapter-registry:8080/ready',
        INTERNAL_SERVICE_AUTH_TOKEN: INTERNAL_TOKEN,
      }),
    ).toThrow('INVALID_READINESS_URL');
    expect(() =>
      loadProviderRuntimeConfig({
        PORT: '0',
        READINESS_DATABASE_URL: 'http://database:8080/ready',
        READINESS_MESSAGE_BUS_URL: 'http://message-bus:8080/ready',
        READINESS_ADAPTER_REGISTRY_URL: 'http://adapter-registry:8080/ready',
        INTERNAL_SERVICE_AUTH_TOKEN: INTERNAL_TOKEN,
      }),
    ).toThrow('INVALID_PORT');
    expect(() =>
      loadProviderRuntimeConfig({
        PORT: '3001',
        READINESS_DATABASE_URL: 'http://user:password@database:8080/ready',
        READINESS_MESSAGE_BUS_URL: 'http://message-bus:8080/ready',
        READINESS_ADAPTER_REGISTRY_URL: 'http://adapter-registry:8080/ready',
        INTERNAL_SERVICE_AUTH_TOKEN: INTERNAL_TOKEN,
      }),
    ).toThrow('INVALID_READINESS_URL');
  });
});
