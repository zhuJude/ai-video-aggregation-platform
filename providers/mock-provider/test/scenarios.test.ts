import { createHmac } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { runAdapterConformance, type VideoProviderAdapter } from '@repo/provider-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MockProviderClient,
  MockProviderHttpError,
  createMockProviderConformanceAdapter,
  createMockProviderServer,
  type CallbackDelivery,
  type MockProviderServer,
  type MockScenario,
} from '../src/server.js';

const TEST_SECRET = 'mock-provider-test-secret';
const input = {
  taskId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
  modelCode: 'mock-video-v1',
  parameters: { prompt: 'A deterministic sunrise', seconds: 4 },
};

const openServers: MockProviderServer[] = [];

async function setup(
  overrides: Partial<Parameters<typeof createMockProviderServer>[0]> = {},
): Promise<{
  server: MockProviderServer;
  client: MockProviderClient;
  callbacks: CallbackDelivery[];
}> {
  const callbacks: CallbackDelivery[] = [];
  const configuration: Parameters<typeof createMockProviderServer>[0] = {
    callbackSecret: TEST_SECRET,
    deliverCallback: (delivery) => {
      callbacks.push(delivery);
      return Promise.resolve();
    },
    timeoutDelayMs: 200,
    ...overrides,
  };
  if (overrides.callbackSecretRef !== undefined && overrides.callbackSecret === undefined) {
    delete configuration.callbackSecret;
  }
  const server = await createMockProviderServer(configuration);
  await server.listen();
  openServers.push(server);
  return {
    server,
    client: new MockProviderClient({ baseUrl: server.url, requestTimeoutMs: 100 }),
    callbacks,
  };
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => server.close()));
});

const scenarios = [
  'success',
  'failed',
  'timeout',
  'rate-limit',
  'server-error',
  'callback-lost',
  'callback-duplicate',
  'callback-out-of-order',
] as const satisfies readonly MockScenario[];

describe('deterministic scenarios', () => {
  it.each(scenarios)('selects the %s response from x-mock-scenario', async (scenario) => {
    const { client } = await setup();
    const request = client.create(input, {
      scenario,
      idempotencyKey: `scenario-${scenario}`,
    });

    if (scenario === 'timeout') {
      await expect(request).rejects.toMatchObject({ code: 'MOCK_TIMEOUT' });
    } else if (scenario === 'rate-limit') {
      await expect(request).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        status: 429,
        retryAfterSeconds: 2,
      });
    } else if (scenario === 'server-error') {
      await expect(request).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 });
    } else {
      await expect(request).resolves.toMatchObject({ scenario, state: 'ACCEPTED' });
    }
  });

  it('progresses success and failed tasks through deterministic terminal states', async () => {
    const { client } = await setup();
    const success = await client.create(input, {
      scenario: 'success',
      idempotencyKey: 'lifecycle-success',
    });
    const failed = await client.create(
      { ...input, taskId: `${input.taskId}-failed` },
      { scenario: 'failed', idempotencyKey: 'lifecycle-failed' },
    );

    await expect(client.get(success.providerTaskId)).resolves.toMatchObject({ state: 'RUNNING' });
    await expect(client.get(success.providerTaskId)).resolves.toMatchObject({
      state: 'SUCCEEDED',
      resultUrls: [`mock://results/${success.providerTaskId}.mp4`],
    });
    await expect(client.get(failed.providerTaskId)).resolves.toMatchObject({ state: 'RUNNING' });
    await expect(client.get(failed.providerTaskId)).resolves.toMatchObject({
      state: 'FAILED',
      errorCode: 'MOCK_GENERATION_FAILED',
      errorMessage: 'The deterministic mock generation failed.',
    });
  });
});

