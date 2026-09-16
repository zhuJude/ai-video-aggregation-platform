import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockProviderServer, type MockProviderServer } from '../src/server.js';
import { createCallbackDelivery } from '../src/callback.js';
import { createHttpCallbackDelivery, loadMockProviderRuntimeConfig } from '../src/main.js';

const openServers: MockProviderServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => server.close()));
});

describe('mock provider production runtime', () => {
  it('exposes live, ready and Prometheus endpoints without secret material', async () => {
    const server = await createMockProviderServer({
      callbackSecret: 'never-render-this-secret',
      deliverCallback: () => Promise.resolve(),
    });
    await server.listen();
    openServers.push(server);

    const live = await fetch(`${server.url}/health/live`);
    const ready = await fetch(`${server.url}/health/ready`);
    const metrics = await fetch(`${server.url}/metrics`);

    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toEqual({ status: 'ok' });
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({
      status: 'ready',
      checks: { callback_signing_key: true, callback_target: true },
    });
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    const body = await metrics.text();
    expect(body).toContain('# TYPE mock_provider_callback_attempts_total counter');
    expect(body).toContain('mock_provider_callback_attempts_total 0');
    expect(body).not.toContain('never-render-this-secret');
  });

  it('reports not ready when callback delivery is not configured', async () => {
    const server = await createMockProviderServer({ callbackSecret: 'secret' });
    await server.listen();
    openServers.push(server);

    const ready = await fetch(`${server.url}/health/ready`);
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toMatchObject({
      status: 'not_ready',
      checks: { callback_target: false },
    });
  });

  it('requires a safe callback target in the executable runtime', () => {
    expect(() => loadMockProviderRuntimeConfig({})).toThrow('MOCK_CALLBACK_TARGET_REQUIRED');
    expect(() =>
      loadMockProviderRuntimeConfig({ MOCK_PROVIDER_CALLBACK_URL: 'http://user:pass@callback/x' }),
    ).toThrow('INVALID_MOCK_CALLBACK_TARGET');
    expect(
      loadMockProviderRuntimeConfig({
        MOCK_PROVIDER_CALLBACK_URL: 'http://provider-runtime/callbacks/mock',
      }),
    ).toMatchObject({ callbackUrl: new URL('http://provider-runtime/callbacks/mock') });
  });

  it('delivers exact signed raw bytes for duplicate and out-of-order callbacks', async () => {
    const received: Array<{
      body: Buffer;
      sequence: string | undefined;
      signature: string | undefined;
    }> = [];
    const receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          body: Buffer.concat(chunks),
          sequence: request.headers['x-provider-sequence'] as string | undefined,
          signature: request.headers['x-mock-signature'] as string | undefined,
        });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const address = receiver.address() as AddressInfo;
    const deliver = createHttpCallbackDelivery(
      new URL(`http://127.0.0.1:${String(address.port)}/callbacks/mock`),
      500,
    );
    const terminal = createCallbackDelivery(
      'secret',
      {
        providerTaskId: 'mock-task',
        scenario: 'callback-out-of-order',
        state: 'SUCCEEDED',
        resultUrls: ['mock://result'],
      },
      2,
    );
    const running = createCallbackDelivery(
      'secret',
      { providerTaskId: 'mock-task', scenario: 'callback-out-of-order', state: 'RUNNING' },
      1,
    );
    try {
      const context = { signal: new AbortController().signal };
      await deliver(terminal, context);
      await deliver(running, context);
      await deliver(running, context);
      expect(received.map(({ sequence }) => sequence)).toEqual(['2', '1', '1']);
      expect(received[0]?.body).toEqual(terminal.rawBody);
      expect(received[1]?.body).toEqual(running.rawBody);
      expect(received[1]?.signature).toBe(running.headers['x-mock-signature']);
    } finally {
      await new Promise<void>((resolve, reject) => {
        receiver.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
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
    expect(dockerfile).not.toMatch(/CALLBACK_SECRET=|TOKEN=/);
    expect(dockerignore).toContain('**/node_modules');
    expect(dockerignore).toContain('**/dist');
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { files?: string[] };
    expect(manifest.files).toEqual(['dist', 'package.json']);
  });
});