describe('HTTP endpoints and validation', () => {
  it('rejects a create body sent with a non-JSON runtime content type', async () => {
    const { server } = await setup();
    const response = await fetch(`${server.url}/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-idempotency-key': 'wrong-content-type',
        'x-mock-scenario': 'success',
      },
      body: JSON.stringify(input),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'INVALID_REQUEST', message: 'The request is invalid.' },
    });
  });

  it('returns sanitized stable errors for malformed requests and unknown tasks', async () => {
    const { server } = await setup();
    const malformed = await fetch(`${server.url}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mock-scenario': 'success' },
      body: JSON.stringify({ parameters: [] }),
    });
    const unknown = await fetch(`${server.url}/tasks/not-present`);

    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      error: { code: 'INVALID_REQUEST', message: 'The request is invalid.' },
    });
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual({
      error: { code: 'TASK_NOT_FOUND', message: 'The task was not found.' },
    });
  });

  it('returns a clearly non-real deterministic balance', async () => {
    const { client } = await setup();

    await expect(client.getBalance()).resolves.toEqual({
      unit: 'MOCK_CREDITS',
      available: '1000000',
      nonReal: true,
    });
  });

  it('has an idempotent cancel endpoint and never claims terminal work was canceled', async () => {
    const { client } = await setup();
    const cancellable = await client.create(input, {
      scenario: 'success',
      idempotencyKey: 'cancel-open',
    });

    await expect(client.cancel(cancellable.providerTaskId)).resolves.toMatchObject({
      state: 'CANCELED',
      canceled: true,
    });
    await expect(client.cancel(cancellable.providerTaskId)).resolves.toMatchObject({
      state: 'CANCELED',
      canceled: true,
    });

    const completed = await client.create(
      { ...input, taskId: `${input.taskId}-complete` },
      { scenario: 'success', idempotencyKey: 'cancel-terminal' },
    );
    await client.get(completed.providerTaskId);
    await client.get(completed.providerTaskId);
    await expect(client.cancel(completed.providerTaskId)).rejects.toMatchObject({
      code: 'TASK_TERMINAL',
      status: 409,
    });
  });
});

describe('idempotency', () => {
  it('replays an identical create with the same deterministic task ID without duplicate callbacks', async () => {
    const deliverCallback = vi.fn(() => Promise.resolve());
    const { client } = await setup({ deliverCallback });
    const options = { scenario: 'success' as const, idempotencyKey: 'same-command' };

    const first = await client.create(input, options);
    await client.get(first.providerTaskId);
    const replay = await client.create(input, options);

    expect(replay).toEqual(first);
    expect(deliverCallback).toHaveBeenCalledTimes(1);
  });

  it('returns a stable conflict when an idempotency key is reused for another payload', async () => {
    const { client } = await setup();
    await client.create(input, { scenario: 'success', idempotencyKey: 'conflict-command' });

    await expect(
      client.create(
        { ...input, parameters: { prompt: 'A different request' } },
        { scenario: 'success', idempotencyKey: 'conflict-command' },
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  });

  it('derives the same ID in independent server instances', async () => {
    const first = await setup();
    const second = await setup();

    const firstTask = await first.client.create(input, {
      scenario: 'success',
      idempotencyKey: 'stable-id',
    });
    const secondTask = await second.client.create(input, {
      scenario: 'success',
      idempotencyKey: 'stable-id',
    });

    expect(secondTask.providerTaskId).toBe(firstTask.providerTaskId);
  });
});

describe('signed callback sequences', () => {
  it('serializes callback delivery without holding up task mutations', async () => {
    const callbacks: CallbackDelivery[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstDeliveryStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const { client, server } = await setup({
      deliverCallback: async (delivery) => {
        if (delivery.body.sequence === 1) {
          firstStarted();
          await firstMayFinish;
        }
        callbacks.push(delivery);
      },
    });
    const created = await client.create(input, {
      scenario: 'success',
      idempotencyKey: 'parallel-polls',
    });

    const firstPoll = client.get(created.providerTaskId);
    await firstDeliveryStarted;
    const secondPoll = client.get(created.providerTaskId);
    const stateBeforeRelease = await Promise.race([
      secondPoll.then(() => 'settled' as const),
      new Promise<'waiting'>((resolve) => {
        setTimeout(() => {
          resolve('waiting');
        }, 20);
      }),
    ]);
    releaseFirst();
    const responses = await Promise.all([firstPoll, secondPoll]);
    await server.drainCallbacks();

    expect(stateBeforeRelease).toBe('settled');
    expect(responses.map(({ state }) => state)).toEqual(['RUNNING', 'SUCCEEDED']);
    expect(callbacks.map(({ body }) => body.sequence)).toEqual([1, 2]);
  });

  it('signs exact callback bytes and uses unique event IDs with monotonic sequence numbers', async () => {
    const { client, callbacks } = await setup();
    const created = await client.create(input, {
      scenario: 'success',
      idempotencyKey: 'signed-callbacks',
    });

    await client.get(created.providerTaskId);
    await client.get(created.providerTaskId);

    expect(callbacks.map(({ body }) => body.sequence)).toEqual([1, 2]);
    expect(new Set(callbacks.map(({ body }) => body.eventId)).size).toBe(2);
    for (const callback of callbacks) {
      const expected = createHmac('sha256', TEST_SECRET).update(callback.rawBody).digest('hex');
      expect(callback.headers['x-mock-signature']).toBe(`sha256=${expected}`);
      expect(callback.headers['x-provider-event-id']).toBe(callback.body.eventId);
      expect(callback.headers['x-provider-sequence']).toBe(String(callback.body.sequence));
    }
  });

  it('progresses callback-lost tasks without delivering callbacks', async () => {
    const { client, callbacks } = await setup();
    const created = await client.create(input, {
      scenario: 'callback-lost',
      idempotencyKey: 'lost-callbacks',
    });

    await client.get(created.providerTaskId);
    await expect(client.get(created.providerTaskId)).resolves.toMatchObject({ state: 'SUCCEEDED' });
    expect(callbacks).toEqual([]);
  });

  it('repeats the same event ID, payload bytes, and signature for callback-duplicate', async () => {
    const { client, callbacks } = await setup();
    const created = await client.create(input, {
      scenario: 'callback-duplicate',
      idempotencyKey: 'duplicate-callbacks',
    });

    await client.get(created.providerTaskId);
    await client.get(created.providerTaskId);
    const terminal = callbacks.slice(1);

    expect(terminal).toHaveLength(2);
    expect(terminal[1]?.body.eventId).toBe(terminal[0]?.body.eventId);
    expect(terminal[1]?.rawBody).toEqual(terminal[0]?.rawBody);
    expect(terminal[1]?.headers['x-mock-signature']).toBe(terminal[0]?.headers['x-mock-signature']);
  });

  it('delivers a higher sequence before a lower sequence for callback-out-of-order', async () => {
    const { client, callbacks } = await setup();
    const created = await client.create(input, {
      scenario: 'callback-out-of-order',
      idempotencyKey: 'out-of-order-callbacks',
    });

    await client.get(created.providerTaskId);

    expect(callbacks.map(({ body }) => body.sequence)).toEqual([2, 1]);
    expect(callbacks.map(({ body }) => body.state)).toEqual(['SUCCEEDED', 'RUNNING']);
  });

  it('exposes SDK callback verification and normalization without weakening the signature', async () => {
    const { server, client, callbacks } = await setup();
    const verifier = new MockProviderClient({ baseUrl: server.url, callbackSecret: TEST_SECRET });
    const sdkAdapter: VideoProviderAdapter = verifier;
    const created = await client.create(input, {
      scenario: 'success',
      idempotencyKey: 'adapter-callback',
    });
    await client.get(created.providerTaskId);
    const callback = callbacks[0];
    if (callback === undefined) throw new Error('EXPECTED_CALLBACK');

    await expect(
      verifier.verifyCallback({
        headers: { ...callback.headers },
        rawBody: callback.rawBody,
      }),
    ).resolves.toEqual({ valid: true, payload: callback.body });
    await expect(
      sdkAdapter.verifyCallback({
        headers: { ...callback.headers },
        body: callback.rawBody,
      }),
    ).resolves.toEqual({ valid: true, payload: callback.body });

    const prettyPrinted = Buffer.from(JSON.stringify(callback.body, null, 2));
    const reordered = Buffer.from(
      JSON.stringify({
        state: callback.body.state,
        sequence: callback.body.sequence,
        providerTaskId: callback.body.providerTaskId,
        occurredAt: callback.body.occurredAt,
        eventId: callback.body.eventId,
      }),
    );
    const tampered = Buffer.from(callback.rawBody.toString('utf8').replace('RUNNING', 'FAILED'));
    for (const rawBody of [prettyPrinted, reordered, tampered]) {
      await expect(
        verifier.verifyCallback({ headers: { ...callback.headers }, rawBody }),
      ).resolves.toEqual({ valid: false, payload: null });
    }
    await expect(
      verifier.verifyCallback({ headers: { ...callback.headers }, body: callback.body }),
    ).resolves.toEqual({ valid: false, payload: null });
    await expect(verifier.normalizeCallback({ payload: callback.body })).resolves.toEqual({
      state: 'RUNNING',
    });
  });

  it('rejects a callback state outside the frozen provider SDK states', async () => {
    const { client } = await setup();

    await expect(
      client.normalizeCallback({
        payload: {
          eventId: 'evt_invalid',
          providerTaskId: 'mock_invalid',
          sequence: 1,
          state: 'NOT_A_PROVIDER_STATE',
        },
      }),
    ).rejects.toThrow('INVALID_MOCK_CALLBACK');
  });
});

describe('secret resolution and bounded timeout behavior', () => {
  it('times out by default and makes an identical idempotent retry observable', async () => {
    const server = await createMockProviderServer({ callbackSecret: TEST_SECRET });
    await server.listen();
    openServers.push(server);
    const client = new MockProviderClient({ baseUrl: server.url });
    const options = { scenario: 'timeout' as const, idempotencyKey: 'default-timeout-retry' };

    await expect(client.create(input, options)).rejects.toMatchObject({
      code: 'MOCK_TIMEOUT',
      status: 408,
    });
    await expect(client.create(input, options)).resolves.toMatchObject({
      scenario: 'timeout',
      state: 'ACCEPTED',
    });
  });

  it('resolves a KMS-style secret reference through the injected resolver', async () => {
    const resolveSecret = vi.fn((reference: string) => {
      expect(reference).toBe('kms://mock-provider/callback');
      return Promise.resolve(TEST_SECRET);
    });
    const { client } = await setup({
      callbackSecretRef: 'kms://mock-provider/callback',
      resolveSecret,
    });

    await client.create(input, { scenario: 'success', idempotencyKey: 'kms-secret' });
    expect(resolveSecret).toHaveBeenCalledTimes(1);
  });

  it('turns the bounded timeout scenario into a stable client error', async () => {
    const { client } = await setup({ timeoutDelayMs: 200 });
    const started = performance.now();

    await expect(
      client.create(input, { scenario: 'timeout', idempotencyKey: 'bounded-timeout' }),
    ).rejects.toBeInstanceOf(MockProviderHttpError);
    expect(performance.now() - started).toBeLessThan(300);
  });
});

describe('callback delivery isolation', () => {
  it('allows a callback sink to query the same task without deadlocking mutation', async () => {
    const callbackClient: { current?: MockProviderClient } = {};
    const server = await createMockProviderServer({
      callbackSecret: TEST_SECRET,
      callbackDeliveryTimeoutMs: 30,
      deliverCallback: async (delivery) => {
        if (callbackClient.current === undefined) throw new Error('EXPECTED_CALLBACK_CLIENT');
        await callbackClient.current.get(delivery.body.providerTaskId);
      },
    });
    await server.listen();
    openServers.push(server);
    callbackClient.current = new MockProviderClient({ baseUrl: server.url, requestTimeoutMs: 80 });
    const created = await callbackClient.current.create(input, {
      scenario: 'success',
      idempotencyKey: 'reentrant-sink',
    });

    await expect(callbackClient.current.get(created.providerTaskId)).resolves.toMatchObject({
      state: 'RUNNING',
    });
    await server.drainCallbacks();
    await expect(callbackClient.current.get(created.providerTaskId)).resolves.toMatchObject({
      state: 'SUCCEEDED',
    });
  });

  it('bounds a never-settling sink and reports the failed attempt without blocking close', async () => {
    const failures: unknown[] = [];
    const server = await createMockProviderServer({
      callbackSecret: TEST_SECRET,
      callbackDeliveryTimeoutMs: 20,
      onCallbackError: (diagnostic) => {
        failures.push(diagnostic);
      },
      deliverCallback: () => new Promise(() => undefined),
    });
    await server.listen();
    openServers.push(server);
    const client = new MockProviderClient({ baseUrl: server.url, requestTimeoutMs: 80 });
    const created = await client.create(input, {
      scenario: 'success',
      idempotencyKey: 'never-settling-sink',
    });

    await expect(client.get(created.providerTaskId)).resolves.toMatchObject({ state: 'RUNNING' });
    await server.drainCallbacks();
    expect(failures).toHaveLength(1);
    expect(server.getDiagnostics()).toMatchObject({
      callbackAttempts: 1,
      callbackSuccesses: 0,
      callbackFailures: 1,
    });
    const started = performance.now();
    await server.close();
    expect(performance.now() - started).toBeLessThan(80);
  });

  it('retries callback delivery deterministically and records attempts separately from success', async () => {
    const deliveries: CallbackDelivery[] = [];
    const server = await createMockProviderServer({
      callbackSecret: TEST_SECRET,
      callbackMaxAttempts: 2,
      deliverCallback: (delivery, { attempt }) => {
        deliveries.push(delivery);
        return attempt === 1 ? Promise.reject(new Error('transient')) : Promise.resolve();
      },
    });
    await server.listen();
    openServers.push(server);
    const client = new MockProviderClient({ baseUrl: server.url });
    const created = await client.create(input, {
      scenario: 'success',
      idempotencyKey: 'callback-retry',
    });

    await client.get(created.providerTaskId);
    await server.drainCallbacks();

    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]?.body.eventId).toBe(deliveries[0]?.body.eventId);
    expect(server.getDiagnostics()).toMatchObject({
      callbackAttempts: 2,
      callbackSuccesses: 1,
      callbackFailures: 0,
    });
  });

  it('uses an immutable callback snapshot for every retry and for failure diagnostics', async () => {
    const observed: Array<{ eventId: string; rawBody: string; signature: string }> = [];
    const diagnostics: Array<{ eventId: string; sequence: number }> = [];
    const server = await createMockProviderServer({
      callbackSecret: TEST_SECRET,
      callbackMaxAttempts: 2,
      deliverCallback: (delivery) => {
        observed.push({
          eventId: delivery.body.eventId,
          rawBody: delivery.rawBody.toString('utf8'),
          signature: delivery.headers['x-mock-signature'] ?? '',
        });
        delivery.body.eventId = 'evt_mutated_by_sink';
        delivery.rawBody.fill(0);
        (delivery.headers as Record<string, string>)['x-mock-signature'] = 'mutated';
        return Promise.reject(new Error('receiver failure'));
      },
      onCallbackError: (diagnostic) => {
        diagnostics.push({ eventId: diagnostic.eventId, sequence: diagnostic.sequence });
      },
    });
    await server.listen();
    openServers.push(server);
    const client = new MockProviderClient({ baseUrl: server.url });
    const created = await client.create(input, {
      scenario: 'success',
      idempotencyKey: 'immutable-retry',
    });

    await client.get(created.providerTaskId);
    await server.drainCallbacks();

    expect(observed).toHaveLength(2);
    expect(observed[1]).toEqual(observed[0]);
    expect(diagnostics).toEqual([{ eventId: observed[0]?.eventId, sequence: 1 }]);
  });
});

describe('serialized cancellation and bounded retention', () => {
  it('makes out-of-order success terminal before cancellation and preserves callback snapshots', async () => {
    let callbackStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      callbackStarted = resolve;
    });
    const deliveries: CallbackDelivery[] = [];
    const { client, server } = await setup({
      deliverCallback: (delivery) => {
        deliveries.push(delivery);
        callbackStarted();
        return Promise.resolve();
      },
    });
    const pollFirst = await client.create(input, {
      scenario: 'callback-out-of-order',
      idempotencyKey: 'race-poll-first',
    });

    const polled = client.get(pollFirst.providerTaskId);
    await started;
    await expect(polled).resolves.toMatchObject({ state: 'SUCCEEDED' });
    await expect(client.cancel(pollFirst.providerTaskId)).rejects.toMatchObject({
      code: 'TASK_TERMINAL',
      status: 409,
    });
    await server.drainCallbacks();
    expect(deliveries.map(({ body }) => [body.sequence, body.state])).toEqual([
      [2, 'SUCCEEDED'],
      [1, 'RUNNING'],
    ]);

    const cancelFirst = await client.create(
      { ...input, taskId: `${input.taskId}-cancel-first` },
      { scenario: 'success', idempotencyKey: 'race-cancel-first' },
    );
    await client.cancel(cancelFirst.providerTaskId);
    await expect(client.get(cancelFirst.providerTaskId)).resolves.toMatchObject({
      state: 'CANCELED',
    });
    expect(deliveries).toHaveLength(2);
  });

  it('bounds retained state without expiring idempotency and clears state on close', async () => {
    const server = await createMockProviderServer({
      callbackSecret: TEST_SECRET,
      maxTasks: 1,
    });
    await server.listen();
    openServers.push(server);
    const client = new MockProviderClient({ baseUrl: server.url });
    const first = await client.create(input, {
      scenario: 'success',
      idempotencyKey: 'capacity-first',
    });
    await expect(
      client.create(
        { ...input, taskId: `${input.taskId}-full` },
        { scenario: 'success', idempotencyKey: 'capacity-full' },
      ),
    ).rejects.toMatchObject({ code: 'MOCK_CAPACITY_EXCEEDED', status: 503 });
    await client.get(first.providerTaskId);
    await client.get(first.providerTaskId);
    await expect(
      client.create(input, { scenario: 'success', idempotencyKey: 'capacity-first' }),
    ).resolves.toEqual(first);
    await expect(
      client.create(
        { ...input, taskId: `${input.taskId}-still-full` },
        { scenario: 'success', idempotencyKey: 'capacity-still-full' },
      ),
    ).rejects.toMatchObject({ code: 'MOCK_CAPACITY_EXCEEDED', status: 503 });
    expect(server.getDiagnostics()).toMatchObject({
      retainedTasks: 1,
      retainedIdempotencyRecords: 1,
    });
    await server.close();
    expect(server.getDiagnostics()).toMatchObject({
      retainedTasks: 0,
      retainedIdempotencyRecords: 0,
    });
  });
});

describe('strict callback and adapter conformance', () => {
  it('accepts case-insensitive identity headers and rejects signed schema/header mismatches', async () => {
    const { server, client, callbacks } = await setup();
    const verifier = new MockProviderClient({ baseUrl: server.url, callbackSecret: TEST_SECRET });
    const created = await client.create(input, {
      scenario: 'success',
      idempotencyKey: 'strict-callback',
    });
    await client.get(created.providerTaskId);
    const callback = callbacks[0];
    if (callback === undefined) throw new Error('EXPECTED_CALLBACK');

    await expect(
      verifier.verifyCallback({
        headers: Object.fromEntries(
          Object.entries(callback.headers).map(([name, value]) => [name.toUpperCase(), value]),
        ),
        rawBody: callback.rawBody,
      }),
    ).resolves.toMatchObject({ valid: true });

    const invalidPayloads = [
      { ...callback.body, occurredAt: 'not-a-time' },
      { ...callback.body, occurredAt: '2023-02-29T00:00:00.000Z' },
      { ...callback.body, sequence: 0 },
      { ...callback.body, state: 'SUCCEEDED', resultUrls: undefined },
      { ...callback.body, state: 'FAILED', errorCode: 'X', errorMessage: undefined },
    ];
    for (const payload of invalidPayloads) {
      const rawBody = Buffer.from(JSON.stringify(payload));
      const signature = createHmac('sha256', TEST_SECRET).update(rawBody).digest('hex');
      await expect(
        verifier.verifyCallback({
          headers: {
            'x-mock-signature': `sha256=${signature}`,
            'x-provider-event-id': callback.body.eventId,
            'x-provider-sequence': String(callback.body.sequence),
          },
          rawBody,
        }),
      ).resolves.toEqual({ valid: false, payload: null });
    }
    await expect(
      verifier.verifyCallback({
        headers: { ...callback.headers, 'x-provider-event-id': 'evt_wrong' },
        rawBody: callback.rawBody,
      }),
    ).resolves.toEqual({ valid: false, payload: null });

    await expect(
      verifier.verifyCallback({
        headers: {
          'X-Mock-Signature': 'sha256=invalid',
          ...callback.headers,
        },
        rawBody: callback.rawBody,
      }),
    ).resolves.toEqual({ valid: false, payload: null });
  });

  it('passes the frozen SDK runner only through the explicit secure conformance wrapper', async () => {
    const { server } = await setup();
    const client = new MockProviderClient({
      baseUrl: server.url,
      callbackSecret: TEST_SECRET,
    });

    await expect(
      runAdapterConformance(createMockProviderConformanceAdapter(client, TEST_SECRET)),
    ).resolves.toEqual([]);
    await expect(client.verifyCallback({ headers: {}, body: {} })).resolves.toEqual({
      valid: false,
      payload: null,
    });
  });

  it('returns useful configuration issues for malformed or unsafe base URLs', async () => {
    await expect(
      new MockProviderClient({ baseUrl: 'not-a-url' }).validateConfiguration(),
    ).resolves.toEqual({ valid: false, issues: ['baseUrl must be a valid absolute URL'] });
    await expect(
      new MockProviderClient({ baseUrl: 'file:///tmp/mock' }).validateConfiguration(),
    ).resolves.toEqual({ valid: false, issues: ['baseUrl must use http or https'] });
  });
});

describe('transport hardening', () => {
  it('returns stable client errors for oversized payloads and malformed encoded paths', async () => {
    const { server } = await setup();
    const oversized = await fetch(`${server.url}/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'oversized',
        'x-mock-scenario': 'success',
      },
      body: JSON.stringify({ ...input, parameters: { prompt: 'x'.repeat(70_000) } }),
    });
    const malformedPath = await fetch(`${server.url}/tasks/%E0%A4%A`);

    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });
    expect(malformedPath.status).toBe(400);
    await expect(malformedPath.json()).resolves.toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('rejects duplicate idempotency headers and bodies on bodyless routes', async () => {
    const { server, client } = await setup();
    const duplicateStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${server.url}/tasks`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-idempotency-key': ['duplicate-a', 'duplicate-b'],
            'x-mock-scenario': 'success',
          },
        },
        (response) => {
          response.resume();
          response.once('end', () => {
            resolve(response.statusCode ?? 0);
          });
        },
      );
      request.once('error', reject);
      request.end(JSON.stringify(input));
    });
    const created = await client.create(input, {
      scenario: 'success',
      idempotencyKey: 'bodyless-route',
    });
    const cancelWithBody = await fetch(`${server.url}/tasks/${created.providerTaskId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(duplicateStatus).toBe(400);
    expect(cancelWithBody.status).toBe(400);
  });

  it('preserves the HTTP status when a provider response is not JSON', async () => {
    const httpServer = createHttpServer((_request, response) => {
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('upstream exploded');
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('EXPECTED_TCP_ADDRESS');
    const client = new MockProviderClient({ baseUrl: `http://127.0.0.1:${String(address.port)}` });

    await expect(client.getBalance()).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      status: 502,
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  });
});
